import type { Endpoint, Payload, PayloadRequest } from 'payload'

import config from '@payload-config'
import { createPayloadRequest, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { buildEndpoints } from '../src/endpoints/index.js'
import { resolveOptions } from '../src/index.js'
import { tryAcquireLock } from '../src/lib/locks.js'
import { upsertObservations, upsertOptionsFrom } from '../src/lib/registry.js'
import { runScan, ScanInProgressError } from '../src/lib/scan.js'
import { invalidateSettingsCache } from '../src/lib/settings.js'
import { GTM_JS_FIXTURE } from '../test/fixtures/gtmContainer.js'

let payload: Payload
let endpoints: Endpoint[]
let ipCounter = 0

const endpoint = (method: string, path: string) => {
  const e = endpoints.find((x) => x.method === method && x.path === path)
  if (!e) {
    throw new Error(`endpoint ${method} ${path} not registered`)
  }
  return e.handler
}

const request = async (
  method: string,
  path: string,
  {
    body,
    headers = {},
    user,
  }: { body?: unknown; headers?: Record<string, string>; user?: unknown } = {},
) => {
  const req = new Request(`http://localhost:3000/api${path}`, {
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      'content-type': 'text/plain',
      'x-forwarded-for': `10.0.0.${++ipCounter}`,
      ...headers,
    },
    method: method.toUpperCase(),
  })
  const payloadReq = (await createPayloadRequest({
    config,
    request: req,
  })) as PayloadRequest
  if (user) {
    payloadReq.user = user as PayloadRequest['user']
  }
  return endpoint(method, path)(payloadReq)
}

const findEvent = async (name: string) => {
  const { docs } = await payload.find({
    collection: 'gtm-events' as never,
    overrideAccess: true,
    where: { eventName: { equals: name } },
  })
  return docs[0] as unknown as Record<string, any> | undefined
}

const setSettings = async (data: Record<string, unknown>) => {
  await payload.updateGlobal({
    slug: 'gtm-settings' as never,
    data: data as never,
    overrideAccess: true,
  })
  invalidateSettingsCache()
}

beforeAll(async () => {
  payload = await getPayload({ config })
  endpoints = payload.config.endpoints as Endpoint[]
  await setSettings({ containerId: 'GTM-TEST123' })
})

afterAll(async () => {
  await payload?.destroy?.()
})

describe('plugin registration', () => {
  test('adds collection, global, endpoints and job task', () => {
    expect(payload.collections['gtm-events' as never]).toBeDefined()
    expect(payload.config.globals.find((g) => g.slug === 'gtm-settings')).toBeDefined()
    const paths = endpoints.map((e) => `${e.method} ${e.path}`)
    expect(paths).toEqual(
      expect.arrayContaining([
        'get /gtm/config',
        'post /gtm/collect',
        'post /gtm/scan',
        'get /gtm/export',
      ]),
    )
    expect(payload.config.jobs.tasks?.some((t) => t.slug === 'gtmScan')).toBe(true)
  })
})

describe('GET /gtm/config', () => {
  test('returns public config with discovery endpoint', async () => {
    const res = await request('get', '/gtm/config')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      containerId: 'GTM-TEST123',
      dataLayerName: 'dataLayer',
      discovery: { enabled: true, endpoint: '/api/gtm/collect', sampleRate: 1 },
      enabled: true,
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(body.analytics).toBeUndefined()
  })

  test('includes GA4 settings when a measurement ID is set', async () => {
    await setSettings({ analytics: { debugMode: true, measurementId: 'G-TEST12345' } })
    try {
      const body = await (await request('get', '/gtm/config')).json()
      expect(body.analytics).toEqual({
        debugMode: true,
        measurementId: 'G-TEST12345',
        sendPageView: true,
      })
      expect(body.containerId).toBe('GTM-TEST123')
    } finally {
      await setSettings({ analytics: { debugMode: false, measurementId: null } })
    }
  })

  test('normalizes pasted IDs and exposes consent defaults when enabled', async () => {
    await setSettings({
      analytics: { measurementId: ' g-test12345 ' },
      consent: { adStorage: 'denied', analyticsStorage: 'denied', enabled: true, regions: ['de'] },
    })
    try {
      const saved = (await payload.findGlobal({ slug: 'gtm-settings' as never })) as any
      expect(saved.analytics.measurementId).toBe('G-TEST12345')
      const body = await (await request('get', '/gtm/config')).json()
      expect(body.consent).toEqual({
        regions: ['DE'],
        signals: {
          ad_personalization: 'denied',
          ad_storage: 'denied',
          ad_user_data: 'denied',
          analytics_storage: 'denied',
        },
        waitForUpdateMs: 500,
      })
    } finally {
      await setSettings({ analytics: { measurementId: null }, consent: { enabled: false } })
    }
    expect((await (await request('get', '/gtm/config')).json()).consent).toBeUndefined()
  })

  test('GA4 alone enables the runtime', async () => {
    await setSettings({ analytics: { measurementId: 'G-TEST12345' }, containerId: null })
    try {
      const body = await (await request('get', '/gtm/config')).json()
      expect(body).toMatchObject({ analytics: { measurementId: 'G-TEST12345' }, enabled: true })
      expect(body.containerId).toBeUndefined()
      expect(body.discovery.enabled).toBe(true)
    } finally {
      await setSettings({ analytics: { measurementId: null }, containerId: 'GTM-TEST123' })
    }
  })
})

