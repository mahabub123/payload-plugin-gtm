/**
 * Framework-agnostic browser runtime for payload-plugin-gtm.
 *
 *  - `loadGtm()`        injects the standard GTM snippet (idempotent)
 *  - `loadGoogleAnalytics()` injects the GA4 gtag.js snippet (idempotent)
 *  - `applyConsentDefaults()` / `updateConsent()` drive Google Consent Mode v2
 *  - `startDiscovery()` captures every dataLayer / gtag event and reports its schema
 *  - `initGtm()`        fetches config from Payload and does all of the above
 *
 * Everything is wrapped in try/catch: discovery must never break the host site (NFR-03).
 */
import type { CollectPayload, ObservedEvent } from '../shared/normalize.js'

import { CONTAINER_ID_RE, MEASUREMENT_ID_RE, REGION_RE } from '../shared/ids.js'
import { BUILT_IN_EVENT_RE, entryToEvent, eventSignature, LIMITS } from '../shared/normalize.js'

export type GtmEnvironment = { auth: string; preview: string }

export type LoadGtmOptions = {
  containerId: string
  dataLayerName?: string
  environment?: GtmEnvironment
  /** CSP nonce for the injected inline script AND the gtm.js script it loads. */
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

export type LoadGoogleAnalyticsOptions = {
  dataLayerName?: string
  /** Send `debug_mode: true` so hits show up in GA4 DebugView. @default false */
  debugMode?: boolean
  measurementId: string
  /** CSP nonce for the injected inline script AND the gtag.js script it loads. */
  nonce?: string
  /** Override the gtag.js host (e.g. a first-party server-side tagging domain). */
  scriptOrigin?: string
  /** Send the initial page_view from `gtag('config')`. @default true */
  sendPageView?: boolean
}

export type ConsentState = 'denied' | 'granted'

/** Google Consent Mode v2 signals. */
export type ConsentSignals = {
  ad_personalization?: ConsentState
  ad_storage?: ConsentState
  ad_user_data?: ConsentState
  analytics_storage?: ConsentState
}

export type ConsentDefaults = {
  /** ISO 3166-1/2 codes (`DE`, `US-CA`) the defaults apply to. Empty = everywhere. */
  regions?: string[]
  signals: ConsentSignals
  /** How long tags wait for a CMP `update` before firing, ms. @default 0 */
  waitForUpdateMs?: number
}

export type PublicGtmConfig = {
  analytics?: {
    debugMode?: boolean
    measurementId: string
    sendPageView?: boolean
  }
  /** Consent Mode v2 defaults, sent before any Google tag loads. */
  consent?: ConsentDefaults
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

const IDENT_RE = /^[A-Z_$][\w$]{0,49}$/i
/** gtm_auth / gtm_preview values (base64url-ish tokens, `env-N`). */
const ENV_RE = /^[\w-]{1,100}$/
/** CSP nonces are base64 / base64url tokens. */
const NONCE_RE = /^[\w+/=-]{8,256}$/
const CONSENT_KEYS = [
  'ad_personalization',
  'ad_storage',
  'ad_user_data',
  'analytics_storage',
] as const

/** Statement that propagates a validated nonce to the dynamically created script `j`. */
const nonceStatement = (nonce: string | undefined): string => {
  if (!nonce) {
    return ''
  }
  if (!NONCE_RE.test(nonce)) {
    throw new Error('Invalid CSP nonce')
  }
  return `j.setAttribute('nonce',${JSON.stringify(nonce)});`
}

/** Pushes a real `arguments` object (gtag.js and GTM ignore plain arrays). */
const pushArgs = (dataLayerName: string, ...args: unknown[]): void => {
  const win = w()
  if (!win) {
    return
  }
  const dl = (win[dataLayerName] = (win[dataLayerName] as undefined | unknown[]) ?? [])
  ;(function (..._args: unknown[]) {
    // eslint-disable-next-line prefer-rest-params
    dl.push(arguments)
  })(...args)
}

const validSignals = (signals: ConsentSignals): Record<string, ConsentState> => {
  const out: Record<string, ConsentState> = {}
  for (const key of CONSENT_KEYS) {
    const value = signals?.[key]
    if (value === undefined) {
      continue
    }
    if (value !== 'denied' && value !== 'granted') {
      throw new Error(`Invalid consent value for ${key}`)
    }
    out[key] = value
  }
  if (!Object.keys(out).length) {
    throw new Error('Consent needs at least one signal')
  }
  return out
}

/** Validated `gtag('consent', 'default', …)` parameters. */
const consentDefaultParams = (consent: ConsentDefaults): Record<string, unknown> => {
  const params: Record<string, unknown> = validSignals(consent.signals)
  const wait = consent.waitForUpdateMs
  if (wait !== undefined && wait !== 0) {
    if (!Number.isInteger(wait) || wait < 0 || wait > 10_000) {
      throw new Error('waitForUpdateMs must be an integer between 0 and 10000')
    }
    params.wait_for_update = wait
  }
  if (consent.regions?.length) {
    if (!consent.regions.every((r) => REGION_RE.test(r))) {
      throw new Error('Invalid consent region (use ISO codes like DE or US-CA)')
    }
    params.region = consent.regions
  }
  return params
}

/**
 * Inline Consent Mode v2 default command (for SSR `<script>` tags). Render it BEFORE the
 * GTM / gtag snippets. Values are validated to prevent injection.
 */
export const consentScriptContent = (
  consent: ConsentDefaults,
  dataLayerName = 'dataLayer',
): string => {
  if (!IDENT_RE.test(dataLayerName)) {
    throw new Error('Invalid dataLayer name')
  }
  const params = JSON.stringify(consentDefaultParams(consent))
  return `(function(w,l){w[l]=w[l]||[];(function(){w[l].push(arguments)})('consent','default',${params});})(window,'${dataLayerName}');`
}

/**
 * Pushes the Consent Mode v2 defaults once per page. Must run before GTM / gtag.js load
 * (`initGtm` does this for you). Returns false when already applied or invalid.
 */
export const applyConsentDefaults = (
  consent: ConsentDefaults,
  dataLayerName = 'dataLayer',
): boolean => {
  const win = w()
  if (!win || win.__payload_consent_default) {
    return false
  }
  try {
    pushArgs(dataLayerName, 'consent', 'default', consentDefaultParams(consent))
    win.__payload_consent_default = true
    return true
  } catch {
    return false
  }
}

/**
 * Call from your consent banner / CMP callback when the visitor decides, e.g.
 * `updateConsent({ analytics_storage: 'granted' })`.
 */
export const updateConsent = (signals: ConsentSignals, dataLayerName = 'dataLayer'): void => {
  const win = w()
  if (!win) {
    return
  }
  try {
    const params = validSignals(signals)
    const gtag = win.gtag
    if (typeof gtag === 'function') {
      ;(gtag as (...args: unknown[]) => void)('consent', 'update', params)
    } else {
      pushArgs(dataLayerName, 'consent', 'update', params)
    }
  } catch {
    // never throw into the host page
  }
}

/** Inline GTM bootstrap (for SSR `<script>` tags). Values are validated to prevent injection. */
export const gtmScriptContent = ({
  containerId,
  dataLayerName = 'dataLayer',
  environment,
  nonce,
  scriptOrigin = 'https://www.googletagmanager.com',
}: LoadGtmOptions): string => {
  if (!CONTAINER_ID_RE.test(containerId)) {
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
  const n = nonceStatement(nonce)
  return (
    `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});` +
    `var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;` +
    `j.src=${origin}+'/gtm.js?id='+i+dl${env};${n}f.parentNode.insertBefore(j,f);` +
    `})(window,document,'script','${dataLayerName}','${containerId}');`
  )
}

/**
 * Inline GA4 bootstrap (for SSR `<script>` tags): defines `gtag()` on the dataLayer,
 * sends `config` and loads gtag.js. Values are validated to prevent injection.
 * `window.gtag` is only defined when missing, so an existing gtag keeps working.
 */
export const gtagScriptContent = ({
  dataLayerName = 'dataLayer',
  debugMode = false,
  measurementId,
  nonce,
  scriptOrigin = 'https://www.googletagmanager.com',
  sendPageView = true,
}: LoadGoogleAnalyticsOptions): string => {
  if (!MEASUREMENT_ID_RE.test(measurementId)) {
    throw new Error('Invalid GA4 measurement ID')
  }
  if (!IDENT_RE.test(dataLayerName)) {
    throw new Error('Invalid dataLayer name')
  }
  // Only booleans go in here; GA4 treats any debug_mode value as "on", so omit it when off.
  const cfg: Record<string, boolean> = {}
  if (!sendPageView) {
    cfg.send_page_view = false
  }
  if (debugMode) {
    cfg.debug_mode = true
  }
  const origin = JSON.stringify(scriptOrigin.replace(/\/+$/, ''))
  const n = nonceStatement(nonce)
  return (
    `(function(w,d,s,l,i){w[l]=w[l]||[];var g=function(){w[l].push(arguments)};w.gtag=w.gtag||g;` +
    `g('js',new Date());g('config',i,${JSON.stringify(cfg)});` +
    `var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;` +
    `j.src=${origin}+'/gtag/js?id='+i+dl;${n}f.parentNode.insertBefore(j,f);` +
    `})(window,document,'script','${dataLayerName}','${measurementId}');`
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

/** Injects GA4 (gtag.js) once per measurement ID. Returns false when already loaded or not in a browser. */
export const loadGoogleAnalytics = (options: LoadGoogleAnalyticsOptions): boolean => {
  const win = w()
  if (!win) {
    return false
  }
  const flag = `__ga_loaded_${options.measurementId}`
  if (win[flag]) {
    return false
  }
  try {
    const script = document.createElement('script')
    script.text = gtagScriptContent(options)
    if (options.nonce) {
      script.nonce = options.nonce
    }
    script.setAttribute('data-payload-ga', options.measurementId)
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
  /** Payload `routes.api`, if you changed it. @default '/api' */
  apiRoute?: string
  /** The plugin's `basePath` option, if you changed it. @default 'gtm' */
  basePath?: string
  /** Use this config instead of fetching it (e.g. rendered server-side via `getGtmSettings`). */
  config?: PublicGtmConfig
  /** Full URL of the config endpoint. Defaults to `${serverUrl}${apiRoute}/${basePath}/config`. */
  configUrl?: string
  /**
   * Push the Consent Mode defaults from Payload before loading tags. Set false when your
   * CMP (Cookiebot, OneTrust, …) or an SSR `consentScriptContent()` tag sets them. @default true
   */
  consentDefaults?: boolean
  /** Disable runtime discovery even if enabled in Payload. */
  discovery?: boolean
  /** Skip injecting GA4 gtag.js (e.g. you already render the snippet server-side). */
  loadAnalytics?: boolean
  /** Skip injecting GTM (e.g. you already render the snippet server-side). */
  loadContainer?: boolean
  nonce?: string
  /** Payload server origin, e.g. https://cms.example.com. Defaults to the current origin. */
  serverUrl?: string
  shouldCapture?: () => boolean
}

const CONFIG_CACHE_KEY = '__payload_gtm_config'

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '')

/** `${serverUrl}${apiRoute}/${basePath}/config`, honoring a custom API route / basePath. */
export const defaultConfigUrl = (
  serverUrl: string,
  { apiRoute = '/api', basePath = 'gtm' }: Pick<InitGtmOptions, 'apiRoute' | 'basePath'> = {},
): string => {
  const api = trimSlashes(apiRoute)
  return `${serverUrl.replace(/\/+$/, '')}${api ? `/${api}` : ''}/${trimSlashes(basePath)}/config`
}

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
      options.config ??
      (await fetchConfig(options.configUrl ?? defaultConfigUrl(serverUrl, options)))
    const ga = config.analytics
    if (!config.enabled || !(config.containerId || ga?.measurementId)) {
      return () => {}
    }

    const dataLayerName = config.dataLayerName ?? 'dataLayer'
    let stop = () => {}

    // Consent defaults must reach the dataLayer before any Google tag loads.
    if (options.consentDefaults !== false && config.consent) {
      applyConsentDefaults(config.consent, dataLayerName)
    }

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

    if (options.loadContainer !== false && config.containerId) {
      loadGtm({
        containerId: config.containerId,
        dataLayerName,
        environment: config.environment,
        nonce: options.nonce,
      })
    }
    if (options.loadAnalytics !== false && ga?.measurementId) {
      loadGoogleAnalytics({
        dataLayerName,
        debugMode: ga.debugMode,
        measurementId: ga.measurementId,
        nonce: options.nonce,
        sendPageView: ga.sendPageView,
      })
    }
    return stop
  } catch {
    return () => {}
  }
}

/**
 * Sends a GA4 event through `gtag('event', …)`. Use this (not `pushEvent`) when GA4 is
 * loaded directly: gtag.js ignores plain `{event: …}` objects, which only GTM reads.
 * Queues on the dataLayer if gtag.js has not loaded yet. Discovery records it either way.
 */
export const gtagEvent = (
  name: string,
  params: Record<string, unknown> = {},
  dataLayerName = 'dataLayer',
): void => {
  const win = w()
  if (!win) {
    return
  }
  const gtag = win.gtag
  if (typeof gtag === 'function') {
    ;(gtag as (...args: unknown[]) => void)('event', name, params)
    return
  }
  pushArgs(dataLayerName, 'event', name, params)
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
