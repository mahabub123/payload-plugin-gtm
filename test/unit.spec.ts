import { describe, expect, test } from 'vitest'

import {
  consentScriptContent,
  gtagScriptContent,
  gtmNoscriptUrl,
  gtmScriptContent,
} from '../src/browser/index.js'
import { resolveOptions } from '../src/index.js'
import { resolveSettings } from '../src/lib/settings.js'
import { isOriginAllowed } from '../src/endpoints/index.js'
import { expandSimpleRegex, parseContainer } from '../src/lib/containerParser.js'
import {
  extractEventNames,
  extractScriptSrcs,
  extractSitemapLocs,
  safeFetchText,
} from '../src/lib/crawler.js'
import { createRateLimiter, createTtlSet } from '../src/lib/rateLimit.js'
import { buildEventData, MAX_PAGES } from '../src/lib/registry.js'
import {
  entryToEvent,
  eventSignature,
  flattenParams,
  redactExample,
  sanitizeBatch,
  sanitizePage,
} from '../src/shared/normalize.js'
import { GTM_JS_FIXTURE } from './fixtures/gtmContainer.js'

describe('normalize', () => {
  test('flattens nested objects and arrays into typed paths', () => {
    const params = flattenParams({
      ecommerce: {
        currency: 'USD',
        items: [
          { item_id: 'A', price: 1 },
          { coupon: null, item_id: 'B' },
        ],
        value: 10,
      },
      event: 'purchase',
      eventCallback: () => {},
      'gtm.uniqueEventId': 5,
    })
    const pairs = params.map((p) => `${p.path}:${p.type}`).sort()
    expect(pairs).toEqual([
      'ecommerce.currency:string',
      'ecommerce.items:array',
      'ecommerce.items[].coupon:null',
      'ecommerce.items[].item_id:string',
      'ecommerce.items[].price:number',
      'ecommerce.items[]:object',
      'ecommerce.value:number',
      'ecommerce:object',
    ])
    expect(params.every((p) => p.example === undefined)).toBe(true)
  })

  test('caps depth and ignores prototype keys', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }
    const paths = flattenParams(deep).map((p) => p.path)
    expect(paths).not.toContain('a.b.c.d.e.f.g')
    const evil = JSON.parse('{"__proto__": {"x": 1}, "ok": 1}') as Record<string, unknown>
    expect(flattenParams(evil).map((p) => p.path)).toEqual(['ok'])
  })

  test('converts object pushes and gtag arguments; rejects non-events', () => {
    expect(entryToEvent({ event: 'sign_up', method: 'google' })).toEqual({
      name: 'sign_up',
      params: [{ type: 'string', path: 'method' }],
    })
    const args = (function (..._a: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      return arguments
    })('event', 'video_play', { video_title: 'Intro' })
    expect(entryToEvent(args)?.name).toBe('video_play')
    const configArgs = (function (..._a: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      return arguments
    })('config', 'G-XXXX')
    expect(entryToEvent(configArgs)).toBeNull()
    expect(entryToEvent({ userId: '1' })).toBeNull()
    expect(entryToEvent({ event: '<img src=x onerror=alert(1)>' })).toBeNull()
    expect(entryToEvent('x')).toBeNull()
  })

  test('redacts PII and truncates examples', () => {
    expect(redactExample('contact me at jane.doe+1@example.com')).toBe('contact me at [email]')
    expect(redactExample('+1 (555) 123-4567')).toBe('[number]')
    expect(redactExample('4111 1111 1111 1111')).toBe('[number]')
    expect(redactExample('tok_abcdefghijklmnopqrstuvwxyz123')).toBe('[token]')
    expect(redactExample('x'.repeat(300))!.length).toBeLessThanOrEqual(101)
    expect(redactExample({ a: 1 })).toBeUndefined()
  })

  test('signature is order independent', () => {
    const a = {
      name: 'e',
      params: [
        { type: 'string' as const, path: 'a' },
        { type: 'number' as const, path: 'b' },
      ],
    }
    const b = {
      name: 'e',
      params: [
        { type: 'number' as const, path: 'b' },
        { type: 'string' as const, path: 'a' },
      ],
    }
    expect(eventSignature(a)).toBe(eventSignature(b))
  })

  test('sanitizePage strips query and rejects junk', () => {
    expect(sanitizePage('/shop/item?id=5&email=a@b.c#x')).toBe('/shop/item')
    expect(sanitizePage('https://evil.com')).toBeUndefined()
    expect(sanitizePage('/<script>')).toBeUndefined()
  })

  test('sanitizeBatch validates and strips examples unless allowed', () => {
    const raw = {
      events: [
        {
          name: 'ok_event',
          params: [
            { example: 'a@b.com', path: 'x', type: 'string' },
            { path: 'bad path!', type: 'string' },
            { path: 'y', type: 'weird' },
          ],
        },
        { name: '<bad>', params: [] },
        null,
      ],
      page: '/p?q=1',
      v: 1,
    }
    const res = sanitizeBatch(raw, { captureExamples: false })
    expect(res.ok).toBe(true)
    if (!res.ok) {
      return
    }
    expect(res.rejected).toBe(2)
    expect(res.payload.page).toBe('/p')
    expect(res.payload.events[0]!.params).toEqual([{ type: 'string', path: 'x' }])

    const withExamples = sanitizeBatch(raw, { captureExamples: true })
    expect(withExamples.ok && withExamples.payload.events[0]!.params[0]!.example).toBe('[email]')

    expect(sanitizeBatch({ events: [], v: 2 }, { captureExamples: false }).ok).toBe(false)
    expect(
      sanitizeBatch({ events: new Array(51).fill({ name: 'a' }), v: 1 }, { captureExamples: false })
        .ok,
    ).toBe(false)
  })
})

