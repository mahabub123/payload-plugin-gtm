import type { Payload } from 'payload'

import type { ConsentState } from '../browser/index.js'
import type { GtmRuntimeSettings, ResolvedGtmPluginOptions } from '../types.js'

import { CONTAINER_ID_RE, MEASUREMENT_ID_RE, REGION_RE, validTagId } from '../shared/ids.js'

/** Anything but an explicit 'granted' is treated as denied (fail closed). */
const consentState = (value: unknown): ConsentState => (value === 'granted' ? 'granted' : 'denied')

let cache: { expires: number; value: GtmRuntimeSettings } | null = null

/** Called from the global's afterChange hook (invalidates this instance only). */
export const invalidateSettingsCache = () => {
  cache = null
}

type SettingsDoc = {
  analytics?: {
    debugMode?: boolean | null
    measurementId?: null | string
    sendPageView?: boolean | null
  }
  consent?: {
    adPersonalization?: ConsentState | null
    adStorage?: ConsentState | null
    adUserData?: ConsentState | null
    analyticsStorage?: ConsentState | null
    enabled?: boolean | null
    regions?: null | string[]
    waitForUpdateMs?: null | number
  }
  containerId?: null | string
  crawl?: { siteUrl?: null | string; urls?: null | string[]; useSitemap?: boolean | null }
  dataLayerName?: null | string
  discovery?: {
    allowedOrigins?: null | string[]
    captureExamples?: boolean | null
    enabled?: boolean | null
    includeBuiltInEvents?: boolean | null
    sampleRate?: null | number
  }
  enabled?: boolean | null
  environment?: { auth?: null | string; preview?: null | string }
}

export const resolveSettings = (
  doc: null | SettingsDoc | undefined,
  options: ResolvedGtmPluginOptions,
): GtmRuntimeSettings => {
  const d = doc ?? {}
  const sampleRate = d.discovery?.sampleRate
  const wait = d.consent?.waitForUpdateMs
  return {
    analytics: {
      debugMode: d.analytics?.debugMode ?? false,
      // Re-validated here so a bad ID in the DB is never sent to browsers.
      measurementId:
        validTagId(d.analytics?.measurementId, MEASUREMENT_ID_RE) ??
        validTagId(options.measurementId, MEASUREMENT_ID_RE),
      sendPageView: d.analytics?.sendPageView ?? true,
    },
    consent: {
      enabled: d.consent?.enabled ?? false,
      regions: (d.consent?.regions ?? [])
        .map((r) => r.trim().toUpperCase())
        .filter((r) => REGION_RE.test(r)),
      signals: {
        ad_personalization: consentState(d.consent?.adPersonalization),
        ad_storage: consentState(d.consent?.adStorage),
        ad_user_data: consentState(d.consent?.adUserData),
        analytics_storage: consentState(d.consent?.analyticsStorage),
      },
      waitForUpdateMs:
        typeof wait === 'number' && Number.isInteger(wait) && wait >= 0 && wait <= 10_000
          ? wait
          : 500,
    },
    containerId:
      validTagId(d.containerId, CONTAINER_ID_RE) ??
      validTagId(options.containerId, CONTAINER_ID_RE),
    crawl: {
      siteUrl: d.crawl?.siteUrl || undefined,
      urls: d.crawl?.urls ?? [],
      useSitemap: d.crawl?.useSitemap ?? true,
    },
    dataLayerName: d.dataLayerName || 'dataLayer',
    discovery: {
      allowedOrigins: (d.discovery?.allowedOrigins ?? []).map((o) => o.replace(/\/+$/, '')),
      captureExamples: d.discovery?.captureExamples ?? false,
      enabled: d.discovery?.enabled ?? true,
      includeBuiltInEvents: d.discovery?.includeBuiltInEvents ?? false,
      sampleRate:
        typeof sampleRate === 'number' && sampleRate >= 0 && sampleRate <= 1 ? sampleRate : 1,
    },
    enabled: d.enabled ?? true,
    environment:
      d.environment?.auth && d.environment?.preview
        ? { auth: d.environment.auth, preview: d.environment.preview }
        : undefined,
  }
}

export const getSettings = async (
  payload: Payload,
  options: ResolvedGtmPluginOptions,
): Promise<GtmRuntimeSettings> => {
  const now = Date.now()
  if (cache && cache.expires > now) {
    return cache.value
  }
  const doc = (await payload.findGlobal({
    slug: options.globalSlug as never,
    depth: 0,
    overrideAccess: true,
  })) as unknown as SettingsDoc
  const value = resolveSettings(doc, options)
  cache = { expires: now + options.cacheSeconds * 1000, value }
  return value
}
