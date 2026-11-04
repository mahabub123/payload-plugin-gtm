import type { Payload } from 'payload'

import type { ObservedParam, ParamType } from '../shared/normalize.js'

import { BUILT_IN_EVENT_RE, isValidEventName } from '../shared/normalize.js'

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
 */
export const buildEventData = (
  existing: EventDoc | null,
  obs: Observation,
  now: Date = new Date(),
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

  if (!existing) {
    data.eventName = obs.name
    data.firstSeenAt = iso
    data.status = 'discovered'
    data.occurrences = obs.source === 'runtime' ? 1 : 0
  } else if (obs.source === 'runtime') {
    data.occurrences = (existing.occurrences ?? 0) + 1
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

export type UpsertResult = { created: number; dropped: number; skipped: number; updated: number }

/**
 * Upserts observations one by one. Safe to replay: merges are set unions (idempotent
 * apart from the approximate occurrence counter).
 */
export const upsertObservations = async (
  payload: Payload,
  {
    collectionSlug,
    maxEvents,
  }: {
    collectionSlug: string
    maxEvents: number
  },
  observations: Observation[],
): Promise<UpsertResult> => {
  const result: UpsertResult = { created: 0, dropped: 0, skipped: 0, updated: 0 }
  const slug = collectionSlug as never
  let total: null | number = null

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

  const update = async (existing: EventDoc, obs: Observation) => {
    await payload.update({
      id: existing.id,
      collection: slug,
      data: buildEventData(existing, obs) as never,
      depth: 0,
      overrideAccess: true,
    })
    result.updated++
  }

  for (const obs of observations) {
    if (!isValidEventName(obs.name)) {
      result.skipped++
      continue
    }

    const existing = await findByName(obs.name)

    if (existing) {
      // INV-03: ignored events are frozen for runtime/crawl discovery.
      if (existing.status === 'ignored' && obs.source !== 'container') {
        result.skipped++
        continue
      }
      await update(existing, obs)
      continue
    }

    if (total === null) {
      total = (await payload.count({ collection: slug, overrideAccess: true })).totalDocs
    }
    if (total >= maxEvents) {
      // INV-05
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
      total++
      result.created++
    } catch (err) {
      // INV-01: a concurrent request may have created the same eventName — retry as update.
      const raced = await findByName(obs.name)
      if (!raced) {
        throw err
      }
      await update(raced, obs)
    }
  }

  if (result.dropped > 0) {
    payload.logger.warn(
      `[gtm] registry cap reached (${maxEvents}); dropped ${result.dropped} new event name(s)`,
    )
  }
  return result
}
