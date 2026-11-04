import type { Config, Payload, TaskConfig } from 'payload'

import type { PublicGtmConfig } from './browser/index.js'
import type { GtmPluginOptions, GtmRuntimeSettings, ResolvedGtmPluginOptions } from './types.js'

import { buildGtmEventsCollection } from './collections/gtmEvents.js'
import { buildGtmLocksCollection } from './collections/gtmLocks.js'
import { buildEndpoints } from './endpoints/index.js'
import { buildGtmSettingsGlobal } from './globals/gtmSettings.js'
import { buildPublicConfig } from './lib/publicConfig.js'
import { runScan, ScanInProgressError } from './lib/scan.js'
import { getSettings } from './lib/settings.js'

export type { PublicGtmConfig } from './browser/index.js'
export { expandSimpleRegex, parseContainer } from './lib/containerParser.js'
export { extractEventNames } from './lib/crawler.js'

export const resolveOptions = (options: GtmPluginOptions = {}): ResolvedGtmPluginOptions => ({
  access: options.access ?? {},
  adminGroup: options.adminGroup ?? 'Google Tag Manager',
  basePath: options.basePath ?? 'gtm',
  cacheSeconds: options.cacheSeconds ?? 30,
  collectionSlug: options.collectionSlug ?? 'gtm-events',
  containerId: options.containerId,
  crawl: {
    maxPages: options.crawl?.maxPages ?? 25,
    maxScripts: options.crawl?.maxScripts ?? 30,
    timeoutMs: options.crawl?.timeoutMs ?? 10_000,
  },
  disabled: options.disabled ?? false,
  discovery: {
    dedupeWindowMs: options.discovery?.dedupeWindowMs ?? 60_000,
    getClientIp: options.discovery?.getClientIp,
    maxEvents: options.discovery?.maxEvents ?? 500,
    maxNewEventsPerHour: options.discovery?.maxNewEventsPerHour ?? 100,
    rateLimiter: options.discovery?.rateLimiter,
    rateLimitPerMinute: options.discovery?.rateLimitPerMinute ?? 30,
    writeIntervalMs: options.discovery?.writeIntervalMs ?? 5 * 60_000,
  },
  globalSlug: options.globalSlug ?? 'gtm-settings',
  lockSlug: `${options.collectionSlug ?? 'gtm-events'}-locks`,
  overrideCollection: options.overrideCollection,
  overrideGlobal: options.overrideGlobal,
  scanQueue: options.scanQueue ?? 'default',
  scanSchedule: options.scanSchedule,
})

/** Remembered per Payload config so `getGtmSettings` can resolve slugs/defaults. */
const OPTIONS_KEY = 'payload-plugin-gtm'

/**
 * Payload CMS plugin: Google Tag Manager + automatic dataLayer event discovery.
 *
 * @example
 * plugins: [gtmPlugin({ containerId: 'GTM-ABC1234' })]
 */
export const gtmPlugin =
  (pluginOptions: GtmPluginOptions = {}) =>
  (incomingConfig: Config): Config => {
    const options = resolveOptions(pluginOptions)
    const config: Config = { ...incomingConfig }

    // Schema is always registered, even when disabled, so migrations stay stable.
    config.collections = [
      ...(config.collections ?? []),
      buildGtmEventsCollection(options),
      buildGtmLocksCollection(options.lockSlug),
    ]
    config.globals = [...(config.globals ?? []), buildGtmSettingsGlobal(options)]
    config.custom = { ...(config.custom ?? {}), [OPTIONS_KEY]: options }

    if (options.disabled) {
      return config
    }

    config.endpoints = [...(config.endpoints ?? []), ...buildEndpoints(options)]

    const scanTask: TaskConfig = {
      slug: 'gtmScan',
      handler: async ({ input, req }) => {
        let summary
        try {
          summary = await runScan(req.payload, options, {
            container: true,
            crawl: Boolean((input as { crawl?: boolean } | undefined)?.crawl),
          })
        } catch (err) {
          if (err instanceof ScanInProgressError) {
            // Another instance is already scanning: nothing to do, don't burn retries.
            req.payload.logger.info('[gtm] scheduled scan skipped: a scan is already running')
            return { output: { errors: 0, events: 0 } }
          }
          throw err
        }
        return {
          output: {
            errors: summary.errors.length,
            events: (summary.container?.found ?? 0) + (summary.crawl?.found ?? 0),
          },
        }
      },
      inputSchema: [{ name: 'crawl', type: 'checkbox' }],
      label: 'GTM: scan container & crawl site',
      outputSchema: [
        { name: 'events', type: 'number' },
        { name: 'errors', type: 'number' },
      ],
      retries: 2,
      ...(options.scanSchedule
        ? { schedule: [{ cron: options.scanSchedule, queue: options.scanQueue }] }
        : {}),
    }

    config.jobs = {
      ...(config.jobs ?? {}),
      tasks: [...(config.jobs?.tasks ?? []), scanTask],
    }

    const incomingOnInit = config.onInit
    config.onInit = async (payload) => {
      if (incomingOnInit) {
        await incomingOnInit(payload)
      }
      const settings = await getSettings(payload, options).catch(() => null)
      if (settings && !settings.containerId) {
        payload.logger.info(
          `[gtm] no container ID yet — set one in the "${options.globalSlug}" global or the plugin options`,
        )
      }
    }

    return config
  }

/**
 * Server-side helper for rendering the GTM snippet in a Payload-backed frontend
 * (e.g. a Next.js layout) without an extra HTTP round trip.
 */
const optionsFor = (payload: Payload): ResolvedGtmPluginOptions =>
  (payload.config.custom?.[OPTIONS_KEY] as ResolvedGtmPluginOptions | undefined) ?? resolveOptions()

/** Full runtime settings (server-only; includes crawl config). */
export const getGtmSettings = (payload: Payload): Promise<GtmRuntimeSettings> =>
  getSettings(payload, optionsFor(payload))

/**
 * Public config to pass to `<GoogleTagManager config={...} />` from a server component,
 * avoiding the client-side fetch of `/api/gtm/config`.
 */
export const getGtmPublicConfig = (payload: Payload): Promise<PublicGtmConfig> =>
  buildPublicConfig(payload, optionsFor(payload))

export type {
  GtmPluginOptions,
  GtmRateLimiter,
  GtmRuntimeSettings,
  ResolvedGtmPluginOptions,
  ScanSummary,
} from './types.js'

export default gtmPlugin
