/**
 * Shared, dependency-free normalization used by BOTH the browser discovery hook
 * and the server-side collect endpoint. The server never trusts client output:
 * it re-runs `sanitizeBatch` on every request.
 */

export type ParamType = 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string'

export type ObservedParam = {
  /** Redacted, truncated example value. Only present when example capture is enabled. */
  example?: string
  /** Dot path, `[]` marks array items, e.g. `ecommerce.items[].item_id` */
  path: string
  type: ParamType
}

export type ObservedEvent = {
  name: string
  params: ObservedParam[]
}

export type CollectPayload = {
  events: ObservedEvent[]
  /** Pathname only, no query or hash */
  page?: string
  v: 1
}

export const LIMITS = {
  maxArrayItemsInspected: 5,
  maxBodyBytes: 32 * 1024,
  maxDepth: 5,
  maxEventsPerBatch: 50,
  maxExampleLength: 100,
  maxNameLength: 100,
  maxParamsPerEvent: 100,
  maxPathLength: 200,
} as const

/** Event names: letters, digits, `_ . : - /` and spaces. Rejects markup and control chars. */
export const EVENT_NAME_RE = /^[\w.:\-/ ]{1,100}$/
const PARAM_PATH_RE = /^[\w.$:\-[\] ]{1,200}$/

/** Keys that are GTM/dataLayer plumbing, not event parameters. */
const IGNORED_KEYS = new Set([
  'event',
  'eventCallback',
  'eventTimeout',
  'gtm.priorityId',
  'gtm.start',
  'gtm.uniqueEventId',
])

export const BUILT_IN_EVENT_RE = /^gtm\./

export const isValidEventName = (name: unknown): name is string =>
  typeof name === 'string' && EVENT_NAME_RE.test(name) && name.trim().length > 0

const typeOf = (value: unknown): null | ParamType => {
  if (value === null || value === undefined) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  switch (typeof value) {
    case 'boolean':
      return 'boolean'
    case 'number':
      return Number.isFinite(value) ? 'number' : null
    case 'object':
      return 'object'
    case 'string':
      return 'string'
    default:
      // functions (eventCallback), symbols, bigint: not data
      return null
  }
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const LONG_DIGITS_RE = /\+?\d[\d\s().-]{7,}\d/g
const TOKEN_RE = /\b[\w-]{24,}\b/g

/** Redacts emails, phone/card-like digit runs and long opaque tokens, then truncates. */
export const redactExample = (value: unknown): string | undefined => {
  if (value === null || value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return undefined
  }
  const str = String(value)
    .replace(EMAIL_RE, '[email]')
    .replace(LONG_DIGITS_RE, '[number]')
    .replace(TOKEN_RE, '[token]')
  return str.length > LIMITS.maxExampleLength ? str.slice(0, LIMITS.maxExampleLength) + '…' : str
}

/**
 * Flattens an arbitrary dataLayer object into typed key paths.
 * Arrays are represented as `path[]` and up to N items are inspected (merging their keys).
 */
export const flattenParams = (
  input: Record<string, unknown>,
  options: { captureExamples?: boolean } = {},
): ObservedParam[] => {
  const out = new Map<string, ObservedParam>()

  const visit = (value: unknown, path: string, depth: number) => {
    if (out.size >= LIMITS.maxParamsPerEvent) {
      return
    }
    const type = typeOf(value)
    if (!type) {
      return
    }

    if (path) {
      const key = `${path}::${type}`
      if (!out.has(key)) {
        const param: ObservedParam = { type, path }
        if (options.captureExamples && type !== 'object' && type !== 'array') {
          const example = redactExample(value)
          if (example !== undefined) {
            param.example = example
          }
        }
        out.set(key, param)
      }
    }

    if (depth >= LIMITS.maxDepth) {
      return
    }

    if (type === 'array') {
      const items = (value as unknown[]).slice(0, LIMITS.maxArrayItemsInspected)
      for (const item of items) {
        visit(item, `${path}[]`, depth + 1)
      }
    } else if (type === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!path && IGNORED_KEYS.has(k)) {
          continue
        }
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
          continue
        }
        const childPath = path ? `${path}.${k}` : k
        if (childPath.length > LIMITS.maxPathLength) {
          continue
        }
        visit(v, childPath, depth + 1)
      }
    }
  }

  visit(input, '', 0)
  return Array.from(out.values())
}

