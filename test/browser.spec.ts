// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  applyConsentDefaults,
  defaultConfigUrl,
  gtagEvent,
  gtagScriptContent,
  initGtm,
  loadGoogleAnalytics,
  loadGtm,
  startDiscovery,
  updateConsent,
} from '../src/browser/index.js'

type Win = Window & { dataLayer: unknown[] }
const win = window as unknown as Win

let bodies: any[] = []

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  bodies = []
  win.dataLayer = []
  globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Promise.resolve(new Response(null, { status: 202 }))
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.useRealTimers()
})

const sentNames = () => bodies.flatMap((b) => b.events.map((e: any) => e.name)).sort()

describe('startDiscovery', () => {
  test('captures pre-existing, pushed and gtag events; skips built-ins and duplicates', async () => {
    win.dataLayer.push({ event: 'gtm.js', 'gtm.start': 1 }, { event: 'early_event', a: 1 })
    const stop = startDiscovery({ endpoint: '/api/gtm/collect', flushDelayMs: 100 })

    win.dataLayer.push({ event: 'add_to_cart', ecommerce: { items: [{ item_id: 'x' }] } })
    win.dataLayer.push({ event: 'add_to_cart', ecommerce: { items: [{ item_id: 'y' }] } }) // same schema
    ;(function gtag(..._args: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      win.dataLayer.push(arguments)
    })('event', 'video_play', { title: 'x' })
    win.dataLayer.push({ userId: 'not an event' })

    await vi.advanceTimersByTimeAsync(200)
    expect(sentNames()).toEqual(['add_to_cart', 'early_event', 'video_play'])
    expect(bodies[0]).toMatchObject({ page: '/', v: 1 })

    // Same schema in the same session is not re-sent; a new schema is
    win.dataLayer.push({ event: 'add_to_cart', ecommerce: { items: [{ item_id: 'z' }] } })
    win.dataLayer.push({ event: 'add_to_cart', value: 5, ecommerce: { items: [{ item_id: 'z' }] } })
    await vi.advanceTimersByTimeAsync(200)
    expect(sentNames()).toEqual(['add_to_cart', 'add_to_cart', 'early_event', 'video_play'])
    stop()
  })

  test('survives GTM replacing push and the array being reassigned', async () => {
    const stop = startDiscovery({ endpoint: '/c', flushDelayMs: 50, pollMs: 100 })
    // Simulate GTM swapping push for its own implementation that doesn't call ours
    win.dataLayer.push = function (this: unknown[], ...items: unknown[]) {
      return Array.prototype.push.apply(this, items)
    }
    win.dataLayer.push({ event: 'after_gtm_wrap' })
    win.dataLayer = [{ event: 'after_reassign' }]
    await vi.advanceTimersByTimeAsync(500)
    expect(sentNames()).toEqual(['after_gtm_wrap', 'after_reassign'])
    stop()
  })

  test('respects ignore list, consent hook and sampling', async () => {
    let consent = false
    const stop = startDiscovery({
      endpoint: '/c',
      flushDelayMs: 50,
      ignore: ['noisy'],
      shouldCapture: () => consent,
    })
    win.dataLayer.push({ event: 'noisy' }, { event: 'before_consent' })
    await vi.advanceTimersByTimeAsync(100)
    expect(bodies).toHaveLength(0)
    consent = true
    win.dataLayer.push({ event: 'after_consent' })
    await vi.advanceTimersByTimeAsync(100)
    expect(sentNames()).toEqual(['after_consent'])
    stop()

    sessionStorage.clear()
    bodies = []
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    const stop2 = startDiscovery({ endpoint: '/c', flushDelayMs: 50, sampleRate: 0.5 })
    win.dataLayer.push({ event: 'unsampled' })
    await vi.advanceTimersByTimeAsync(100)
    expect(bodies).toHaveLength(0)
    stop2()
  })

  test('backs off for the session after 429', async () => {
    globalThis.fetch = vi.fn((_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Promise.resolve(new Response(null, { status: 429 }))
    }) as unknown as typeof fetch
    const stop = startDiscovery({ endpoint: '/c', flushDelayMs: 50 })
    win.dataLayer.push({ event: 'first' })
    await vi.advanceTimersByTimeAsync(100)
    win.dataLayer.push({ event: 'second' })
    await vi.advanceTimersByTimeAsync(100)
    expect(sentNames()).toEqual(['first'])
    stop()
  })

  test('never throws into the host page on hostile dataLayer content', async () => {
    const stop = startDiscovery({ endpoint: '/c', flushDelayMs: 50 })
    const hostile = {}
    Object.defineProperty(hostile, 'event', {
      get: () => {
        throw new Error('boom')
      },
    })
    expect(() => win.dataLayer.push(hostile, { event: 'ok_after' })).not.toThrow()
    await vi.advanceTimersByTimeAsync(1500)
    expect(sentNames()).toEqual(['ok_after'])
    stop()
  })
})

describe('loadGtm', () => {
  test('injects the snippet once', () => {
    expect(loadGtm({ containerId: 'GTM-ABC1234' })).toBe(true)
    expect(loadGtm({ containerId: 'GTM-ABC1234' })).toBe(false)
    expect(document.querySelectorAll('script[data-payload-gtm]')).toHaveLength(1)
  })
})

