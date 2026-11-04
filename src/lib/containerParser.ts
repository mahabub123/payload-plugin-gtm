import type { FiredTag, MatchType } from './registry.js'

import { isValidEventName } from '../shared/normalize.js'

/**
 * Parser for the published GTM web container (`gtm.js?id=GTM-XXXX`).
 *
 * The container embeds `var data = { "resource": { macros, tags, predicates, rules }, ... }`.
 *  - macros with `function: "__e"` are the built-in {{Event}} variable
 *  - predicates `{function: "_eq"|"_re"|"_sw"|"_cn"|"_ew", arg0: ["macro", i], arg1: "value"}`
 *    whose arg0 is an {{Event}} macro are Custom Event trigger conditions
 *  - rules `[["if", p1, p2], ["unless", p3], ["add", t1, t2]]` map predicates to tag indexes
 *  - macros with `function: "__v"` are Data Layer Variables (`vtp_name` is the key path)
 *  - GA4 event tags have `function: "__gaawe"` and `vtp_eventName`
 */

type Predicate = { arg0?: unknown; arg1?: unknown; function?: string }
type Tag = { function?: string; tag_id?: number | string; vtp_eventName?: unknown }
type Macro = { function?: string; vtp_name?: unknown }
type Resource = {
  macros?: Macro[]
  predicates?: Predicate[]
  rules?: unknown[][]
  tags?: Tag[]
  version?: string
}

export type ContainerEvent = {
  firesTags: FiredTag[]
  matchType: MatchType
  name: string
}

export type PatternTrigger = { matchType: MatchType; pattern: string }

export type ParsedContainer = {
  events: ContainerEvent[]
  /** Triggers whose patterns could not be expanded into concrete event names. */
  patterns: PatternTrigger[]
  /** Data Layer Variable key paths the container reads. */
  variables: string[]
  version?: string
}

const PREDICATE_MATCH: Record<string, MatchType> = {
  _cn: 'contains',
  _eq: 'exact',
  _ew: 'endsWith',
  _re: 'regex',
  _sw: 'startsWith',
}

/** Extracts the first balanced JSON object starting at `start` (string-aware). */
const extractObject = (source: string, start: number): null | string => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i++) {
    const c = source[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (c === '\\') {
        escaped = true
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
    } else if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        return source.slice(start, i + 1)
      }
    }
  }
  return null
}

