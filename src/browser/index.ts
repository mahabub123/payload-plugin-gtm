/**
 * Framework-agnostic browser runtime for payload-plugin-gtm.
 *
 *  - `loadGtm()`        injects the standard GTM snippet (idempotent)
 *  - `startDiscovery()` captures every dataLayer / gtag event and reports its schema
 *  - `initGtm()`        fetches config from Payload and does both
 *
 * Everything is wrapped in try/catch: discovery must never break the host site (NFR-03).
 */
import type { CollectPayload, ObservedEvent } from '../shared/normalize.js'

import { BUILT_IN_EVENT_RE, entryToEvent, eventSignature, LIMITS } from '../shared/normalize.js'

export type GtmEnvironment = { auth: string; preview: string }

export type LoadGtmOptions = {
  containerId: string
  dataLayerName?: string
  environment?: GtmEnvironment
  /** CSP nonce for the injected script tag. */
  nonce?: string
  /** Override the GTM host (e.g. a first-party server-side GTM domain). */
  scriptOrigin?: string
}

export type DiscoveryOptions = {
  /** Send one redacted example value per parameter (server must also allow it). @default false */
  captureExamples?: boolean
  dataLayerName?: string
  /** Absolute or relative URL of `POST /api/gtm/collect`. */
  endpoint: string
  /** Debounce before sending a batch, ms. @default 2000 */
  flushDelayMs?: number
  /** Event names the registry marked as ignored. */
  ignore?: string[]
  /** Also report gtm.* internal events. @default false */
  includeBuiltInEvents?: boolean
  /** Poll interval for array growth (catches pushes that bypass our wrapper), ms. @default 1000 */
  pollMs?: number
  /** Fraction of sessions that report (0-1). @default 1 */
  sampleRate?: number
  /** Consent hook — return false to skip capturing (checked per flush). */
  shouldCapture?: () => boolean
}

export type PublicGtmConfig = {
  containerId?: string
  dataLayerName?: string
  discovery?: {
    captureExamples?: boolean
    enabled?: boolean
    endpoint?: string
    ignore?: string[]
    includeBuiltInEvents?: boolean
    sampleRate?: number
  }
  enabled: boolean
  environment?: GtmEnvironment
}

type AnyWindow = Record<string, unknown> & Window
const w = (): AnyWindow | null =>
  typeof window === 'undefined' ? null : (window as unknown as AnyWindow)

const CONTAINER_RE = /^GTM-[A-Z0-9]{4,12}$/
const IDENT_RE = /^[A-Z_$][\w$]{0,49}$/i
/** gtm_auth / gtm_preview values (base64url-ish tokens, `env-N`). */
const ENV_RE = /^[\w-]{1,100}$/

/** Inline GTM bootstrap (for SSR `<script>` tags). Values are validated to prevent injection. */
export const gtmScriptContent = ({
  containerId,
  dataLayerName = 'dataLayer',
  environment,
  scriptOrigin = 'https://www.googletagmanager.com',
}: LoadGtmOptions): string => {
  if (!CONTAINER_RE.test(containerId)) {
    throw new Error('Invalid GTM container ID')
  }
  if (!IDENT_RE.test(dataLayerName)) {
    throw new Error('Invalid dataLayer name')
  }
  if (environment && !(ENV_RE.test(environment.auth) && ENV_RE.test(environment.preview))) {
    throw new Error('Invalid GTM environment values')
  }
  const env = environment
    ? `+'&gtm_auth=${encodeURIComponent(environment.auth)}&gtm_preview=${encodeURIComponent(environment.preview)}&gtm_cookies_win=x'`
    : ''
  const origin = JSON.stringify(scriptOrigin.replace(/\/+$/, ''))
  return (
    `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});` +
    `var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;` +
    `j.src=${origin}+'/gtm.js?id='+i+dl${env};f.parentNode.insertBefore(j,f);` +
    `})(window,document,'script','${dataLayerName}','${containerId}');`
  )
}

/** URL for the `<noscript><iframe>` fallback. */
export const gtmNoscriptUrl = ({
  containerId,
  environment,
  scriptOrigin,
}: LoadGtmOptions): string => {
  const url = new URL('/ns.html', scriptOrigin ?? 'https://www.googletagmanager.com')
  url.searchParams.set('id', containerId)
  if (environment) {
    url.searchParams.set('gtm_auth', environment.auth)
    url.searchParams.set('gtm_preview', environment.preview)
    url.searchParams.set('gtm_cookies_win', 'x')
  }
  return url.toString()
}

/** Injects GTM once per page. Returns false when already loaded or not in a browser. */
export const loadGtm = (options: LoadGtmOptions): boolean => {
  const win = w()
  if (!win) {
    return false
  }
  const flag = `__gtm_loaded_${options.containerId}`
  if (win[flag]) {
    return false
  }
  try {
    const script = document.createElement('script')
    script.text = gtmScriptContent(options)
    if (options.nonce) {
      script.nonce = options.nonce
    }
    script.setAttribute('data-payload-gtm', options.containerId)
    ;(document.head || document.documentElement).appendChild(script)
    win[flag] = true
    return true
  } catch {
    return false
  }
}

