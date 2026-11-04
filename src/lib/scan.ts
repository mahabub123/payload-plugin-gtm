import type { Payload } from 'payload'

import type { ResolvedGtmPluginOptions, ScanSummary } from '../types.js'
import type { FetchLike } from './crawler.js'
import type { Observation } from './registry.js'

import { BUILT_IN_EVENT_RE } from '../shared/normalize.js'
import { parseContainer } from './containerParser.js'
import { crawlSite, safeFetchText } from './crawler.js'
import { upsertObservations } from './registry.js'
import { getSettings, invalidateSettingsCache } from './settings.js'

export const GTM_ORIGIN = 'https://www.googletagmanager.com'

export const buildContainerUrl = (
  containerId: string,
  environment?: { auth: string; preview: string },
): string => {
  const url = new URL('/gtm.js', GTM_ORIGIN)
  url.searchParams.set('id', containerId)
  if (environment) {
    url.searchParams.set('gtm_auth', environment.auth)
    url.searchParams.set('gtm_preview', environment.preview)
    url.searchParams.set('gtm_cookies_win', 'x')
  }
  return url.toString()
}

let running: null | Promise<ScanSummary> = null

export class ScanInProgressError extends Error {
  constructor() {
    super('A scan is already running on this instance')
  }
}

export type ScanArgs = {
  container?: boolean
  crawl?: boolean
  fetchImpl?: FetchLike
}

/**
 * Runs a container scan and/or a crawl, upserts results and stores a summary on
 * the settings global. Single-flight per instance.
 */
export const runScan = (
  payload: Payload,
  options: ResolvedGtmPluginOptions,
  args: ScanArgs = {},
): Promise<ScanSummary> => {
  if (running) {
    throw new ScanInProgressError()
  }
  running = doScan(payload, options, args).finally(() => {
    running = null
  })
  return running
}

const doScan = async (
  payload: Payload,
  options: ResolvedGtmPluginOptions,
  { container = true, crawl = false, fetchImpl }: ScanArgs,
): Promise<ScanSummary> => {
  invalidateSettingsCache()
  const settings = await getSettings(payload, options)
  const summary: ScanSummary = { at: new Date().toISOString(), errors: [] }
  const includeBuiltIn = settings.discovery.includeBuiltInEvents
  const upsertOpts = {
    collectionSlug: options.collectionSlug,
    maxEvents: options.discovery.maxEvents,
  }

  if (container) {
    if (!settings.containerId) {
      summary.errors.push('container: no container ID configured')
    } else {
      try {
        const { status, text } = await safeFetchText(
          buildContainerUrl(settings.containerId, settings.environment),
          {
            allowedOrigin: GTM_ORIGIN,
            fetchImpl,
            maxBytes: 5 * 1024 * 1024,
            timeoutMs: options.crawl.timeoutMs,
          },
        )
        if (status !== 200) {
          throw new Error(
            status === 404
              ? `container ${settings.containerId} not found or not published (HTTP 404)`
              : `HTTP ${status}`,
          )
        }
        const parsed = parseContainer(text)
        const observations: Observation[] = parsed.events
          .filter((e) => includeBuiltIn || !BUILT_IN_EVENT_RE.test(e.name))
          .map((e) => ({
            name: e.name,
            firesTags: e.firesTags,
            matchType: e.matchType,
            params: [],
            source: 'container',
          }))
        const res = await upsertObservations(payload, upsertOpts, observations)
        summary.container = {
          created: res.created,
          found: observations.length,
          updated: res.updated,
          variables: parsed.variables,
          version: parsed.version,
        }
        if (parsed.patterns.length) {
          summary.errors.push(
            ...parsed.patterns.map(
              (p) =>
                `container: ${p.matchType} trigger "${p.pattern}" could not be expanded to event names`,
            ),
          )
        }
      } catch (err) {
        summary.errors.push(`container: ${(err as Error).message}`)
      }
    }
  }

  if (crawl) {
    if (!settings.crawl.siteUrl) {
      summary.errors.push('crawl: no site URL configured')
    } else {
      try {
        const result = await crawlSite({
          dataLayerName: settings.dataLayerName,
          extraUrls: settings.crawl.urls,
          fetchImpl,
          maxPages: options.crawl.maxPages,
          maxScripts: options.crawl.maxScripts,
          siteUrl: settings.crawl.siteUrl,
          timeoutMs: options.crawl.timeoutMs,
          useSitemap: settings.crawl.useSitemap,
        })
        const observations: Observation[] = []
        for (const [name, pages] of result.events) {
          if (!includeBuiltIn && BUILT_IN_EVENT_RE.test(name)) {
            continue
          }
          for (const page of pages.size ? pages : new Set([undefined])) {
            observations.push({ name, page, params: [], source: 'crawl' })
          }
        }
        const res = await upsertObservations(payload, upsertOpts, observations)
        summary.crawl = {
          created: res.created,
          found: result.events.size,
          pages: result.pages,
          updated: res.updated,
        }
        summary.errors.push(...result.errors.slice(0, 20).map((e) => `crawl: ${e}`))
      } catch (err) {
        summary.errors.push(`crawl: ${(err as Error).message}`)
      }
    }
  }

  await payload.updateGlobal({
    slug: options.globalSlug as never,
    data: { lastScan: summary } as never,
    depth: 0,
    overrideAccess: true,
  })
  invalidateSettingsCache()

  payload.logger.info(
    `[gtm] scan finished: container=${JSON.stringify(summary.container ?? null)} crawl=${JSON.stringify(
      summary.crawl ?? null,
    )} errors=${summary.errors.length}`,
  )
  return summary
}
