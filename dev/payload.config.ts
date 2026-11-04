import { sqliteAdapter } from '@payloadcms/db-sqlite'
import path from 'path'
import { buildConfig } from 'payload'
import { gtmPlugin } from 'payload-plugin-gtm'
import { fileURLToPath } from 'url'

import { seed } from './seed.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

if (!process.env.ROOT_DIR) {
  process.env.ROOT_DIR = dirname
}

export default buildConfig({
  admin: {
    importMap: { baseDir: path.resolve(dirname) },
    user: 'users',
  },
  collections: [
    // A second auth collection (e.g. storefront customers). Its users must NOT be able to
    // change GTM settings or trigger scans with the plugin's default access.
    { slug: 'customers', auth: true, fields: [] },
    {
      slug: 'users',
      auth: true,
      fields: [],
    },
  ],
  db: sqliteAdapter({
    client: { url: process.env.DATABASE_URL || `file:${path.resolve(dirname, 'dev.db')}` },
  }),
  onInit: async (payload) => {
    await seed(payload)
  },
  plugins: [
    gtmPlugin({
      containerId: process.env.GTM_CONTAINER_ID || undefined,
      measurementId: process.env.GA_MEASUREMENT_ID || undefined,
      scanSchedule: process.env.GTM_SCAN_CRON || undefined,
    }),
  ],
  secret: process.env.PAYLOAD_SECRET || 'test-secret_key',
  serverURL: process.env.PAYLOAD_SERVER_URL || undefined,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
})
