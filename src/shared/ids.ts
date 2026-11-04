/**
 * Google tag ID formats, shared by the admin validation, the server settings resolver
 * and the browser runtime (dependency-free, safe for the browser bundle).
 */
export const CONTAINER_ID_RE = /^GTM-[A-Z0-9]{4,12}$/
export const MEASUREMENT_ID_RE = /^G-[A-Z0-9]{4,15}$/
/** ISO 3166-1 alpha-2, optionally with an ISO 3166-2 subdivision (`DE`, `US-CA`). */
export const REGION_RE = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/

/** Trims and uppercases a pasted tag ID; empty input becomes undefined. */
export const normalizeTagId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : undefined

/** Returns the ID when it matches `re`, otherwise undefined (never ship a bad ID). */
export const validTagId = (value: unknown, re: RegExp): string | undefined => {
  const id = normalizeTagId(value)
  return id && re.test(id) ? id : undefined
}
