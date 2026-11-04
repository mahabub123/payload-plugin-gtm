# payload-plugin-gtm

Google Tag Manager for **Payload CMS v3**, with **automatic dataLayer event discovery**.

The plugin installs GTM on your site and finds every event your site emits. Those events go into an editable **event registry** in the Payload admin, which works as a living tracking plan.

Events are discovered from three sources, because none of them is complete on its own:

| Source | How | Finds |
| --- | --- | --- |
| **Runtime** (browser) | Hooks `window.dataLayer`, including `gtag('event', …)`, and reports each event's name and parameter **schema** | Everything real visitors trigger, with full parameter paths and types (`ecommerce.items[].item_id: string`) |
| **GTM container** (server) | Fetches your published `gtm.js` and parses it | Every Custom Event trigger (regex triggers expanded), the GA4/other tags each one fires, and all Data Layer Variables. No traffic needed |
| **Page crawl** (server) | Crawls same-origin pages and `sitemap.xml`, plus their scripts | `dataLayer.push({event: …})` and `gtag('event', …)` literals in your code |

Privacy by default: parameter **values are not stored**. Only names, key paths and types are kept. Optional examples are redacted (emails, phone/card-like numbers, tokens) and truncated.

> Design document: [docs/architecture/payload-plugin-gtm-system-design.md](docs/architecture/payload-plugin-gtm-system-design.md)

---

## Install

```bash
pnpm add payload-plugin-gtm
```

```ts
// payload.config.ts
import { gtmPlugin } from 'payload-plugin-gtm'

export default buildConfig({
  // ...
  plugins: [
    gtmPlugin({
      containerId: 'GTM-ABC1234', // optional default; editable in the admin
      scanSchedule: '0 3 * * *', // optional: daily container scan via Payload jobs
    }),
  ],
})
```

Then:

```bash
pnpm payload generate:importmap   # registers the admin "Scan" panel
pnpm payload migrate:create gtm   # Postgres/SQLite: creates the gtm-events / gtm-settings tables
```

### Add GTM and discovery to your website

**React / Next.js**

```tsx
// app/(frontend)/layout.tsx
import { GoogleTagManager } from 'payload-plugin-gtm/react'

export default function Layout({ children }) {
  return (
    <html>
      <body>
        <GoogleTagManager serverUrl={process.env.NEXT_PUBLIC_PAYLOAD_URL} />
        {children}
      </body>
    </html>
  )
}
```

To skip the config request, resolve the config on the server instead:

```tsx
import { getPayload } from 'payload'
import config from '@payload-config'
import { getGtmPublicConfig } from 'payload-plugin-gtm'
import { GoogleTagManager } from 'payload-plugin-gtm/react'

const payload = await getPayload({ config })
const gtm = await getGtmPublicConfig(payload)
// ...
<GoogleTagManager config={gtm} serverUrl={process.env.NEXT_PUBLIC_PAYLOAD_URL} />
```

**Any framework / plain JS**

```ts
import { initGtm } from 'payload-plugin-gtm/browser'

initGtm({ serverUrl: 'https://cms.example.com' })
```

The browser runtime is about 3.2 KB min+gzip. It never throws into your page, and it sends with `fetch(keepalive)` or `sendBeacon` on page hide.

Lower-level APIs: `loadGtm()`, `startDiscovery()`, `gtmScriptContent()` (for SSR `<script>` tags), `gtmNoscriptUrl()`, and `pushEvent()`.

---

## Admin

Everything appears under **Google Tag Manager** in the admin sidebar:

- **Data Layer Events.** The registry. Discovery fills the read-only fields: parameters, sources, pages, fired tags, occurrences, and first/last seen. **You** own `status` (discovered → approved / deprecated / ignored), `description`, `owner`, `notes`, and per-parameter descriptions. Discovery never overwrites these.
  - Above the list there is a panel with **Scan GTM container**, **Scan + crawl site**, and **Export tracking plan** (JSON). It also shows the last-scan summary and the Data Layer Variables the container reads.
  - Marking an event **ignored** stops browsers from reporting it.
- **GTM Settings.** Holds the container ID, GTM environment (`gtm_auth` / `gtm_preview`), dataLayer name, discovery settings (enable, sample rate, built-in `gtm.*` events, example capture, allowed origins), and crawl settings (site URL, sitemap, extra URLs).

