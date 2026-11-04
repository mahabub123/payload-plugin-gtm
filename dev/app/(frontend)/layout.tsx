import { GoogleTagManager } from 'payload-plugin-gtm/react'
import React from 'react'

export const metadata = { title: 'payload-plugin-gtm demo' }

export default function FrontendLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', margin: 40 }}>
        {/* Fetches /api/gtm/config, loads GTM and starts dataLayer discovery */}
        <GoogleTagManager />
        {children}
      </body>
    </html>
  )
}