describe('container parser', () => {
  test('expands simple regexes and rejects open-ended ones', () => {
    expect(
      expandSimpleRegex('^(file_download|(email_|social_|telephone_)?click)$')?.sort(),
    ).toEqual(['click', 'email_click', 'file_download', 'social_click', 'telephone_click'].sort())
    expect(expandSimpleRegex('^(?:a|b)\\.c$')).toEqual(['a.c', 'b.c'])
    expect(expandSimpleRegex('.*_error$')).toBeNull()
    expect(expandSimpleRegex('^a+$')).toBeNull()
    expect(expandSimpleRegex('^\\d$')).toBeNull()
    expect(expandSimpleRegex('purchase')).toBeNull() // unanchored
  })

  test('extracts custom-event triggers, fired tags and variables', () => {
    const parsed = parseContainer(GTM_JS_FIXTURE)
    expect(parsed.version).toBe('42')
    expect(parsed.variables).toEqual(['ecommerce.value', 'form_id'])

    const byName = Object.fromEntries(parsed.events.map((e) => [e.name, e]))
    expect(Object.keys(byName).sort()).toEqual(
      [
        'click',
        'email_click',
        'file_download',
        'form_',
        'gtm.js',
        'purchase',
        'sign_up',
        'social_click',
      ].sort(),
    )
    expect(byName.purchase!.firesTags).toEqual([
      { ga4EventName: 'purchase', tagId: '10', tagType: 'gaawe' },
      { tagId: '13', tagType: 'awct' },
    ])
    expect(byName.form_!.matchType).toBe('startsWith')
    expect(byName.click!.firesTags).toEqual([{ tagId: '12', tagType: 'gaawe' }])
    expect(byName.sign_up!.firesTags).toEqual([])
    expect(parsed.patterns).toEqual([{ matchType: 'regex', pattern: '.*_error$' }])
  })

  test('throws a clear error for non-container input', () => {
    expect(() => parseContainer('console.log("hi")')).toThrow(/Could not find container data/)
    expect(() => parseContainer('var data = {"resource": [broken')).toThrow()
  })
})

