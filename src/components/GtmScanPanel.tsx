'use client'
import { Button, toast, useConfig } from '@payloadcms/ui'
import { useRouter } from 'next/navigation.js'
import { formatAdminURL } from 'payload/shared'
import React, { useCallback, useEffect, useState } from 'react'

import type { ScanSummary } from '../types.js'

type Props = {
  basePath: string
  globalSlug: string
}

const boxStyle: React.CSSProperties = {
  border: '1px solid var(--theme-elevation-150)',
  borderRadius: 'var(--style-radius-m, 4px)',
  marginBottom: 'calc(var(--base) * 1)',
  padding: 'calc(var(--base) * 0.75) calc(var(--base) * 1)',
}

export const GtmScanPanel: React.FC<Props> = ({ basePath, globalSlug }) => {
  const { config } = useConfig()
  const router = useRouter()
  const [busy, setBusy] = useState<'container' | 'crawl' | false>(false)
  const [last, setLast] = useState<null | ScanSummary>(null)
  const [containerId, setContainerId] = useState<null | string>(null)

  const api = (path: string) =>
    formatAdminURL({ apiRoute: config.routes.api, path: path as `/${string}` })

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch(api(`/globals/${globalSlug}?depth=0`), { credentials: 'include' })
      if (!res.ok) {
        return
      }
      const doc = (await res.json()) as { containerId?: string; lastScan?: ScanSummary }
      setLast(doc.lastScan ?? null)
      setContainerId(doc.containerId ?? null)
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalSlug, config.routes.api])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const scan = async (crawl: boolean) => {
    setBusy(crawl ? 'crawl' : 'container')
    try {
      const res = await fetch(api(`/${basePath}/scan`), {
        body: JSON.stringify({ container: true, crawl }),
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      const data = (await res.json()) as { error?: string } & Partial<ScanSummary>
      if (!res.ok) {
        toast.error(data.error ?? data.errors?.[0] ?? `Scan failed (HTTP ${res.status})`)
      } else {
        const created = (data.container?.created ?? 0) + (data.crawl?.created ?? 0)
        const updated = (data.container?.updated ?? 0) + (data.crawl?.updated ?? 0)
        toast.success(`Scan complete: ${created} new, ${updated} updated`)
        if (data.errors?.length) {
          toast.warning(`${data.errors.length} warning(s) — see summary`)
        }
      }
      await loadSettings()
      router.refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={boxStyle}>
      <div
        style={{
          alignItems: 'center',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'calc(var(--base) * 0.5)',
        }}
      >
        <strong style={{ marginRight: 'auto' }}>
          Event discovery{containerId ? ` · ${containerId}` : ' · no container configured'}
        </strong>
        <Button
          buttonStyle="secondary"
          disabled={Boolean(busy)}
          margin={false}
          onClick={() => void scan(false)}
          size="small"
        >
          {busy === 'container' ? 'Scanning…' : 'Scan GTM container'}
        </Button>
        <Button
          buttonStyle="secondary"
          disabled={Boolean(busy)}
          margin={false}
          onClick={() => void scan(true)}
          size="small"
        >
          {busy === 'crawl' ? 'Crawling…' : 'Scan + crawl site'}
        </Button>
        <Button
          buttonStyle="pill"
          el="anchor"
          margin={false}
          size="small"
          url={api(`/${basePath}/export`)}
        >
          Export tracking plan
        </Button>
      </div>
      {last && (
        <div
          style={{
            color: 'var(--theme-elevation-600)',
            fontSize: '0.85em',
            marginTop: 'calc(var(--base) * 0.5)',
          }}
        >
          Last scan {new Date(last.at).toLocaleString()}
          {last.container &&
            ` · container v${last.container.version ?? '?'}: ${last.container.found} trigger events, ${last.container.variables.length} data layer variables`}
          {last.crawl && ` · crawl: ${last.crawl.pages} pages, ${last.crawl.found} events`}
          {last.errors.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary>{last.errors.length} warning(s)</summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {last.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}
          {last.container && last.container.variables.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary>Data layer variables read by the container</summary>
              <code style={{ whiteSpace: 'normal' }}>{last.container.variables.join(', ')}</code>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
