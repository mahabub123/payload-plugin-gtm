'use client'
import { pushEvent } from 'payload-plugin-gtm/react'

declare global {
  interface Window {
    dataLayer: unknown[]
    gtag?: (...args: unknown[]) => void
  }
}

export const DemoButtons = () => (
  <div style={{ display: 'flex', gap: 12 }}>
    <button
      onClick={() =>
        pushEvent('add_to_cart', {
          ecommerce: {
            currency: 'USD',
            items: [{ item_id: 'SKU_1', item_name: 'T-shirt', price: 19.99, quantity: 1 }],
            value: 19.99,
          },
        })
      }
      type="button"
    >
      add_to_cart
    </button>
    <button
      onClick={() => pushEvent('newsletter_signup', { form_id: 'footer', email_opt_in: true })}
      type="button"
    >
      newsletter_signup
    </button>
    <button
      onClick={() => {
        // gtag-style push (arguments object) is captured too
        window.dataLayer = window.dataLayer || []
        // eslint-disable-next-line prefer-rest-params
        function gtag(..._args: unknown[]) {
          window.dataLayer.push(arguments)
        }
        gtag('event', 'video_play', { video_title: 'Intro', video_percent: 0 })
      }}
      type="button"
    >
      gtag video_play
    </button>
  </div>
)