## REST endpoints

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/gtm/config` | public | Runtime config for the website (cached 60 s) |
| POST | `/api/gtm/collect` | public | Discovery beacon: validated, rate limited, deduplicated |
| POST | `/api/gtm/scan` | `access.scan` | `{ container?: boolean, crawl?: boolean }` |
| GET | `/api/gtm/export` | `access.scan` | Tracking plan JSON |

The job task `gtmScan` (input `{ crawl?: boolean }`) is registered for scheduled or queued scans.

## Options

```ts
gtmPlugin({
  containerId?: string             // default container (the settings global overrides it)
  disabled?: boolean               // keeps the schema, removes endpoints, UI and job
  collectionSlug?: string          // 'gtm-events'
  globalSlug?: string              // 'gtm-settings'
  basePath?: string                // 'gtm' → /api/gtm/*; change it if adblockers block it
  adminGroup?: string              // 'Google Tag Manager'
  access?: { read, update, delete, updateSettings, scan }
  discovery?: {
    maxEvents?: number             // 500: registry cap (protects against spam and dynamic names)
    maxNewEventsPerHour?: number   // 100: new names from runtime/crawl per hour, across all instances
    rateLimitPerMinute?: number    // 30 per IP for the built-in (in-memory) limiter
    rateLimiter?: { take(key, req): boolean | Promise<boolean> } // shared limiter, e.g. Redis
    getClientIp?: (req) => string  // how a client is identified for rate limiting
    writeIntervalMs?: number       // 300000: max one write per event per interval when nothing is new
    dedupeWindowMs?: number        // 60000: skip identical observations on this instance
  }
  crawl?: { maxPages?: 25, maxScripts?: 30, timeoutMs?: 10000 }
  scanSchedule?: string            // cron, e.g. '0 3 * * *'
  scanQueue?: string               // 'default'
  cacheSeconds?: number            // 30: settings cache
  overrideCollection?: (c) => c    // add fields, tenant scoping, hooks…
  overrideGlobal?: (g) => g
})
```

## Security notes

- **Collect endpoint protections:**
  - 32 KB body cap, 50 events per batch, 100 parameters per event
  - strict name/path patterns (so markup can never reach the admin)
  - per-IP token bucket
  - origin allow-list (falls back to the Payload `serverURL` origin)
  - registry cap
  - server-side re-validation and re-redaction of everything the browser sends
- **REST `create` on the events collection is always denied.** Events are created only by discovery.
- **Restricted outbound fetches.** Container scans only fetch from `https://www.googletagmanager.com`. The crawl only fetches the configured site's origin; redirects are re-checked, and every fetch has timeouts and byte caps.
- **Client IP.** The default uses `cf-connecting-ip`, then `x-real-ip`, then the *last* `x-forwarded-for` entry (the one your proxy added; the first is client-controlled). Override `discovery.getClientIp` if your setup differs.

## Running on several instances or serverless

The plugin's shared state lives in the database, so it is safe with any number of instances:

- **Merges are locked per event.** Every registry update runs under a short database lease (a row with a unique key in the hidden `gtm-events-locks` collection), so two requests can't overwrite each other's parameters or pages. This works the same on Postgres, SQLite and MongoDB.
- **One scan at a time, everywhere.** Scans take a `scan` lease, so a schedule plus a manual click (or two instances running the job) don't scan twice. Leases expire on their own if an instance crashes.
- **New names are capped per hour in the database** (`maxNewEventsPerHour`), so junk posted to the public endpoint can't fill the registry quickly from any number of instances.
- **Fewer writes.** Observations that add nothing new are counted in memory and written at most once per `writeIntervalMs` per event, so steady traffic mostly costs a single read.

What stays per instance: the built-in rate limiter, the dedupe window and the settings cache (`cacheSeconds`). For one global rate limit, pass a shared limiter:

```ts
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

const ratelimit = new Ratelimit({ limiter: Ratelimit.slidingWindow(30, '1 m'), redis: Redis.fromEnv() })

gtmPlugin({
  discovery: {
    rateLimiter: { take: async (ip) => (await ratelimit.limit(`gtm:${ip}`)).success },
  },
})
```

If the shared limiter throws, the plugin falls back to the in-memory one instead of opening the endpoint up.

`occurrences` stays approximate: in-memory counts that haven't been written yet are lost if an instance stops. Use GA4 for real counts.

**Upgrading from 0.1.x:** this version adds the `gtm-events-locks` collection and an index on `firstSeenAt`. On Postgres or SQLite with migrations, run `payload migrate:create` and `payload migrate` after upgrading.

## Troubleshooting

- **No runtime events arrive.**
  - Check that `GET /api/gtm/config` returns `discovery.enabled: true`.
  - Check that the site's origin is in **Allowed origins** when the site and CMS live on different origins.
  - Check that an adblocker isn't blocking `/api/gtm/*`; if it is, change `basePath`.
- **Scan says "not found or not published".** The container ID is wrong, or the container has never been published. For an environment, set `gtm_auth`/`gtm_preview`.
- **Regex trigger "could not be expanded".** Open-ended regexes (such as `.*_error`) can't be turned into a finite list of names. Runtime discovery will still record the actual events.

## Development

```bash
pnpm install
cp dev/.env.example dev/.env
pnpm dev            # http://localhost:3000 (demo page) and /admin (dev@payloadcms.com / test)
pnpm test           # unit + browser (jsdom) + integration (Payload on SQLite)
pnpm typecheck
pnpm build
```

Compatibility: Payload `^3.80` (developed against 3.92.1), Node ≥ 20.9.
