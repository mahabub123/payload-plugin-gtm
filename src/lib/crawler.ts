import { isValidEventName } from '../shared/normalize.js'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type SafeFetchOptions = {
  /** Only URLs with exactly this origin may be requested (including after redirects). */
  allowedOrigin: string
  fetchImpl?: FetchLike
  maxBytes: number
  maxRedirects?: number
  timeoutMs: number
}

/**
 * Fetches text from a URL pinned to one origin. Redirects are followed manually and
 * re-checked (SSRF guard, SEC-03); bodies are truncated at `maxBytes`.
 */
export const safeFetchText = async (
  url: string,
  { allowedOrigin, fetchImpl = fetch, maxBytes, maxRedirects = 3, timeoutMs }: SafeFetchOptions,
): Promise<{ status: number; text: string; url: string }> => {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(current)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Blocked protocol: ${parsed.protocol}`)
    }
    if (parsed.origin !== allowedOrigin) {
      throw new Error(`Blocked cross-origin request to ${parsed.origin}`)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(current, {
        headers: { 'user-agent': 'payload-plugin-gtm/0.1 (+event discovery)' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) {
          throw new Error(`Redirect without location from ${current}`)
        }
        current = new URL(location, current).toString()
        continue
      }
      const text = await readCapped(res, maxBytes)
      return { status: res.status, text, url: current }
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`Too many redirects for ${url}`)
}

const readCapped = async (res: Response, maxBytes: number): Promise<string> => {
  if (!res.body) {
    return (await res.text()).slice(0, maxBytes)
  }
  if (maxBytes <= 0) {
    return ''
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    const remaining = maxBytes - received
    const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
    received += chunk.byteLength
    out += decoder.decode(chunk, { stream: true })
    if (received >= maxBytes) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  return out + decoder.decode()
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const NAME = '[\\w.:\\-/ ]{1,100}'
const EVENT_KEY_RE = new RegExp(`["']?\\bevent["']?\\s*:\\s*(["'\`])(${NAME})\\1`, 'g')
const GTAG_EVENT_RE = new RegExp(`gtag\\(\\s*["']event["']\\s*,\\s*["'](${NAME})["']`, 'g')

/**
 * Statically extracts event names from HTML or JS source.
 * `event: "x"` keys are only accepted within a window after a dataLayer reference
 * to avoid false positives from unrelated code.
 */
export const extractEventNames = (source: string, dataLayerName = 'dataLayer'): string[] => {
  const found = new Set<string>()
  const anchorRe = new RegExp(`\\b${escapeRe(dataLayerName)}\\b`, 'g')
  const WINDOW = 1500

  // Merge overlapping windows so matches never straddle a boundary.
  const ranges: [number, number][] = []
  for (const match of source.matchAll(anchorRe)) {
    const start = match.index
    const end = start + WINDOW
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1]) {
      last[1] = end
    } else {
      ranges.push([start, end])
    }
  }
  for (const [start, end] of ranges) {
    for (const m of source.slice(start, end).matchAll(EVENT_KEY_RE)) {
      const name = m[2]
      if (isValidEventName(name)) {
        found.add(name)
      }
    }
  }
  for (const m of source.matchAll(GTAG_EVENT_RE)) {
    if (isValidEventName(m[1])) {
      found.add(m[1])
    }
  }
  return Array.from(found)
}

export const extractScriptSrcs = (html: string, baseUrl: string): string[] => {
  const out = new Set<string>()
  const origin = new URL(baseUrl).origin
  for (const m of html.matchAll(/<script(?:\s[^>]*)?\ssrc\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(m[1].replace(/&amp;/g, '&'), baseUrl)
      if (url.origin === origin) {
        out.add(url.toString())
      }
    } catch {
      // ignore malformed src
    }
  }
  return Array.from(out)
}

export const extractSitemapLocs = (xml: string): string[] =>
  Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi), (m) => m[1].replace(/&amp;/g, '&'))

export type CrawlResult = {
  errors: string[]
  /** event name -> page paths where it was found */
  events: Map<string, Set<string>>
  pages: number
}

export const crawlSite = async ({
  dataLayerName,
  extraUrls = [],
  fetchImpl,
  maxPages,
  maxScripts,
  siteUrl,
  timeoutMs,
  useSitemap,
}: {
  dataLayerName: string
  extraUrls?: string[]
  fetchImpl?: FetchLike
  maxPages: number
  maxScripts: number
  siteUrl: string
  timeoutMs: number
  useSitemap: boolean
}): Promise<CrawlResult> => {
  const origin = new URL(siteUrl).origin
  const fetchOpts = { allowedOrigin: origin, fetchImpl, timeoutMs }
  const errors: string[] = []
  const events = new Map<string, Set<string>>()
  const record = (names: string[], path: string) => {
    for (const n of names) {
      const set = events.get(n) ?? new Set<string>()
      if (set.size < 25) {
        set.add(path)
      }
      events.set(n, set)
    }
  }

  const sameOrigin = (u: string): null | string => {
    try {
      const url = new URL(u, origin)
      url.hash = ''
      return url.origin === origin ? url.toString() : null
    } catch {
      return null
    }
  }

  const pages: string[] = []
  const addPage = (u: string) => {
    const s = sameOrigin(u)
    if (s && !pages.includes(s) && pages.length < maxPages) {
      pages.push(s)
    }
  }
  addPage(siteUrl)
  extraUrls.forEach(addPage)

  if (useSitemap && pages.length < maxPages) {
    try {
      const queue = [`${origin}/sitemap.xml`]
      let sitemapsFetched = 0
      while (queue.length && sitemapsFetched < 4 && pages.length < maxPages) {
        const { status, text } = await safeFetchText(queue.shift()!, {
          ...fetchOpts,
          maxBytes: 5 * 1024 * 1024,
        })
        sitemapsFetched++
        if (status !== 200) {
          continue
        }
        for (const loc of extractSitemapLocs(text)) {
          if (/\.xml(?:\?|$)/i.test(loc)) {
            if (sameOrigin(loc)) {
              queue.push(loc)
            }
          } else {
            addPage(loc)
          }
        }
      }
    } catch (err) {
      errors.push(`sitemap: ${(err as Error).message}`)
    }
  }

  const scripts = new Map<string, string>() // script url -> first page path
  for (const pageUrl of pages) {
    const path = new URL(pageUrl).pathname
    try {
      const { status, text } = await safeFetchText(pageUrl, {
        ...fetchOpts,
        maxBytes: 3 * 1024 * 1024,
      })
      if (status !== 200) {
        errors.push(`${path}: HTTP ${status}`)
        continue
      }
      record(extractEventNames(text, dataLayerName), path)
      for (const src of extractScriptSrcs(text, pageUrl)) {
        if (!scripts.has(src) && scripts.size < maxScripts) {
          scripts.set(src, path)
        }
      }
    } catch (err) {
      errors.push(`${path}: ${(err as Error).message}`)
    }
  }

  for (const [src, path] of scripts) {
    try {
      const { status, text } = await safeFetchText(src, { ...fetchOpts, maxBytes: 5 * 1024 * 1024 })
      if (status === 200) {
        record(extractEventNames(text, dataLayerName), path)
      }
    } catch (err) {
      errors.push(`${new URL(src).pathname}: ${(err as Error).message}`)
    }
  }

  return { errors, events, pages: pages.length }
}
