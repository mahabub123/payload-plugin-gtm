import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [tsconfigPaths({ ignoreConfigErrors: true, projects: [path.resolve(dirname, 'dev/tsconfig.json')] })],
  test: {
    env: {
      DATABASE_URL: `file:${path.join(os.tmpdir(), `payload-gtm-test-${process.pid}-${Date.now()}.db`)}`,
      PAYLOAD_SECRET: 'test-secret',
    },
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 60_000,
    include: ['test/**/*.spec.ts', 'dev/**/*.spec.ts'],
    testTimeout: 30_000,
  },
})
