import type { Access, CollectionConfig, GlobalConfig, PayloadRequest } from 'payload'

import type { ConsentSignals } from './browser/index.js'

export type GtmAccessFn = (args: { req: PayloadRequest }) => boolean | Promise<boolean>

/** Pluggable rate limiter for `POST /api/gtm/collect`. */
export type GtmRateLimiter = {
  take: (key: string, req: PayloadRequest) => boolean | Promise<boolean>
}

export type GtmPluginOptions = {
  /**
   * Access control overrides. Defaults: a logged-in user of the ADMIN user collection
   * (`config.admin.user`) can read, update, delete and scan; users of other auth
   * collections are refused. REST `create` on the events collection is always denied
   * (events are created by discovery only).
   *
   * SECURITY: whoever can update the settings global can load any GTM container — i.e.
   * run arbitrary JavaScript on your site. If your admin collection also holds
   * non-admin users (e.g. a `roles` field with `customer`), set `updateSettings`.
   * @example access: { updateSettings: ({ req }) => req.user?.roles?.includes('admin') }
   */
  access?: {
    delete?: Access
    read?: Access
    /** Who may trigger `POST /api/gtm/scan` and read `GET /api/gtm/export`. */
    scan?: GtmAccessFn
    update?: Access
    /** Who may update the settings global. */
    updateSettings?: Access
  }

  /** Admin sidebar group label. @default 'Google Tag Manager' */
  adminGroup?: string

  /**
   * Path segment under the API route for all plugin endpoints.
   * Change it if adblockers block `/api/gtm/*` on your site.
   * @default 'gtm'
   */
  basePath?: string

  /**
   * Seconds to cache the settings global in memory per instance.
   * @default 30
   */
  cacheSeconds?: number

  /** Slug of the event-registry collection. @default 'gtm-events' */
  collectionSlug?: string

  /**
   * Default GTM container ID (e.g. `GTM-ABC1234`). The value saved in the settings
   * global takes precedence.
   */
  containerId?: string

  /**
   * Same-origin crawl limits (static discovery of `dataLayer.push` literals).
   */
  crawl?: {
    /** @default 25 */
    maxPages?: number
    /** @default 30 */
    maxScripts?: number
    /** Per-request timeout in ms. @default 10000 */
    timeoutMs?: number
  }

  /**
   * Disable the plugin's runtime behavior (endpoints, admin components, job task).
   * The collection and global are still registered so the database schema stays stable.
   */
  disabled?: boolean

  /**
   * Runtime-discovery defaults; editable later in the settings global.
   */
  discovery?: {
    /** Server-side window in ms during which identical signatures skip DB writes. @default 60000 */
    dedupeWindowMs?: number
    /**
     * How the collect endpoint identifies a client for rate limiting. The default uses
     * `cf-connecting-ip`, then `x-real-ip`, then the LAST `x-forwarded-for` entry (the one
     * your own proxy added — the first entry is client-controlled and easy to spoof).
     * Override if your proxy setup differs.
     */
    getClientIp?: (req: PayloadRequest) => string
    /** Hard cap on distinct events in the registry. @default 500 */
    maxEvents?: number
    /**
     * Cap on NEW event names that runtime/crawl discovery may create per rolling hour,
     * counted in the database (so it holds across all instances). Container scans are
     * exempt. Limits how fast junk posted to the public endpoint can fill the registry.
     * @default 100
     */
    maxNewEventsPerHour?: number
    /**
     * Shared rate limiter for the collect endpoint. The built-in limiter is in-memory, so
     * on serverless or multi-instance deployments each instance counts separately; plug
     * in a shared store (Redis, Upstash, ...) here to enforce one limit everywhere.
     * Return `true` to allow the request.
     */
    rateLimiter?: GtmRateLimiter
    /** Requests per minute per client IP for the built-in limiter. @default 30 */
    rateLimitPerMinute?: number
    /**
     * Observations that add nothing new to an event are counted in memory and written at
     * most once per this interval (ms) per event, instead of on every page view.
     * @default 300000 (5 minutes)
     */
    writeIntervalMs?: number
  }

  /** Slug of the settings global. @default 'gtm-settings' */
  globalSlug?: string

  /**
   * Default Google Analytics 4 measurement ID (e.g. `G-ABC123XYZ9`), loaded directly with
   * gtag.js. The value saved in the settings global takes precedence. Works alongside a
   * GTM container or on its own. Do not also fire a GA4 tag for the same ID from inside
   * the GTM container, or page views will be counted twice.
   */
  measurementId?: string

  /** Customize the generated collection (add fields, hooks, tenant scoping...). */
  overrideCollection?: (collection: CollectionConfig) => CollectionConfig

  /** Customize the generated global. */
  overrideGlobal?: (global: GlobalConfig) => GlobalConfig

  /** Queue name for scheduled scans. @default 'default' */
  scanQueue?: string

  /**
   * Cron expression (Payload jobs syntax) to automatically queue a scan.
   * Requires the host app to run jobs (`jobs.autoRun` or a runner).
   * @example '0 3 * * *' // daily at 03:00
   */
  scanSchedule?: string
}

export type ResolvedGtmPluginOptions = {
  access: NonNullable<GtmPluginOptions['access']>
  adminGroup: string
  basePath: string
  cacheSeconds: number
  collectionSlug: string
  containerId?: string
  crawl: Required<NonNullable<GtmPluginOptions['crawl']>>
  disabled: boolean
  discovery: {
    dedupeWindowMs: number
    getClientIp?: (req: PayloadRequest) => string
    maxEvents: number
    maxNewEventsPerHour: number
    rateLimiter?: GtmRateLimiter
    rateLimitPerMinute: number
    writeIntervalMs: number
  }
  globalSlug: string
  /** Internal lease collection, `${collectionSlug}-locks`. */
  lockSlug: string
  measurementId?: string
  overrideCollection?: GtmPluginOptions['overrideCollection']
  overrideGlobal?: GtmPluginOptions['overrideGlobal']
  scanQueue: string
  scanSchedule?: string
}

/** Runtime settings: plugin defaults merged with the settings global. */
export type GtmRuntimeSettings = {
  analytics: {
    /** Send GA4 `debug_mode: true` (events show up in GA4 DebugView). */
    debugMode: boolean
    measurementId?: string
    /** Let `gtag('config')` send the initial page_view. */
    sendPageView: boolean
  }
  /** Google Consent Mode v2 defaults pushed before any Google tag loads. */
  consent: {
    enabled: boolean
    /** ISO region codes; empty = everywhere. */
    regions: string[]
    signals: Required<ConsentSignals>
    waitForUpdateMs: number
  }
  containerId?: string
  crawl: {
    siteUrl?: string
    urls: string[]
    useSitemap: boolean
  }
  dataLayerName: string
  discovery: {
    allowedOrigins: string[]
    captureExamples: boolean
    enabled: boolean
    includeBuiltInEvents: boolean
    sampleRate: number
  }
  enabled: boolean
  environment?: { auth: string; preview: string }
}

export type ScanSummary = {
  at: string
  container?: {
    created: number
    found: number
    updated: number
    variables: string[]
    version?: string
  }
  crawl?: {
    created: number
    found: number
    pages: number
    updated: number
  }
  errors: string[]
}
