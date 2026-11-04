import type { Payload } from 'payload'

import { randomUUID } from 'crypto'

export type Release = () => Promise<void>

type LockDoc = { expiresAt?: null | string; id: number | string; owner?: null | string }

/**
 * Tries once to take a database lease. Returns a release function, or null when another
 * holder has an unexpired lease. Expired leases (crashed holders) are taken over.
 */
export const tryAcquireLock = async (
  payload: Payload,
  collection: string,
  key: string,
  ttlMs: number,
): Promise<null | Release> => {
  const slug = collection as never
  const owner = randomUUID()

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await payload.create({
        collection: slug,
        data: { expiresAt: new Date(Date.now() + ttlMs).toISOString(), key, owner } as never,
        depth: 0,
        overrideAccess: true,
      })
      return async () => {
        await payload
          .delete({
            collection: slug,
            depth: 0,
            overrideAccess: true,
            where: { and: [{ key: { equals: key } }, { owner: { equals: owner } }] },
          })
          .catch((err: Error) => payload.logger.warn(`[gtm] lock release failed: ${err.message}`))
      }
    } catch {
      // The key is taken (or the insert failed for another reason — the lookup tells us).
      const { docs } = await payload.find({
        collection: slug,
        depth: 0,
        limit: 1,
        overrideAccess: true,
        pagination: false,
        where: { key: { equals: key } },
      })
      const held = docs[0] as unknown as LockDoc | undefined
      if (!held) {
        continue // released in between: try again
      }
      if (held.expiresAt && new Date(held.expiresAt).getTime() > Date.now()) {
        return null
      }
      // Stale lease: remove exactly that holder's row (never a fresh one), then retry.
      await payload.delete({
        collection: slug,
        depth: 0,
        overrideAccess: true,
        where: { and: [{ key: { equals: key } }, { owner: { equals: held.owner ?? '' } }] },
      })
    }
  }
  return null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `fn` while holding the lease, waiting briefly (with jitter) if it is taken.
 * Returns `{ ok: false }` when the lease could not be obtained in time.
 */
export const withLock = async <T>(
  payload: Payload,
  collection: string,
  key: string,
  fn: () => Promise<T>,
  { attempts = 5, ttlMs = 15_000 }: { attempts?: number; ttlMs?: number } = {},
): Promise<{ ok: false } | { ok: true; value: T }> => {
  for (let i = 0; i < attempts; i++) {
    const release = await tryAcquireLock(payload, collection, key, ttlMs)
    if (release) {
      try {
        return { ok: true, value: await fn() }
      } finally {
        await release()
      }
    }
    await sleep(25 * 2 ** i + Math.random() * 50)
  }
  return { ok: false }
}
