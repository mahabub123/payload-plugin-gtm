import type { Endpoint, PayloadHandler, PayloadRequest } from 'payload'

import type { Observation } from '../lib/registry.js'
import type { ResolvedGtmPluginOptions } from '../types.js'

import { buildPublicConfig } from '../lib/publicConfig.js'
import { createRateLimiter, createTtlSet } from '../lib/rateLimit.js'
import { upsertObservations, upsertOptionsFrom } from '../lib/registry.js'
import { runScan, ScanInProgressError } from '../lib/scan.js'
import { getSettings } from '../lib/settings.js'
import { BUILT_IN_EVENT_RE, eventSignature, LIMITS, sanitizeBatch } from '../shared/normalize.js'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { headers, status })

/**
 * Default client key for rate limiting. The FIRST x-forwarded-for entry is whatever the
 * client sent, so trusting it lets anyone dodge the limit with a fake header; the LAST
 * entry is the address your own proxy saw.
 */
export const defaultClientIp = (req: PayloadRequest): string => {
  const h = req.headers
  const direct = h?.get('cf-connecting-ip') ?? h?.get('x-real-ip')
  if (direct) {
    return direct.trim()
  }
  const forwarded = h
    ?.get('x-forwarded-for')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return forwarded?.length ? forwarded[forwarded.length - 1] : 'unknown'
}

