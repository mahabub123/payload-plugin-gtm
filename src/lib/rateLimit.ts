/**
 * Minimal in-memory token bucket keyed by client identifier.
 * Per-instance only (see ADR-004); bounded to avoid unbounded memory growth.
 */
export const createRateLimiter = ({
  burst,
  maxKeys = 10_000,
  perMinute,
}: {
  burst: number
  maxKeys?: number
  perMinute: number
}) => {
  const buckets = new Map<string, { tokens: number; updated: number }>()
  const refillPerMs = perMinute / 60_000

  return {
    /** Returns true when the request is allowed. */
    take(key: string, now = Date.now()): boolean {
      let bucket = buckets.get(key)
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          // Evict the oldest entry (Map preserves insertion order).
          const oldest = buckets.keys().next().value
          if (oldest !== undefined) {
            buckets.delete(oldest)
          }
        }
        bucket = { tokens: burst, updated: now }
        buckets.set(key, bucket)
      } else {
        bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.updated) * refillPerMs)
        bucket.updated = now
      }
      if (bucket.tokens < 1) {
        return false
      }
      bucket.tokens -= 1
      return true
    },
  }
}

/** TTL set used to skip DB writes for signatures seen recently on this instance. */
export const createTtlSet = (ttlMs: number, maxKeys = 20_000) => {
  const seen = new Map<string, number>()
  return {
    forget(key: string) {
      seen.delete(key)
    },
    /** Returns true if the key was seen within the TTL; otherwise records it and returns false. */
    seenRecently(key: string, now = Date.now()): boolean {
      const at = seen.get(key)
      if (at !== undefined && now - at < ttlMs) {
        return true
      }
      if (seen.size >= maxKeys) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) {
          seen.delete(oldest)
        }
      }
      seen.delete(key)
      seen.set(key, now)
      return false
    },
  }
}
