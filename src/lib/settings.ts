import type { Payload } from 'payload'

import type { GtmRuntimeSettings, ResolvedGtmPluginOptions } from '../types.js'

let cache: { expires: number; value: GtmRuntimeSettings } | null = null

/** Called from the global's afterChange hook (invalidates this instance only). */
export const invalidateSettingsCache = () => {
  cache = null
}

type SettingsDoc = {
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
  return {
    containerId: d.containerId || options.containerId || undefined,
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
