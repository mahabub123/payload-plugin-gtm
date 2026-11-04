import type { Payload } from 'payload'

import type { ObservedParam, ParamType } from '../shared/normalize.js'
import type { ResolvedGtmPluginOptions } from '../types.js'

import { BUILT_IN_EVENT_RE, isValidEventName } from '../shared/normalize.js'
import { withLock } from './locks.js'

export type DiscoverySource = 'container' | 'crawl' | 'runtime'
export type MatchType = 'contains' | 'endsWith' | 'exact' | 'regex' | 'startsWith'

export type FiredTag = { ga4EventName?: string; tagId: string; tagType: string }

export type Observation = {
  firesTags?: FiredTag[]
  matchType?: MatchType
  name: string
  page?: string
  params: ObservedParam[]
  source: DiscoverySource
}

type ParamRow = {
  description?: null | string
  example?: null | string
  id?: null | string
  path: string
  types?: null | ParamType[]
}

export type EventDoc = {
  eventName: string
  firesTags?: ({ id?: null | string } & Partial<FiredTag>)[] | null
  firstSeenAt?: null | string
  id: number | string
  isBuiltIn?: boolean | null
  lastSeenAt?: null | string
  matchType?: MatchType | null
  occurrences?: null | number
  pages?: { id?: null | string; path?: null | string }[] | null
  parameters?: null | ParamRow[]
  sources?: DiscoverySource[] | null
  status?: 'approved' | 'deprecated' | 'discovered' | 'ignored' | null
}

export const MAX_PAGES = 25

