// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { loadGtm, startDiscovery } from '../src/browser/index.js'

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