describe('crawler', () => {
  test('extracts dataLayer and gtag events near anchors only', () => {
    const src = `
      window.dataLayer = window.dataLayer || [];
      dataLayer.push({ event: 'begin_checkout', value: 3 });
      window.dataLayer.push({"event":"login"});
      gtag('event', 'share', { method: 'x' });
      ${'x'.repeat(5000)}
      someOtherLib.emit({ event: 'not_a_datalayer_event' });
    `
    expect(extractEventNames(src).sort()).toEqual(['begin_checkout', 'login', 'share'])
    const minified = 'a.dataLayer.push({event:"add_to_wishlist",items:[]})'
    expect(extractEventNames(minified)).toEqual(['add_to_wishlist'])
    expect(extractEventNames('myLayer.push({event:"x1"})', 'myLayer')).toEqual(['x1'])
  })

  test('extracts same-origin script srcs and sitemap locs', () => {
    const html = `<script src="/_next/static/a.js"></script><script async src="https://cdn.other.com/b.js"></script><script src="https://site.com/c.js?x=1&amp;y=2"></script>`
    expect(extractScriptSrcs(html, 'https://site.com/page')).toEqual([
      'https://site.com/_next/static/a.js',
      'https://site.com/c.js?x=1&y=2',
    ])
    expect(
      extractSitemapLocs(
        '<urlset><url><loc> https://site.com/a </loc></url><url><loc>https://site.com/b?x=1&amp;y=2</loc></url></urlset>',
      ),
    ).toEqual(['https://site.com/a', 'https://site.com/b?x=1&y=2'])
  })

  test('safeFetchText blocks cross-origin requests and redirects (SSRF)', async () => {
    const calls: string[] = []
    const fetchImpl = (url: string) => {
      calls.push(url)
      return Promise.resolve(
        new Response(null, {
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
          status: 302,
        }),
      )
    }
    await expect(
      safeFetchText('https://site.com/', {
        allowedOrigin: 'https://site.com',
        fetchImpl,
        maxBytes: 100,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/Blocked cross-origin/)
    expect(calls).toEqual(['https://site.com/'])
    await expect(
      safeFetchText('https://evil.com/', {
        allowedOrigin: 'https://site.com',
        fetchImpl,
        maxBytes: 100,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/Blocked cross-origin/)
    await expect(
      safeFetchText('file:///etc/passwd', {
        allowedOrigin: 'https://site.com',
        fetchImpl,
        maxBytes: 100,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/Blocked protocol/)
  })

  test('safeFetchText caps response size', async () => {
    const fetchImpl = () => Promise.resolve(new Response('a'.repeat(100_000)))
    const { text } = await safeFetchText('https://site.com/', {
      allowedOrigin: 'https://site.com',
      fetchImpl,
      maxBytes: 1000,
      timeoutMs: 1000,
    })
    expect(text.length).toBe(1000)
  })
})

describe('registry merge', () => {
  test('creates new documents with discovery fields', () => {
    const data = buildEventData(
      null,
      {
        name: 'purchase',
        page: '/thanks',
        params: [{ type: 'number', path: 'value' }],
        source: 'runtime',
      },
      new Date('2026-01-01T00:00:00Z'),
    )
    expect(data).toMatchObject({
      eventName: 'purchase',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      occurrences: 1,
      pages: [{ path: '/thanks' }],
      parameters: [{ path: 'value', types: ['number'] }],
      sources: ['runtime'],
      status: 'discovered',
    })
  })

  test('merges without touching editor-owned fields (INV-02)', () => {
    const existing = {
      id: 1,
      description: 'Editor text',
      eventName: 'purchase',
      occurrences: 4,
      pages: Array.from({ length: MAX_PAGES }, (_, i) => ({ path: `/p${i}` })),
      parameters: [
        { description: 'Order value', id: 'row1', path: 'value', types: ['number' as const] },
      ],
      sources: ['container' as const],
      status: 'approved' as const,
    }
    const data = buildEventData(existing, {
      name: 'purchase',
      page: '/new',
      params: [
        { type: 'string', path: 'value' },
        { type: 'string', path: 'currency' },
      ],
      source: 'runtime',
    })
    expect(data).not.toHaveProperty('status')
    expect(data).not.toHaveProperty('description')
    expect(data).not.toHaveProperty('eventName')
    expect(data.occurrences).toBe(5)
    expect(data.sources).toEqual(['container', 'runtime'])
    expect(data.parameters).toEqual([
      { example: undefined, path: 'currency', types: ['string'] },
      { description: 'Order value', id: 'row1', path: 'value', types: ['number', 'string'] },
    ])
    const pages = data.pages as { path: string }[]
    expect(pages).toHaveLength(MAX_PAGES)
    expect(pages.at(-1)!.path).toBe('/new')
  })
})

describe('rate limiting & dedupe', () => {
  test('token bucket allows burst then refills', () => {
    const rl = createRateLimiter({ burst: 2, perMinute: 60 })
    expect(rl.take('ip', 0)).toBe(true)
    expect(rl.take('ip', 0)).toBe(true)
    expect(rl.take('ip', 0)).toBe(false)
    expect(rl.take('ip', 1000)).toBe(true)
    expect(rl.take('other', 0)).toBe(true)
  })

  test('ttl set', () => {
    const s = createTtlSet(1000)
    expect(s.seenRecently('a', 0)).toBe(false)
    expect(s.seenRecently('a', 500)).toBe(true)
    expect(s.seenRecently('a', 1600)).toBe(false)
  })

  test('origin policy', () => {
    expect(isOriginAllowed('https://a.com', ['https://a.com'], null)).toBe(true)
    expect(isOriginAllowed('https://b.com', ['https://a.com'], null)).toBe(false)
    expect(isOriginAllowed('https://b.com', [], 'https://cms.a.com')).toBe(false)
    expect(isOriginAllowed('https://b.com', [], null)).toBe(true)
    expect(isOriginAllowed(null, ['https://a.com'], null)).toBe(true)
  })
})

describe('snippet', () => {
  test('renders the standard snippet and validates inputs (no injection)', () => {
    const js = gtmScriptContent({ containerId: 'GTM-ABC1234' })
    expect(js).toContain("'dataLayer','GTM-ABC1234'")
    expect(js).toContain('https://www.googletagmanager.com')
    expect(() => gtmScriptContent({ containerId: "GTM-1');alert(1)//" })).toThrow()
    expect(() => gtmScriptContent({ containerId: 'GTM-ABC1234', dataLayerName: 'a;b' })).toThrow()
    expect(() =>
      gtmScriptContent({
        containerId: 'GTM-ABC1234',
        environment: { auth: "x';alert(1);'", preview: 'env-5' },
      }),
    ).toThrow(/environment/)
    const env = gtmScriptContent({
      containerId: 'GTM-ABC1234',
      environment: { auth: 'aB3_x-Y', preview: 'env-5' },
    })
    expect(env).toContain('gtm_auth=aB3_x-Y&gtm_preview=env-5')
    expect(gtmNoscriptUrl({ containerId: 'GTM-ABC1234' })).toBe(
      'https://www.googletagmanager.com/ns.html?id=GTM-ABC1234',
    )
  })
})

describe('google analytics', () => {
  test('renders the gtag.js snippet and validates inputs (no injection)', () => {
    const js = gtagScriptContent({ measurementId: 'G-ABC123XYZ9' })
    expect(js).toContain("'dataLayer','G-ABC123XYZ9'")
    expect(js).toContain("'/gtag/js?id='")
    expect(js).toContain("g('config',i,{})")
    expect(js).not.toContain('debug_mode')
    const custom = gtagScriptContent({
      dataLayerName: 'myLayer',
      debugMode: true,
      measurementId: 'G-ABC123XYZ9',
      sendPageView: false,
    })
    expect(custom).toContain('{"send_page_view":false,"debug_mode":true}')
    expect(custom).toContain("'myLayer','G-ABC123XYZ9'")
    expect(() => gtagScriptContent({ measurementId: "G-1');alert(1)//" })).toThrow()
    expect(() => gtagScriptContent({ measurementId: 'UA-12345-1' })).toThrow()
    expect(() =>
      gtagScriptContent({ dataLayerName: 'a;b', measurementId: 'G-ABC123XYZ9' }),
    ).toThrow()
  })

  test('settings: global value wins over the code default', () => {
    const options = resolveOptions({ measurementId: 'G-DEFAULT1' })
    expect(resolveSettings({}, options).analytics).toEqual({
      debugMode: false,
      measurementId: 'G-DEFAULT1',
      sendPageView: true,
    })
    expect(
      resolveSettings({ analytics: { measurementId: 'G-SAVED123', sendPageView: false } }, options)
        .analytics,
    ).toEqual({ debugMode: false, measurementId: 'G-SAVED123', sendPageView: false })
  })
})

describe('review fixes', () => {
  test('G2: nonce reaches the dynamically loaded gtm.js / gtag.js script', () => {
    const nonce = 'abc123XYZ+/='
    expect(gtmScriptContent({ containerId: 'GTM-ABC1234', nonce })).toContain(
      `j.setAttribute('nonce',"${nonce}")`,
    )
    expect(gtagScriptContent({ measurementId: 'G-ABC123XYZ9', nonce })).toContain(
      `j.setAttribute('nonce',"${nonce}")`,
    )
    expect(gtmScriptContent({ containerId: 'GTM-ABC1234' })).not.toContain('nonce')
    expect(() =>
      gtagScriptContent({ measurementId: 'G-ABC123XYZ9', nonce: `x");alert(1)//` }),
    ).toThrow(/nonce/)
  })

  test('G1: consent default snippet is validated', () => {
    const js = consentScriptContent({
      regions: ['DE', 'US-CA'],
      signals: { ad_storage: 'denied', analytics_storage: 'denied' },
      waitForUpdateMs: 500,
    })
    expect(js).toContain(
      `('consent','default',{"ad_storage":"denied","analytics_storage":"denied","wait_for_update":500,"region":["DE","US-CA"]})`,
    )
    expect(() => consentScriptContent({ signals: { analytics_storage: 'yes' as never } })).toThrow()
    expect(() => consentScriptContent({ signals: {} })).toThrow()
    expect(() =>
      consentScriptContent({ regions: ['de");x("'], signals: { ad_storage: 'denied' } }),
    ).toThrow(/region/)
    expect(() =>
      consentScriptContent({ signals: { ad_storage: 'denied' }, waitForUpdateMs: 1e9 }),
    ).toThrow()
  })

  test('G1: consent settings fail closed and drop bad regions', () => {
    const c = resolveSettings(
      {
        consent: {
          adStorage: 'granted',
          analyticsStorage: 'weird' as never,
          enabled: true,
          regions: ['de', 'bad region'],
        },
      },
      resolveOptions(),
    ).consent
    expect(c).toEqual({
      enabled: true,
      regions: ['DE'],
      signals: {
        ad_personalization: 'denied',
        ad_storage: 'granted',
        ad_user_data: 'denied',
        analytics_storage: 'denied',
      },
      waitForUpdateMs: 500,
    })
  })

  test('G3: bad code defaults fail at boot; bad stored IDs are never served', () => {
    expect(() => resolveOptions({ measurementId: 'UA-12345-1' })).toThrow(/measurementId/)
    expect(() => resolveOptions({ containerId: 'GTM-' })).toThrow(/containerId/)
    expect(resolveOptions({ measurementId: ' g-abc12345 ' }).measurementId).toBe('G-ABC12345')
    const s = resolveSettings(
      { analytics: { measurementId: 'UA-1-1' }, containerId: 'nope' },
      resolveOptions({ measurementId: 'G-DEFAULT1' }),
    )
    expect(s.analytics.measurementId).toBe('G-DEFAULT1')
    expect(s.containerId).toBeUndefined()
  })
})