const STORAGE_KEY = '__payload_gtm_discovery'
type SessionState = { backoffUntil?: number; sampled: boolean; sent: string[] }

const readState = (sampleRate: number): SessionState => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) {
      return JSON.parse(raw) as SessionState
    }
  } catch {
    // storage unavailable (privacy mode) — fall through to in-memory state
  }
  return { sampled: Math.random() < sampleRate, sent: [] }
}

const writeState = (state: SessionState) => {
  try {
    // Cap stored signatures to keep sessionStorage small.
    if (state.sent.length > 500) {
      state.sent = state.sent.slice(-500)
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

const WRAPPED = '__payloadGtmWrapped'

/**
 * Starts runtime discovery. Returns a `stop()` function.
 *
 * Capture strategy (ADR-003): wrap `dataLayer.push` for low latency AND poll the array
 * length, so events are captured even when GTM or other code replaces `push` or
 * reassigns the array. Entries pushed before this runs are processed too.
 */
export const startDiscovery = (options: DiscoveryOptions): (() => void) => {
  const win = w()
  if (!win) {
    return () => {}
  }

  const {
    captureExamples = false,
    dataLayerName = 'dataLayer',
    endpoint,
    flushDelayMs = 2000,
    ignore = [],
    includeBuiltInEvents = false,
    pollMs = 1000,
    sampleRate = 1,
    shouldCapture,
  } = options

  const state = readState(sampleRate)
  writeState(state)
  if (!state.sampled) {
    return () => {}
  }

  const ignored = new Set(ignore)
  const sent = new Set(state.sent)
  const queue = new Map<string, { event: ObservedEvent; page: string }>()
  let observed: null | unknown[] = null
  let cursor = 0
  let flushTimer: null | ReturnType<typeof setTimeout> = null
  let stopped = false

  const consentOk = () => {
    try {
      return shouldCapture ? shouldCapture() !== false : true
    } catch {
      return false
    }
  }

  const send = (batch: CollectPayload, useBeacon: boolean) => {
    const body = JSON.stringify(batch)
    try {
      if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        if (navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) {
          return
        }
      }
      void fetch(endpoint, {
        body,
        credentials: 'omit',
        headers: { 'content-type': 'text/plain' },
        keepalive: true,
        method: 'POST',
        mode: 'cors',
      })
        .then((res) => {
          if (res.status === 429 || res.status === 503 || res.status === 403) {
            // Back off for the rest of the session (overload / disabled / misconfigured).
            state.backoffUntil = Date.now() + 30 * 60_000
            writeState(state)
          }
        })
        .catch(() => {})
    } catch {
      // never throw into the host page
    }
  }

  const flush = (useBeacon = false) => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!queue.size) {
      return
    }
    if ((state.backoffUntil ?? 0) > Date.now() || !consentOk()) {
      queue.clear()
      return
    }

    // Group by page, then chunk by count and byte size.
    const byPage = new Map<string, ObservedEvent[]>()
    for (const [sig, { event, page }] of queue) {
      const list = byPage.get(page) ?? []
      list.push(event)
      byPage.set(page, list)
      sent.add(sig)
    }
    queue.clear()
    state.sent = Array.from(sent)
    writeState(state)

    for (const [page, events] of byPage) {
      let chunk: ObservedEvent[] = []
      let size = 64
      for (const event of events) {
        const eventSize = JSON.stringify(event).length
        if (
          chunk.length &&
          (chunk.length >= LIMITS.maxEventsPerBatch ||
            size + eventSize > LIMITS.maxBodyBytes - 1024)
        ) {
          send({ events: chunk, page, v: 1 }, useBeacon)
          chunk = []
          size = 64
        }
        chunk.push(event)
        size += eventSize
      }
      if (chunk.length) {
        send({ events: chunk, page, v: 1 }, useBeacon)
      }
    }
  }

  const scheduleFlush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
    }
    flushTimer = setTimeout(() => flush(false), flushDelayMs)
  }

  const handleEntry = (entry: unknown) => {
    try {
      captureEntry(entry)
    } catch {
      // a hostile/odd entry must not stall the cursor
    }
  }

  const captureEntry = (entry: unknown) => {
    const event = entryToEvent(entry, { captureExamples })
    if (!event) {
      return
    }
    if (ignored.has(event.name)) {
      return
    }
    if (!includeBuiltInEvents && BUILT_IN_EVENT_RE.test(event.name)) {
      return
    }
    const sig = eventSignature(event)
    if (sent.has(sig) || queue.has(sig)) {
      return
    }
    queue.set(sig, { event, page: location.pathname })
    if (queue.size >= LIMITS.maxEventsPerBatch) {
      flush(false)
    } else {
      scheduleFlush()
    }
  }

  const drain = () => {
    if (stopped) {
      return
    }
    try {
      const current = win[dataLayerName]
      if (!Array.isArray(current)) {
        win[dataLayerName] = []
        return drain()
      }
      if (current !== observed) {
        // Reassigned dataLayer: finish the old array first, then start the new one from 0.
        if (observed) {
          while (cursor < observed.length) {
            handleEntry(observed[cursor])
            cursor++
          }
        }
        observed = current
        cursor = 0
      }
      if (!(current.push as unknown as Record<string, unknown>)[WRAPPED]) {
        const originalPush = current.push
        const wrapped = function (this: unknown[], ...items: unknown[]) {
          const result = originalPush.apply(this, items)
          queueMicrotask(drain)
          return result
        }
        ;(wrapped as unknown as Record<string, unknown>)[WRAPPED] = true
        current.push = wrapped
      }
      // GTM may splice processed entries; never let the cursor exceed the length.
      if (cursor > current.length) {
        cursor = current.length
      }
      while (cursor < current.length) {
        handleEntry(current[cursor])
        cursor++
      }
    } catch {
      // swallow — discovery must never break the page
    }
  }

  const onPageHide = () => flush(true)
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      flush(true)
    }
  }

  drain()
  const interval = setInterval(drain, pollMs)
  win.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibility)

  return () => {
    stopped = true
    clearInterval(interval)
    win.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibility)
    flush(true)
  }
}