describe('google analytics', () => {
  test('loadGoogleAnalytics injects the snippet once per ID and defines gtag', () => {
    expect(loadGoogleAnalytics({ measurementId: 'G-LOAD12345' })).toBe(true)
    expect(loadGoogleAnalytics({ measurementId: 'G-LOAD12345' })).toBe(false)
    expect(document.querySelectorAll('script[data-payload-ga="G-LOAD12345"]')).toHaveLength(1)
    expect(document.querySelector('script[src*="gtag/js?id=G-LOAD12345"]')).not.toBeNull()
  })

  test('the gtag snippet defines gtag and queues js/config as arguments objects', () => {
    delete (win as any).gtag
    // jsdom runs injected inline scripts in its own realm, so evaluate the snippet here.
    new Function(gtagScriptContent({ measurementId: 'G-EVAL12345', sendPageView: false }))()
    expect(typeof (win as any).gtag).toBe('function')
    const config = win.dataLayer.find((e: any) => e[0] === 'config') as any
    expect(Array.isArray(config)).toBe(false) // gtag.js ignores real arrays
    expect([config[1], config[2]]).toEqual(['G-EVAL12345', { send_page_view: false }])
    expect(win.dataLayer.some((e: any) => e[0] === 'js')).toBe(true)
  })

  test('initGtm loads GA4 without a GTM container', async () => {
    const before = document.querySelectorAll('script[data-payload-gtm]').length
    await initGtm({
      config: { analytics: { measurementId: 'G-ONLY12345' }, enabled: true },
      discovery: false,
    })
    expect(document.querySelectorAll('script[data-payload-ga="G-ONLY12345"]')).toHaveLength(1)
    expect(document.querySelectorAll('script[data-payload-gtm]')).toHaveLength(before)
  })

  test('gtagEvent is captured by discovery', async () => {
    delete (win as any).gtag
    const stop = startDiscovery({ endpoint: '/c', flushDelayMs: 50 })
    gtagEvent('sign_up', { method: 'email' })
    await vi.advanceTimersByTimeAsync(100)
    expect(sentNames()).toEqual(['sign_up'])
    expect(bodies[0].events[0].params).toEqual([{ path: 'method', type: 'string' }])
    stop()
  })
})

describe('consent mode', () => {
  const argsOf = (e: unknown) => Array.from(e as ArrayLike<unknown>)

  beforeEach(() => {
    delete (win as any).__payload_consent_default
    delete (win as any).gtag
  })

  test('initGtm pushes consent defaults before loading tags', async () => {
    await initGtm({
      config: {
        analytics: { measurementId: 'G-CONS12345' },
        consent: { signals: { analytics_storage: 'denied' }, waitForUpdateMs: 500 },
        enabled: true,
      },
      discovery: false,
    })
    expect(Array.isArray(win.dataLayer[0])).toBe(false) // real arguments object
    expect(argsOf(win.dataLayer[0])).toEqual([
      'consent',
      'default',
      { analytics_storage: 'denied', wait_for_update: 500 },
    ])
    expect(document.querySelector('script[data-payload-ga="G-CONS12345"]')).not.toBeNull()
    // once per page
    expect(applyConsentDefaults({ signals: { analytics_storage: 'denied' } })).toBe(false)
  })

  test('consentDefaults: false leaves defaults to the CMP', async () => {
    await initGtm({
      config: {
        consent: { signals: { ad_storage: 'denied' } },
        containerId: 'GTM-CMP1234',
        enabled: true,
      },
      consentDefaults: false,
      discovery: false,
    })
    expect(win.dataLayer.some((e: any) => e?.[0] === 'consent')).toBe(false)
  })

  test('updateConsent queues an update and is not reported by discovery', async () => {
    const stop = startDiscovery({ endpoint: '/c', flushDelayMs: 50 })
    updateConsent({ analytics_storage: 'granted' })
    updateConsent({ analytics_storage: 'maybe' as never }) // ignored, never throws
    await vi.advanceTimersByTimeAsync(100)
    const updates = win.dataLayer.filter((e: any) => e?.[0] === 'consent').map(argsOf)
    expect(updates).toEqual([['consent', 'update', { analytics_storage: 'granted' }]])
    expect(bodies).toHaveLength(0)
    stop()
  })
})

describe('config URL (P2)', () => {
  test('honors a custom API route and basePath', () => {
    expect(defaultConfigUrl('https://cms.example.com/')).toBe(
      'https://cms.example.com/api/gtm/config',
    )
    expect(
      defaultConfigUrl('https://cms.example.com', { apiRoute: '/cms-api/', basePath: '/t/' }),
    ).toBe('https://cms.example.com/cms-api/t/config')
  })

  test('initGtm fetches the config from the custom path', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn((url: unknown) => {
      urls.push(String(url))
      return Promise.resolve(Response.json({ enabled: false }))
    }) as unknown as typeof fetch
    await initGtm({ basePath: 'track', serverUrl: 'https://cms.example.com' })
    expect(urls).toEqual(['https://cms.example.com/api/track/config'])
  })
})
