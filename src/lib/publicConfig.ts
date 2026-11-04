import type { Payload } from 'payload'

import type { PublicGtmConfig } from '../browser/index.js'
import type { ResolvedGtmPluginOptions } from '../types.js'

import { getSettings } from './settings.js'

let ignoreCache: { expires: number; names: string[] } | null = null

/** Ignored event names exposed to the browser so it stops reporting them (INV-03). */
const getIgnoredNames = async (payload: Payload, options: ResolvedGtmPluginOptions) => {
  const now = Date.now()
  if (ignoreCache && ignoreCache.expires > now) {
    return ignoreCache.names
  }
  const { docs } = await payload.find({
    collection: options.collectionSlug as never,
    depth: 0,
    limit: 500,
    overrideAccess: true,
    pagination: false,
    where: { status: { equals: 'ignored' } },
  })
  const names = docs.map((d) => (d as unknown as { eventName: string }).eventName)
  ignoreCache = { expires: now + options.cacheSeconds * 1000, names }
  return names
}

export const invalidateIgnoreCache = () => {
  ignoreCache = null
}

/** Public (safe-to-expose) runtime config consumed by the browser runtime. */
export const buildPublicConfig = async (
  payload: Payload,
  options: ResolvedGtmPluginOptions,
): Promise<PublicGtmConfig> => {
  const s = await getSettings(payload, options)
  const enabled = s.enabled && Boolean(s.containerId)
  const base = `/${options.basePath.replace(/^\/+|\/+$/g, '')}`
  return {
    containerId: enabled ? s.containerId : undefined,
    dataLayerName: s.dataLayerName,
    discovery: {
      captureExamples: s.discovery.captureExamples,
      enabled: enabled && s.discovery.enabled,
      endpoint: `${payload.config.routes.api}${base}/collect`,
      ignore: enabled && s.discovery.enabled ? await getIgnoredNames(payload, options) : [],
      includeBuiltInEvents: s.discovery.includeBuiltInEvents,
      sampleRate: s.discovery.sampleRate,
    },
    enabled,
    environment: enabled ? s.environment : undefined,
  }
}