const serverOrigin = (req: PayloadRequest): null | string => {
  const url = req.payload.config.serverURL
  if (!url) {
    return null
  }
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Origin policy for the public collect endpoint:
 *  - explicit allow-list from settings wins
 *  - otherwise only the Payload serverURL origin (if configured)
 *  - otherwise any origin
 * Requests without an Origin header (non-browser) fall through to rate limiting.
 */
export const isOriginAllowed = (
  origin: null | string,
  allowedOrigins: string[],
  fallbackOrigin: null | string,
): boolean => {
  if (!origin) {
    return true
  }
  if (allowedOrigins.length) {
    return allowedOrigins.includes(origin)
  }
  if (fallbackOrigin) {
    return origin === fallbackOrigin
  }
  return true
}

export const buildEndpoints = (options: ResolvedGtmPluginOptions): Endpoint[] => {
  const base = `/${options.basePath.replace(/^\/+|\/+$/g, '')}`
  const limiter = createRateLimiter({
    burst: Math.max(5, Math.ceil(options.discovery.rateLimitPerMinute / 3)),
    perMinute: options.discovery.rateLimitPerMinute,
  })
  const clientIp = options.discovery.getClientIp ?? defaultClientIp
  const rateLimiter = options.discovery.rateLimiter
  const recent = createTtlSet(options.discovery.dedupeWindowMs)
  const canScan = options.access.scan ?? (({ req }) => Boolean(req.user))

  const corsFor = (req: PayloadRequest): Record<string, string> => {
    const origin = req.headers?.get('origin')
    return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
  }

  /** GET /api/gtm/config — public runtime configuration for the website. */
  const configHandler: PayloadHandler = async (req) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    }
    try {
      return json(await buildPublicConfig(req.payload, options), 200, headers)
    } catch (err) {
      req.payload.logger.error(`[gtm] config endpoint failed: ${(err as Error).message}`)
      // Never break the site: report disabled.
      return json({ enabled: false }, 200, { 'Access-Control-Allow-Origin': '*' })
    }
  }

  /** POST /api/gtm/collect — public discovery beacon. */
  const collectHandler: PayloadHandler = async (req) => {
    const cors = corsFor(req)
    const settings = await getSettings(req.payload, options)
    if (!settings.enabled || !settings.discovery.enabled) {
      return json({ error: 'Discovery disabled' }, 503, cors)
    }

    if (
      !isOriginAllowed(
        req.headers?.get('origin') ?? null,
        settings.discovery.allowedOrigins,
        serverOrigin(req),
      )
    ) {
      return json({ error: 'Origin not allowed' }, 403)
    }

    let allowed: boolean
    try {
      const key = clientIp(req)
      allowed = rateLimiter ? await rateLimiter.take(key, req) : limiter.take(key)
    } catch (err) {
      // A broken shared limiter must not open the endpoint up: fall back to in-memory.
      req.payload.logger.warn(`[gtm] rate limiter failed: ${(err as Error).message}`)
      allowed = limiter.take(clientIp(req))
    }
    if (!allowed) {
      return json({ error: 'Too many requests' }, 429, { ...cors, 'Retry-After': '60' })
    }

    const declared = Number(req.headers?.get('content-length') ?? 0)
    if (declared > LIMITS.maxBodyBytes) {
      return json({ error: 'Payload too large' }, 413, cors)
    }

    let raw: unknown
    try {
      const text = (await req.text?.()) ?? ''
      if (text.length > LIMITS.maxBodyBytes) {
        return json({ error: 'Payload too large' }, 413, cors)
      }
      raw = JSON.parse(text)
    } catch {
      return json({ error: 'Invalid JSON' }, 400, cors)
    }

    const result = sanitizeBatch(raw, { captureExamples: settings.discovery.captureExamples })
    if (!result.ok) {
      return json({ error: result.error }, 400, cors)
    }

    const { events, page } = result.payload
    const observations: Observation[] = []
    let skipped = result.rejected
    for (const event of events) {
      if (!settings.discovery.includeBuiltInEvents && BUILT_IN_EVENT_RE.test(event.name)) {
        skipped++
        continue
      }
      const key = `${eventSignature(event)}@${page ?? ''}`
      if (recent.seenRecently(key)) {
        skipped++
        continue
      }
      observations.push({ name: event.name, page, params: event.params, source: 'runtime' })
    }

    try {
      const res = await upsertObservations(req.payload, upsertOptionsFrom(options), observations)
      return json(
        { accepted: res.created + res.updated, skipped: skipped + res.skipped + res.dropped },
        202,
        cors,
      )
    } catch (err) {
      // Allow these signatures to be retried by the next observation.
      for (const o of observations) {
        recent.forget(`${eventSignature(o)}@${page ?? ''}`)
      }
      req.payload.logger.error(`[gtm] collect failed: ${(err as Error).message}`)
      return json({ error: 'Internal error' }, 500, cors)
    }
  }

  const collectPreflight: PayloadHandler = (req) =>
    new Response(null, {
      headers: {
        ...corsFor(req),
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
      status: 204,
    })

  /** POST /api/gtm/scan — authenticated container scan / crawl. */
  const scanHandler: PayloadHandler = async (req) => {
    if (!(await canScan({ req }))) {
      return json({ error: 'Unauthorized' }, req.user ? 403 : 401)
    }
    let body: { container?: unknown; crawl?: unknown } = {}
    try {
      body = ((await req.json?.()) as typeof body) ?? {}
    } catch {
      // empty body is fine
    }
    try {
      const summary = await runScan(req.payload, options, {
        container: body.container !== false,
        crawl: body.crawl === true,
      })
      const failed = !summary.container && !summary.crawl && summary.errors.length > 0
      return json(summary, failed ? 502 : 200)
    } catch (err) {
      if (err instanceof ScanInProgressError) {
        return json({ error: err.message }, 409)
      }
      req.payload.logger.error(`[gtm] scan failed: ${(err as Error).message}`)
      return json({ error: 'Scan failed' }, 500)
    }
  }

  /** GET /api/gtm/export — tracking plan JSON. */
  const exportHandler: PayloadHandler = async (req) => {
    if (!(await canScan({ req }))) {
      return json({ error: 'Unauthorized' }, req.user ? 403 : 401)
    }
    const settings = await getSettings(req.payload, options)
    const { docs } = await req.payload.find({
      collection: options.collectionSlug as never,
      depth: 0,
      limit: 0,
      overrideAccess: true,
      pagination: false,
      sort: 'eventName',
    })
    const events = docs.map((raw) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = raw as unknown as Record<string, any>
      return {
        description: d.description ?? undefined,
        eventName: d.eventName,
        firesTags: (d.firesTags ?? []).map(({ id: _id, ...t }: Record<string, unknown>) => t),
        firstSeenAt: d.firstSeenAt,
        lastSeenAt: d.lastSeenAt,
        matchType: d.matchType,
        owner: d.owner ?? undefined,
        parameters: (d.parameters ?? []).map(({ id: _id, ...p }: Record<string, unknown>) => p),
        sources: d.sources ?? [],
        status: d.status,
      }
    })
    return json(
      {
        containerId: settings.containerId,
        events,
        generatedAt: new Date().toISOString(),
        version: 1,
      },
      200,
      { 'Content-Disposition': 'attachment; filename="tracking-plan.json"' },
    )
  }

  return [
    { handler: configHandler, method: 'get', path: `${base}/config` },
    { handler: collectHandler, method: 'post', path: `${base}/collect` },
    { handler: collectPreflight, method: 'options', path: `${base}/collect` },
    { handler: scanHandler, method: 'post', path: `${base}/scan` },
    { handler: exportHandler, method: 'get', path: `${base}/export` },
  ]
}
