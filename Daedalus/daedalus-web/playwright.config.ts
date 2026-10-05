import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Browser end-to-end config (PLAN.md Phase 8 Testing).
 *
 * `channel: 'chrome'` drives the Chrome already installed on this machine, so
 * no Playwright-managed browser download is needed.
 *
 * Two servers come up for the run:
 *  - the scripted gateway (fixed event sequence, no LLM involved)
 *  - the Vite dev server, which proxies /tasks /health /workspace to it
 *
 * Commands use absolute paths and the local vite binary rather than `npx`, so
 * the webServer health checks do not depend on npx resolution or a warm cache.
 */
const here = dirname(fileURLToPath(import.meta.url))
const gatewayPort = Number(process.env.DAEDALUS_E2E_PORT ?? 3099)
const webPort = Number(process.env.DAEDALUS_E2E_WEB_PORT ?? 5199)
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`
const webUrl = `http://127.0.0.1:${webPort}`

// Workers import this file too, so the specs read the same gateway the
// webServer block below starts rather than a hardcoded port.
process.env.DAEDALUS_E2E_GATEWAY_URL = gatewayUrl

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 45_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: webUrl,
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: `node ${resolve(here, 'e2e/scripted-gateway.mjs')} ${gatewayPort}`,
      url: `${gatewayUrl}/health`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 30_000,
    },
    {
      command: `node ${resolve(here, 'node_modules/vite/bin/vite.js')} --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: webUrl,
      reuseExistingServer: false,
      // The browser talks straight to the scripted gateway instead of going
      // through the vite /tasks proxy. The gateway sends permissive CORS, and
      // this removes the WS proxy from the equation — it was dropping the
      // upgrade and silently stranding the event stream.
      env: { VITE_DAEDALUS_API: gatewayUrl, DAEDALUS_SERVER: gatewayUrl },
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 90_000,
    },
  ],
})