export const extractResource = (js: string): null | Resource => {
  const anchors = [/var\s+data\s*=\s*\{/, /\{\s*"resource"\s*:/]
  for (const anchor of anchors) {
    const match = anchor.exec(js)
    if (!match) {
      continue
    }
    const start = js.indexOf('{', match.index)
    const raw = extractObject(js, start)
    if (!raw) {
      continue
    }
    try {
      const parsed = JSON.parse(raw) as { resource?: Resource }
      if (parsed && typeof parsed === 'object' && parsed.resource) {
        return parsed.resource
      }
    } catch {
      // try next anchor
    }
  }
  return null
}

/**
 * Expands simple regexes (literals, groups, alternation, optional groups, anchors,
 * escaped punctuation) into the finite set of strings they match.
 * Returns null for anything open-ended (`.`, `*`, `+`, classes, quantifiers) or when
 * the expansion would exceed `limit`.
 */
export const expandSimpleRegex = (pattern: string, limit = 50): null | string[] => {
  let src = pattern
  if (src.startsWith('^')) {
    src = src.slice(1)
  }
  if (src.endsWith('$') && !src.endsWith('\\$')) {
    src = src.slice(0, -1)
  } else {
    return null
  } // unanchored regex matches substrings: not a finite name set
  if (!pattern.startsWith('^')) {
    return null
  }

  let pos = 0

  const parseAlternation = (): null | string[] => {
    const branches: string[] = []
    let current = parseSequence()
    if (!current) {
      return null
    }
    branches.push(...current)
    while (src[pos] === '|') {
      pos++
      current = parseSequence()
      if (!current) {
        return null
      }
      branches.push(...current)
      if (branches.length > limit) {
        return null
      }
    }
    return branches
  }

  const parseSequence = (): null | string[] => {
    let results = ['']
    while (pos < src.length && src[pos] !== '|' && src[pos] !== ')') {
      let atom: null | string[]
      const c = src[pos]
      if (c === '(') {
        pos++
        if (src.startsWith('?:', pos)) {
          pos += 2
        }
        atom = parseAlternation()
        if (!atom || src[pos] !== ')') {
          return null
        }
        pos++
      } else if (c === '\\') {
        const next = src[pos + 1]
        if (!next || /\w/.test(next)) {
          return null
        } // \d \w \s etc. are open-ended
        atom = [next]
        pos += 2
      } else if (/[.*+[\]{}^$]/.test(c)) {
        return null
      } else {
        atom = [c]
        pos++
      }
      if (src[pos] === '?') {
        pos++
        atom = [...atom, '']
      }
      const next: string[] = []
      for (const prefix of results) {
        for (const suffix of atom) {
          next.push(prefix + suffix)
          if (next.length > limit) {
            return null
          }
        }
      }
      results = next
    }
    return results
  }

  const out = parseAlternation()
  if (!out || pos !== src.length) {
    return null
  }
  return Array.from(new Set(out)).filter((s) => s.length > 0)
}

export const parseContainer = (js: string): ParsedContainer => {
  const resource = extractResource(js)
  if (!resource) {
    throw new Error(
      'Could not find container data in gtm.js (format changed or not a web container)',
    )
  }

  const macros = Array.isArray(resource.macros) ? resource.macros : []
  const predicates = Array.isArray(resource.predicates) ? resource.predicates : []
  const rules = Array.isArray(resource.rules) ? resource.rules : []
  const tags = Array.isArray(resource.tags) ? resource.tags : []

  const eventMacros = new Set<number>()
  const variables = new Set<string>()
  macros.forEach((m, i) => {
    if (!m || typeof m !== 'object') {
      return
    }
    if (m.function === '__e') {
      eventMacros.add(i)
    }
    if (m.function === '__v' && typeof m.vtp_name === 'string' && m.vtp_name.length <= 200) {
      variables.add(m.vtp_name)
    }
  })

  const isEventPredicate = (p: Predicate) =>
    Array.isArray(p.arg0) &&
    p.arg0[0] === 'macro' &&
    typeof p.arg0[1] === 'number' &&
    eventMacros.has(p.arg0[1]) &&
    typeof p.function === 'string' &&
    p.function in PREDICATE_MATCH &&
    typeof p.arg1 === 'string'

  // predicate index -> tags fired by rules that require it
  const tagsByPredicate = new Map<number, Set<number>>()
  for (const rule of rules) {
    if (!Array.isArray(rule)) {
      continue
    }
    const ifs: number[] = []
    const adds: number[] = []
    for (const clause of rule) {
      if (!Array.isArray(clause)) {
        continue
      }
      const [kind, ...ids] = clause as [unknown, ...unknown[]]
      const nums = ids.filter((n): n is number => typeof n === 'number')
      if (kind === 'if') {
        ifs.push(...nums)
      } else if (kind === 'add') {
        adds.push(...nums)
      }
    }
    for (const p of ifs) {
      const set = tagsByPredicate.get(p) ?? new Set<number>()
      adds.forEach((t) => set.add(t))
      tagsByPredicate.set(p, set)
    }
  }

  const describeTag = (index: number): FiredTag | null => {
    const tag = tags[index]
    if (!tag || typeof tag !== 'object' || typeof tag.function !== 'string') {
      return null
    }
    const fired: FiredTag = {
      tagId: String(tag.tag_id ?? index),
      tagType: tag.function.replace(/^__/, ''),
    }
    if (tag.function === '__gaawe' && typeof tag.vtp_eventName === 'string') {
      fired.ga4EventName = tag.vtp_eventName
    }
    return fired
  }

  const events = new Map<string, ContainerEvent>()
  const patterns: PatternTrigger[] = []

  const addEvent = (name: string, matchType: MatchType, tagIdx: Set<number> | undefined) => {
    const existing = events.get(name) ?? { name, firesTags: [], matchType }
    const seen = new Set(existing.firesTags.map((t) => t.tagId))
    for (const t of tagIdx ?? []) {
      const fired = describeTag(t)
      if (fired && !seen.has(fired.tagId)) {
        existing.firesTags.push(fired)
        seen.add(fired.tagId)
      }
    }
    events.set(name, existing)
  }

  predicates.forEach((p, index) => {
    if (!p || typeof p !== 'object' || !isEventPredicate(p)) {
      return
    }
    const matchType = PREDICATE_MATCH[p.function!]
    const value = p.arg1 as string
    const tagIdx = tagsByPredicate.get(index)

    if (matchType === 'exact') {
      if (isValidEventName(value)) {
        addEvent(value, 'exact', tagIdx)
      }
      return
    }
    if (matchType === 'regex') {
      const expanded = expandSimpleRegex(value)
      if (expanded && expanded.every(isValidEventName)) {
        expanded.forEach((name) => addEvent(name, 'exact', tagIdx))
        return
      }
    } else if (isValidEventName(value)) {
      // startsWith / contains / endsWith: record the fragment with its match type
      addEvent(value, matchType, tagIdx)
      return
    }
    patterns.push({ matchType, pattern: value.slice(0, 200) })
  })

  return {
    events: Array.from(events.values()).sort((a, b) => a.name.localeCompare(b.name)),
    patterns,
    variables: Array.from(variables).sort(),
    version: typeof resource.version === 'string' ? resource.version : undefined,
  }
}