describe('POST /gtm/collect', () => {
  test('creates and merges events from runtime observations', async () => {
    const res = await request('post', '/gtm/collect', {
      body: {
        events: [
          {
            name: 'add_to_cart',
            params: [
              { path: 'ecommerce.value', type: 'number' },
              { example: 'jane@example.com', path: 'user_email', type: 'string' },
            ],
          },
          { name: 'gtm.dom', params: [] },
        ],
        page: '/products/shirt?utm=x',
        v: 1,
      },
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: 1, skipped: 1 })

    const doc = await findEvent('add_to_cart')
    expect(doc).toMatchObject({
      eventName: 'add_to_cart',
      occurrences: 1,
      sources: ['runtime'],
      status: 'discovered',
    })
    expect(doc!.pages.map((p: any) => p.path)).toEqual(['/products/shirt'])
    // INV-04: no example values stored by default
    expect(doc!.parameters.every((p: any) => !p.example)).toBe(true)
    expect(await findEvent('gtm.dom')).toBeUndefined()

    // Second observation with a new param + page merges
    await request('post', '/gtm/collect', {
      body: {
        events: [{ name: 'add_to_cart', params: [{ path: 'ecommerce.currency', type: 'string' }] }],
        page: '/cart',
        v: 1,
      },
    })
    const merged = await findEvent('add_to_cart')
    expect(merged!.occurrences).toBe(2)
    expect(merged!.parameters.map((p: any) => p.path).sort()).toEqual([
      'ecommerce.currency',
      'ecommerce.value',
      'user_email',
    ])
    expect(merged!.pages.map((p: any) => p.path)).toEqual(['/products/shirt', '/cart'])
  })

  test('server dedupe window skips identical observations', async () => {
    const body = { events: [{ name: 'dedupe_me', params: [] }], page: '/a', v: 1 }
    await request('post', '/gtm/collect', { body })
    const res = await request('post', '/gtm/collect', { body })
    expect(await res.json()).toEqual({ accepted: 0, skipped: 1 })
    expect((await findEvent('dedupe_me'))!.occurrences).toBe(1)
  })

  test('preserves editor-owned fields and respects ignored status', async () => {
    const doc = await findEvent('add_to_cart')
    await payload.update({
      id: doc!.id,
      collection: 'gtm-events' as never,
      data: { description: 'Documented', status: 'ignored' } as never,
      overrideAccess: true,
    })
    await request('post', '/gtm/collect', {
      body: {
        events: [{ name: 'add_to_cart', params: [{ path: 'new_param', type: 'string' }] }],
        page: '/z',
        v: 1,
      },
    })
    const after = await findEvent('add_to_cart')
    expect(after!.description).toBe('Documented')
    expect(after!.parameters.some((p: any) => p.path === 'new_param')).toBe(false)

    const config = await (await request('get', '/gtm/config')).json()
    expect(config.discovery.ignore).toContain('add_to_cart')
  })

  test('rejects invalid input, oversize bodies and disallowed origins', async () => {
    expect((await request('post', '/gtm/collect', { body: 'not json' })).status).toBe(400)
    expect((await request('post', '/gtm/collect', { body: { events: [], v: 9 } })).status).toBe(400)
    expect((await request('post', '/gtm/collect', { body: 'x'.repeat(40 * 1024) })).status).toBe(
      413,
    )

    const res = await request('post', '/gtm/collect', {
      body: { events: [{ name: '<script>alert(1)</script>', params: [] }], v: 1 },
    })
    expect(await res.json()).toEqual({ accepted: 0, skipped: 1 })

    await setSettings({ discovery: { allowedOrigins: ['https://shop.example.com'] } })
    const blocked = await request('post', '/gtm/collect', {
      body: { events: [{ name: 'x_event', params: [] }], v: 1 },
      headers: { origin: 'https://evil.example' },
    })
    expect(blocked.status).toBe(403)
    const allowed = await request('post', '/gtm/collect', {
      body: { events: [{ name: 'x_event', params: [] }], v: 1 },
      headers: { origin: 'https://shop.example.com' },
    })
    expect(allowed.status).toBe(202)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://shop.example.com')
    await setSettings({ discovery: { allowedOrigins: [] } })
  })

  test('rate limits per client IP', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 15; i++) {
      const res = await request('post', '/gtm/collect', {
        body: { events: [{ name: `rl_${i}`, params: [] }], v: 1 },
        headers: { 'x-forwarded-for': '192.168.1.1' },
      })
      statuses.push(res.status)
    }
    expect(statuses).toContain(429)
    expect(statuses.filter((s) => s === 202).length).toBe(10)
  })

  test('returns 503 when discovery is disabled', async () => {
    await setSettings({ discovery: { enabled: false } })
    const res = await request('post', '/gtm/collect', { body: { events: [], v: 1 } })
    expect(res.status).toBe(503)
    await setSettings({ discovery: { enabled: true } })
  })
})