const mergeParams = (existing: ParamRow[], incoming: ObservedParam[]): ParamRow[] => {
  const byPath = new Map<string, ParamRow>()
  for (const row of existing) {
    byPath.set(row.path, { ...row, types: [...(row.types ?? [])] })
  }
  for (const p of incoming) {
    const row = byPath.get(p.path)
    if (!row) {
      byPath.set(p.path, { example: p.example, path: p.path, types: [p.type] })
      continue
    }
    if (!row.types?.includes(p.type)) {
      row.types = [...(row.types ?? []), p.type]
    }
    if (!row.example && p.example) {
      row.example = p.example
    }
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Pure merge of an observation into an existing registry document.
 * Returns ONLY discovery-owned fields — editor-owned fields (status, description,
 * owner, notes, parameter descriptions) are never touched (INV-02).
 * `extraOccurrences` adds runtime sightings that were counted but not yet written.
 */
export const buildEventData = (
  existing: EventDoc | null,
  obs: Observation,
  now: Date = new Date(),
  extraOccurrences = 0,
): Record<string, unknown> => {
  const iso = now.toISOString()
  const sources = new Set<DiscoverySource>(existing?.sources ?? [])
  sources.add(obs.source)

  const pages = (existing?.pages ?? []).map((p) => p.path).filter((p): p is string => Boolean(p))
  if (obs.page && !pages.includes(obs.page)) {
    pages.push(obs.page)
  }

  const data: Record<string, unknown> = {
    isBuiltIn: BUILT_IN_EVENT_RE.test(obs.name),
    lastSeenAt: iso,
    pages: pages.slice(-MAX_PAGES).map((path) => ({ path })),
    parameters: mergeParams(existing?.parameters ?? [], obs.params),
    sources: Array.from(sources).sort(),
  }

  const seen = (obs.source === 'runtime' ? 1 : 0) + extraOccurrences
  if (!existing) {
    data.eventName = obs.name
    data.firstSeenAt = iso
    data.status = 'discovered'
    data.occurrences = seen
  } else if (seen > 0) {
    data.occurrences = (existing.occurrences ?? 0) + seen
  }

  // The published container is authoritative for trigger metadata.
  if (obs.source === 'container') {
    data.matchType = obs.matchType ?? 'exact'
    data.firesTags = obs.firesTags ?? []
  } else if (!existing) {
    data.matchType = 'exact'
  }

  return data
}

/**
 * True when merging `obs` would change nothing but `lastSeenAt`/`occurrences`.
 * Such observations are counted in memory and written later, which keeps steady-state
 * traffic from turning into one database write per page view.
 */
export const addsNothingNew = (existing: EventDoc, obs: Observation): boolean => {
  if (obs.source === 'container' || !existing.sources?.includes(obs.source)) {
    return false
  }
  if (
    obs.page &&
    !(existing.pages ?? []).some((p) => p.path === obs.page) &&
    (existing.pages?.length ?? 0) < MAX_PAGES
  ) {
    return false
  }
  const rows = new Map((existing.parameters ?? []).map((r) => [r.path, r]))
  return obs.params.every((p) => {
    const row = rows.get(p.path)
    return Boolean(row && row.types?.includes(p.type) && (row.example || !p.example))
  })
}

export type UpsertResult = {
  created: number
  dropped: number
  skipped: number
  updated: number
}

export const upsertOptionsFrom = (options: ResolvedGtmPluginOptions): UpsertOptions => ({
  collectionSlug: options.collectionSlug,
  lockSlug: options.lockSlug,
  maxEvents: options.discovery.maxEvents,
  maxNewEventsPerHour: options.discovery.maxNewEventsPerHour,
  writeIntervalMs: options.discovery.writeIntervalMs,
})

export type UpsertOptions = {
  collectionSlug: string
  /** Lock collection slug; merges are serialized per event name through it. */
  lockSlug: string
  maxEvents: number
  /** Cap on events created by runtime/crawl discovery per rolling hour (all instances). */
  maxNewEventsPerHour: number
  /** Minimum gap between writes for observations that add nothing new. */
  writeIntervalMs: number
}

/** Runtime sightings counted but not yet written, per collection + event name. */
const pending = new Map<string, number>()
const MAX_PENDING_KEYS = 10_000

const addPending = (key: string, n: number) => {
  if (!pending.has(key) && pending.size >= MAX_PENDING_KEYS) {
    const oldest = pending.keys().next().value
    if (oldest !== undefined) {
      pending.delete(oldest)
    }
  }
  pending.set(key, (pending.get(key) ?? 0) + n)
}

const HOUR = 60 * 60 * 1000

/**
 * Upserts observations one by one. Every read-merge-write runs under a per-event
 * database lease, so concurrent requests on any number of instances cannot overwrite
 * each other's parameters, pages or sources. Merges are set unions, so replays are safe.
 */
export const upsertObservations = async (
  payload: Payload,
  opts: UpsertOptions,
  observations: Observation[],
): Promise<UpsertResult> => {
  const result: UpsertResult = { created: 0, dropped: 0, skipped: 0, updated: 0 }
  const slug = opts.collectionSlug as never
  let total: null | number = null
  let createdLastHour: null | number = null

  const findByName = async (name: string) => {
    const { docs } = await payload.find({
      collection: slug,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      where: { eventName: { equals: name } },
    })
    return (docs[0] as unknown as EventDoc | undefined) ?? null
  }

  const isFrozen = (doc: EventDoc, obs: Observation) =>
    // INV-03: ignored events are frozen for runtime/crawl discovery.
    doc.status === 'ignored' && obs.source !== 'container'

  /** Locked read-merge-write. Returns false if the lease could not be obtained. */
  const mergeLocked = async (obs: Observation, pendingKey: string): Promise<boolean> => {
    const res = await withLock(payload, opts.lockSlug, `event:${obs.name}`, async () => {
      const fresh = await findByName(obs.name)
      if (!fresh) {
        return 'missing' as const
      }
      if (isFrozen(fresh, obs)) {
        return 'frozen' as const
      }
      const extra = pending.get(pendingKey) ?? 0
      pending.delete(pendingKey)
      try {
        await payload.update({
          id: fresh.id,
          collection: slug,
          data: buildEventData(fresh, obs, new Date(), extra) as never,
          depth: 0,
          overrideAccess: true,
        })
      } catch (err) {
        addPending(pendingKey, extra)
        throw err
      }
      return 'updated' as const
    })
    if (!res.ok) {
      return false
    }
    if (res.value === 'updated') {
      result.updated++
    } else {
      result.skipped++
    }
    return true
  }

  const canCreate = async (obs: Observation) => {
    if (total === null) {
      total = (await payload.count({ collection: slug, overrideAccess: true })).totalDocs
    }
    if (total >= opts.maxEvents) {
      return false // INV-05
    }
    if (obs.source === 'container') {
      return true // the published container is trusted input
    }
    if (createdLastHour === null) {
      createdLastHour = (
        await payload.count({
          collection: slug,
          overrideAccess: true,
          where: { firstSeenAt: { greater_than: new Date(Date.now() - HOUR).toISOString() } },
        })
      ).totalDocs
    }
    return createdLastHour < opts.maxNewEventsPerHour
  }

  for (const obs of observations) {
    if (!isValidEventName(obs.name)) {
      result.skipped++
      continue
    }
    const pendingKey = `${opts.collectionSlug}:${obs.name}`
    const existing = await findByName(obs.name)

    if (existing) {
      if (isFrozen(existing, obs)) {
        result.skipped++
        continue
      }
      const lastWrite = existing.lastSeenAt ? new Date(existing.lastSeenAt).getTime() : 0
      if (addsNothingNew(existing, obs) && Date.now() - lastWrite < opts.writeIntervalMs) {
        if (obs.source === 'runtime') {
          addPending(pendingKey, 1)
        }
        result.updated++
        continue
      }
      if (!(await mergeLocked(obs, pendingKey))) {
        // Lease busy: keep the sighting; the set data arrives again with the next one.
        if (obs.source === 'runtime') {
          addPending(pendingKey, 1)
        }
        result.skipped++
      }
      continue
    }

    if (!(await canCreate(obs))) {
      result.dropped++
      continue
    }

    try {
      await payload.create({
        collection: slug,
        data: buildEventData(null, obs) as never,
        depth: 0,
        overrideAccess: true,
      })
      total = (total ?? 0) + 1
      createdLastHour = (createdLastHour ?? 0) + 1
      result.created++
    } catch (err) {
      // INV-01: a concurrent request created the same eventName — merge into it instead.
      if (!(await findByName(obs.name))) {
        throw err
      }
      if (!(await mergeLocked(obs, pendingKey))) {
        result.skipped++
      }
    }
  }

  if (result.dropped > 0) {
    payload.logger.warn(
      `[gtm] dropped ${result.dropped} new event name(s): registry cap (${opts.maxEvents}) or hourly limit (${opts.maxNewEventsPerHour}) reached`,
    )
  }
  return result
}
