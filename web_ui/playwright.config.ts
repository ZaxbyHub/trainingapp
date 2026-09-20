import { defineConfig, devices } from '@playwright/test';

/**
 * web_ui browser-mode e2e harness (issue #76, C9 / AC3).
 *
 * Modeled on desktop/playwright.config.ts (issue #67, B9), but this harness
 * exercises the PLAIN-BROWSER surface: Playwright's chromium project against
 * `vite preview` of the production renderer build (dist/), with no Electron
 * shell and no window.desktopApi. The C3 acceptance driver builds the
 * renderer first, then runs e2e/packs-gate.spec.ts (the Option-B capability
 * gate PoC) through this config.
 *
 * Port 4174 is pinned with --strictPort (desktop's Electron harness owns
 * 4173) so a stale server on either port can never satisfy the readiness
 * probe. One worker, no retries, no parallelism: the tests assert IndexedDB
 * storage invariants that are cleanest to observe serially, and each test
 * gets an isolated browser context (and therefore an isolated
 * per-context IndexedDB origin).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm --prefix . run preview -- --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  outputDir: './test-results',
});