describe('access control', () => {
  test('REST create is denied; anonymous reads are denied', async () => {
    await expect(
      payload.create({
        collection: 'gtm-events' as never,
        data: { eventName: 'forged' } as never,
        overrideAccess: false,
      }),
    ).rejects.toThrow()
    await expect(
      payload.find({ collection: 'gtm-events' as never, overrideAccess: false }),
    ).rejects.toThrow()
  })

  test('scan and export require authentication', async () => {
    expect((await request('post', '/gtm/scan', { body: {} })).status).toBe(401)
    expect((await request('get', '/gtm/export')).status).toBe(401)
  })
})

describe('scan', () => {
  test('container scan upserts triggers with fired tags and stores summary', async () => {
    const fetchImpl = (url: string) => {
      expect(url).toBe('https://www.googletagmanager.com/gtm.js?id=GTM-TEST123')
      return Promise.resolve(new Response(GTM_JS_FIXTURE, { status: 200 }))
    }
    const summary = await runScan(payload, resolveOptions(), { container: true, fetchImpl })
    expect(summary.container).toMatchObject({
      found: 7,
      variables: ['ecommerce.value', 'form_id'],
      version: '42',
    })
    expect(summary.errors).toEqual([
      'container: regex trigger ".*_error$" could not be expanded to event names',
    ])

    const purchase = await findEvent('purchase')
    expect(purchase).toMatchObject({ matchType: 'exact', occurrences: 0, sources: ['container'] })
    expect(purchase!.firesTags.map((t: any) => t.ga4EventName ?? t.tagType)).toEqual([
      'purchase',
      'awct',
    ])
    expect((await findEvent('form_'))!.matchType).toBe('startsWith')
    expect(await findEvent('gtm.js')).toBeUndefined() // built-ins excluded by default

    const settings = (await payload.findGlobal({
      slug: 'gtm-settings' as never,
      overrideAccess: true,
    })) as any
    expect(settings.lastScan.container.found).toBe(7)
  })

  test('container 404 is reported, registry unchanged', async () => {
    const before = await payload.count({ collection: 'gtm-events' as never, overrideAccess: true })
    const summary = await runScan(payload, resolveOptions(), {
      container: true,
      fetchImpl: () => Promise.resolve(new Response('', { status: 404 })),
    })
    expect(summary.errors[0]).toMatch(/not found or not published/)
    const after = await payload.count({ collection: 'gtm-events' as never, overrideAccess: true })
    expect(after.totalDocs).toBe(before.totalDocs)
  })

  test('crawl discovers same-origin dataLayer pushes', async () => {
    await setSettings({ crawl: { siteUrl: 'https://site.test', useSitemap: true } })
    const pages: Record<string, string> = {
      'https://site.test/':
        '<html><script>dataLayer.push({event:"hero_cta_click"})</script><script src="/app.js"></script><script src="https://cdn.evil/x.js"></script></html>',
      'https://site.test/app.js':
        'window.dataLayer.push({"event":"search_submit",q:1});gtag("event","share")',
      'https://site.test/pricing': '<script>dataLayer.push({ event: "plan_selected" })</script>',
      'https://site.test/sitemap.xml':
        '<urlset><url><loc>https://site.test/pricing</loc></url><url><loc>https://other.test/x</loc></url></urlset>',
    }
    const fetched: string[] = []
    const fetchImpl = (url: string) => {
      fetched.push(url)
      const body = pages[url]
      return Promise.resolve(new Response(body ?? 'nf', { status: body ? 200 : 404 }))
    }
    const summary = await runScan(payload, resolveOptions(), {
      container: false,
      crawl: true,
      fetchImpl,
    })
    expect(summary.crawl).toMatchObject({ found: 4, pages: 2 })
    expect(fetched.some((u) => u.includes('evil') || u.includes('other.test'))).toBe(false)
    const plan = await findEvent('plan_selected')
    expect(plan).toMatchObject({ sources: ['crawl'] })
    expect(plan!.pages.map((p: any) => p.path)).toEqual(['/pricing'])
    expect(await findEvent('search_submit')).toBeDefined()
  })

  test('users of non-admin auth collections are refused by default (P1)', async () => {
    const customer = { id: 1, collection: 'customers' }
    expect((await request('post', '/gtm/scan', { body: {}, user: customer })).status).toBe(403)
    expect((await request('get', '/gtm/export', { user: customer })).status).toBe(403)
    await expect(
      payload.updateGlobal({
        slug: 'gtm-settings' as never,
        data: { containerId: 'GTM-EVIL999' } as never,
        overrideAccess: false,
        user: customer as never,
      }),
    ).rejects.toThrow()
    await expect(
      payload.find({
        collection: 'gtm-events' as never,
        overrideAccess: false,
        user: customer as never,
      }),
    ).rejects.toThrow()
    const admin = { id: 1, collection: 'users' }
    const ok = await payload.findGlobal({
      slug: 'gtm-settings' as never,
      overrideAccess: false,
      user: admin as never,
    })
    expect((ok as any).containerId).toBe('GTM-TEST123')
  })

  test('collect rejects an oversized chunked body without buffering it (P3)', async () => {
    const big = new TextEncoder().encode('x'.repeat(16 * 1024))
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        if (pulled > 100) {
          controller.close() // 1.6 MB total if fully read
        } else {
          controller.enqueue(big)
        }
      },
    })
    const req = new Request('http://localhost:3000/api/gtm/collect', {
      body: stream,
      // @ts-expect-error Node needs duplex for streaming request bodies
      duplex: 'half',
      headers: { 'content-type': 'text/plain', 'x-forwarded-for': '10.9.9.9' },
      method: 'POST',
    })
    const payloadReq = (await createPayloadRequest({ config, request: req })) as PayloadRequest
    const res = await endpoint('post', '/gtm/collect')(payloadReq)
    expect(res.status).toBe(413)
    expect(pulled).toBeLessThan(10)
  })

  test('export returns a tracking plan for authenticated users', async () => {
    const res = await request('get', '/gtm/export', { user: { id: 1, collection: 'users' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.containerId).toBe('GTM-TEST123')
    const names = body.events.map((e: any) => e.eventName)
    expect(names).toEqual([...names].sort())
    expect(names).toEqual(expect.arrayContaining(['add_to_cart', 'purchase', 'plan_selected']))
    expect(body.events[0].parameters.every((p: any) => !('id' in p))).toBe(true)
  })
})

