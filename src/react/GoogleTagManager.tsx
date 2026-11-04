'use client'
import { useEffect } from 'react'

import type { InitGtmOptions, PublicGtmConfig } from '../browser/index.js'

import { gtmNoscriptUrl, initGtm } from '../browser/index.js'

export type GoogleTagManagerProps = {
  /**
   * Pre-resolved config (e.g. from `getGtmSettings(payload)` in a server component).
   * When omitted, the component fetches `/api/gtm/config` from `serverUrl`.
   */
  config?: PublicGtmConfig
} & Omit<InitGtmOptions, 'config'>

/**
 * Drop-in GTM loader with automatic dataLayer discovery.
 *
 * @example
 * // app/layout.tsx
 * <body>
 *   <GoogleTagManager serverUrl={process.env.NEXT_PUBLIC_PAYLOAD_URL} />
 *   {children}
 * </body>
 */
export const GoogleTagManager = ({ config, ...options }: GoogleTagManagerProps) => {
  const { configUrl, discovery, loadContainer, nonce, serverUrl } = options

  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void initGtm({ ...options, config }).then((s) => {
      if (cancelled) {
        s()
      } else {
        stop = s
      }
    })
    return () => {
      cancelled = true
      stop?.()
    }
    // Re-init only when identity-relevant inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.containerId, configUrl, discovery, loadContainer, nonce, serverUrl])

  if (!config?.enabled || !config.containerId || loadContainer === false) {
    return null
  }

  return (
    <noscript>
      {/* Official GTM noscript fallback; a sandbox would break it. */}
      {/* eslint-disable-next-line @eslint-react/dom/no-missing-iframe-sandbox */}
      <iframe
        height="0"
        src={gtmNoscriptUrl({ containerId: config.containerId, environment: config.environment })}
        style={{ display: 'none', visibility: 'hidden' }}
        title="Google Tag Manager"
        width="0"
      />
    </noscript>
  )
}