export type InitGtmOptions = {
  /** Use this config instead of fetching it (e.g. rendered server-side via `getGtmSettings`). */
  config?: PublicGtmConfig
  /** Full URL of `GET /api/gtm/config`. Defaults to `${serverUrl}/api/gtm/config`. */
  configUrl?: string
  /** Disable runtime discovery even if enabled in Payload. */
  discovery?: boolean
  /** Skip injecting GTM (e.g. you already render the snippet server-side). */
  loadContainer?: boolean
  nonce?: string
  /** Payload server origin, e.g. https://cms.example.com. Defaults to the current origin. */
  serverUrl?: string
  shouldCapture?: () => boolean
}

const CONFIG_CACHE_KEY = '__payload_gtm_config'

const fetchConfig = async (url: string): Promise<PublicGtmConfig> => {
  try {
    const cached = sessionStorage.getItem(CONFIG_CACHE_KEY)
    if (cached) {
      const {
        at,
        config,
        url: cachedUrl,
      } = JSON.parse(cached) as {
        at: number
        config: PublicGtmConfig
        url: string
      }
      if (cachedUrl === url && Date.now() - at < 5 * 60_000) {
        return config
      }
    }
  } catch {
    // ignore
  }
  const res = await fetch(url, { credentials: 'omit' })
  const config = (await res.json()) as PublicGtmConfig
  try {
    sessionStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ at: Date.now(), config, url }))
  } catch {
    // ignore
  }
  return config
}

/**
 * One-call setup: loads config from Payload, injects GTM and starts discovery.
 * Resolves to a `stop()` function for discovery (no-op if disabled).
 */
export const initGtm = async (options: InitGtmOptions = {}): Promise<() => void> => {
  const win = w()
  if (!win) {
    return () => {}
  }
  try {
    const serverUrl = (options.serverUrl ?? location.origin).replace(/\/+$/, '')
    const config =
      options.config ?? (await fetchConfig(options.configUrl ?? `${serverUrl}/api/gtm/config`))
    if (!config.enabled || !config.containerId) {
      return () => {}
    }

    const dataLayerName = config.dataLayerName ?? 'dataLayer'
    let stop = () => {}

    // Start discovery BEFORE loading GTM so gtm.js / early pushes are observed too.
    const d = config.discovery
    if (options.discovery !== false && d?.enabled && d.endpoint) {
      const endpoint = /^https?:\/\//.test(d.endpoint) ? d.endpoint : `${serverUrl}${d.endpoint}`
      stop = startDiscovery({
        captureExamples: d.captureExamples,
        dataLayerName,
        endpoint,
        ignore: d.ignore,
        includeBuiltInEvents: d.includeBuiltInEvents,
        sampleRate: d.sampleRate,
        shouldCapture: options.shouldCapture,
      })
    }

    if (options.loadContainer !== false) {
      loadGtm({
        containerId: config.containerId,
        dataLayerName,
        environment: config.environment,
        nonce: options.nonce,
      })
    }
    return stop
  } catch {
    return () => {}
  }
}

/** Typed helper to push events to the dataLayer. */
export const pushEvent = (
  event: string,
  params: Record<string, unknown> = {},
  dataLayerName = 'dataLayer',
): void => {
  const win = w()
  if (!win) {
    return
  }
  const dl = (win[dataLayerName] = (win[dataLayerName] as undefined | unknown[]) ?? [])
  dl.push({ event, ...params })
}