describe('multi-instance safety', () => {
  const options = resolveOptions()

  test('database lease: second holder is refused, release frees it, stale lease is taken over', async () => {
    const release = await tryAcquireLock(payload, options.lockSlug, 'test-key', 60_000)
    expect(release).not.toBeNull()
    expect(await tryAcquireLock(payload, options.lockSlug, 'test-key', 60_000)).toBeNull()
    await release!()
    const again = await tryAcquireLock(payload, options.lockSlug, 'test-key', 60_000)
    expect(again).not.toBeNull()
    await again!()

    // A crashed holder (expired lease) does not block forever.
    await tryAcquireLock(payload, options.lockSlug, 'stale-key', -1_000)
    const takeover = await tryAcquireLock(payload, options.lockSlug, 'stale-key', 60_000)
    expect(takeover).not.toBeNull()
    await takeover!()
  })

  test('a scan holding the lease on another instance blocks this one', async () => {
    const release = await tryAcquireLock(payload, options.lockSlug, 'scan', 60_000)
    await expect(
      runScan(payload, options, {
        container: true,
        fetchImpl: () => Promise.resolve(new Response('', { status: 404 })),
      }),
    ).rejects.toBeInstanceOf(ScanInProgressError)
    await release!()
    const summary = await runScan(payload, options, {
      container: true,
      fetchImpl: () => Promise.resolve(new Response('', { status: 404 })),
    })
    expect(summary.errors[0]).toMatch(/not found/)
  })

  test('concurrent merges into one event lose no parameters or pages', async () => {
    const opts = upsertOptionsFrom(options)
    await upsertObservations(payload, opts, [{ name: 'race_event', params: [], source: 'runtime' }])
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        upsertObservations(payload, opts, [
          {
            name: 'race_event',
            page: `/p${i}`,
            params: [{ path: `param_${i}`, type: 'string' }],
            source: 'runtime',
          },
        ]),
      ),
    )
    const doc = await findEvent('race_event')
    expect(doc!.parameters.map((p: any) => p.path).sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `param_${i}`).sort(),
    )
    expect(doc!.pages).toHaveLength(12)
    expect(doc!.occurrences).toBe(13)
    const locks = await payload.count({
      collection: options.lockSlug as never,
      overrideAccess: true,
    })
    expect(locks.totalDocs).toBe(0) // every lease released
  })

  test('observations that add nothing new are counted without a write, then flushed', async () => {
    const opts = upsertOptionsFrom(options)
    const obs = {
      name: 'quiet_event',
      params: [{ path: 'a', type: 'string' as const }],
      source: 'runtime' as const,
    }
    await upsertObservations(payload, opts, [obs])
    const first = await findEvent('quiet_event')
    await upsertObservations(payload, opts, [obs])
    await upsertObservations(payload, opts, [obs])
    const unchanged = await findEvent('quiet_event')
    expect(unchanged!.updatedAt).toBe(first!.updatedAt)
    expect(unchanged!.occurrences).toBe(1)

    // Something new arrives: written at once, including the two pending sightings.
    await upsertObservations(payload, opts, [{ ...obs, params: [{ path: 'b', type: 'number' }] }])
    expect((await findEvent('quiet_event'))!.occurrences).toBe(4)
  })

  test('hourly cap on new names from runtime discovery, container exempt', async () => {
    const created = await payload.count({
      collection: 'gtm-events' as never,
      overrideAccess: true,
      where: { firstSeenAt: { greater_than: new Date(Date.now() - 3_600_000).toISOString() } },
    })
    const opts = { ...upsertOptionsFrom(options), maxNewEventsPerHour: created.totalDocs + 1 }
    const res = await upsertObservations(payload, opts, [
      { name: 'cap_a', params: [], source: 'runtime' },
      { name: 'cap_b', params: [], source: 'runtime' },
      { name: 'cap_c', params: [], source: 'container' },
    ])
    expect(res).toMatchObject({ created: 2, dropped: 1 })
    expect(await findEvent('cap_b')).toBeUndefined()
    expect(await findEvent('cap_c')).toBeDefined()
  })

  test('client IP uses the proxy-added x-forwarded-for entry, not the spoofable first one', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 15; i++) {
      const res = await request('post', '/gtm/collect', {
        body: { events: [{ name: `spoof_${i}`, params: [] }], v: 1 },
        headers: { 'x-forwarded-for': `1.2.3.${i}, 172.16.0.9` },
      })
      statuses.push(res.status)
    }
    expect(statuses).toContain(429)
  })

  test('a custom shared rate limiter replaces the in-memory one', async () => {
    const keys: string[] = []
    const custom = buildEndpoints(
      resolveOptions({
        discovery: {
          getClientIp: () => 'visitor-1',
          rateLimiter: {
            take: (key) => {
              keys.push(key)
              return false
            },
          },
        },
      }),
    ).find((e) => e.method === 'post' && e.path === '/gtm/collect')!
    const req = (await createPayloadRequest({
      config,
      request: new Request('http://localhost:3000/api/gtm/collect', {
        body: JSON.stringify({ events: [], v: 1 }),
        method: 'POST',
      }),
    })) as PayloadRequest
    const res = await custom.handler(req)
    expect(res.status).toBe(429)
    expect(keys).toEqual(['visitor-1'])
  })
})