/**
 * Converts one raw dataLayer entry into an observed event, or null when the entry is
 * not an event (config/consent/set commands, plain variable pushes, invalid names).
 *
 * Handles both object pushes (`{event: 'x', ...}`) and gtag() `arguments` pushes
 * (`['event', 'x', {...}]`).
 */
export const entryToEvent = (
  entry: unknown,
  options: { captureExamples?: boolean } = {},
): null | ObservedEvent => {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  // gtag() pushes an Arguments object (array-like, not a real array)
  const maybeArgs = entry as { [k: number]: unknown; length?: unknown }
  if (typeof maybeArgs.length === 'number' && maybeArgs[0] === 'event') {
    const name = maybeArgs[1]
    if (!isValidEventName(name)) {
      return null
    }
    const params = maybeArgs[2]
    return {
      name,
      params:
        params && typeof params === 'object' && !Array.isArray(params)
          ? flattenParams(params as Record<string, unknown>, options)
          : [],
    }
  }
  if (Array.isArray(entry)) {
    return null
  }

  const obj = entry as Record<string, unknown>
  if (!isValidEventName(obj.event)) {
    return null
  }
  return { name: obj.event, params: flattenParams(obj, options) }
}

/** Stable signature used for dedupe: name + sorted `path:type` pairs. */
export const eventSignature = (event: ObservedEvent): string =>
  event.name +
  '|' +
  event.params
    .map((p) => `${p.path}:${p.type}`)
    .sort()
    .join(',')

const PARAM_TYPES = new Set<ParamType>(['array', 'boolean', 'null', 'number', 'object', 'string'])

/** Strips query/hash and caps length. Returns undefined for non-path input. */
export const sanitizePage = (page: unknown): string | undefined => {
  if (typeof page !== 'string' || !page.startsWith('/')) {
    return undefined
  }
  const path = page.split(/[?#]/)[0] ?? ''
  if (!/^[\w\-./~%@+]*$/.test(path)) {
    return undefined
  }
  return path.slice(0, 200)
}

export type SanitizeResult =
  { error: string; ok: false } | { ok: true; payload: CollectPayload; rejected: number }

/**
 * Server-side validator. Re-validates every field, drops anything malformed,
 * and removes examples unless `captureExamples` is enabled (INV-04).
 */
export const sanitizeBatch = (
  raw: unknown,
  options: { captureExamples: boolean },
): SanitizeResult => {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Body must be a JSON object', ok: false }
  }
  const body = raw as Record<string, unknown>
  if (body.v !== 1) {
    return { error: 'Unsupported payload version', ok: false }
  }
  if (!Array.isArray(body.events)) {
    return { error: '`events` must be an array', ok: false }
  }
  if (body.events.length > LIMITS.maxEventsPerBatch) {
    return { error: `Too many events (max ${LIMITS.maxEventsPerBatch})`, ok: false }
  }

  let rejected = 0
  const events: ObservedEvent[] = []

  for (const rawEvent of body.events) {
    if (!rawEvent || typeof rawEvent !== 'object') {
      rejected++
      continue
    }
    const { name, params } = rawEvent as Record<string, unknown>
    if (!isValidEventName(name)) {
      rejected++
      continue
    }
    const cleanParams: ObservedParam[] = []
    if (Array.isArray(params)) {
      for (const p of params.slice(0, LIMITS.maxParamsPerEvent)) {
        if (!p || typeof p !== 'object') {
          continue
        }
        const { type, example, path } = p as Record<string, unknown>
        if (typeof path !== 'string' || !PARAM_PATH_RE.test(path)) {
          continue
        }
        if (typeof type !== 'string' || !PARAM_TYPES.has(type as ParamType)) {
          continue
        }
        const clean: ObservedParam = { type: type as ParamType, path }
        if (options.captureExamples && example !== undefined) {
          // Re-redact on the server: never trust client redaction.
          const redacted = redactExample(example)
          if (redacted !== undefined) {
            clean.example = redacted
          }
        }
        cleanParams.push(clean)
      }
    }
    events.push({ name, params: cleanParams })
  }

  return {
    ok: true,
    payload: { events, page: sanitizePage(body.page), v: 1 },
    rejected,
  }
}
