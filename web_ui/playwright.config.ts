import { defineConfig, devices } from '@playwright/test';

/**
 * web_ui browser-mode e2e harness (issue #76; browser packs per ADR-0012).
 *
 * Modeled on desktop/playwright.config.ts (issue #67, B9), but this harness
 * exercises the PLAIN-BROWSER surface: Playwright's chromium project against
 * `vite preview` of the production renderer build (dist/), with no Electron
 * shell and no window.desktopApi. `npm run test:e2e` builds the renderer
 * first, then runs e2e/packs-browser.spec.ts (browser Knowledge Pack install
 * and course playback on the player origin) through this config. The app
 * runs on 127.0.0.1, so the course player origin is the localhost alias of
 * the same preview server.
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
  // Lumen visual specs live under e2e/visual and run only through
  // playwright.visual.config.ts. CI runs the a11y subset there (axe, tooltip-overflow,
  // doc-row-reflow, doc-list-scroll: npm run test:visual:a11y:ci); the screenshot spec is a manual Windows gate
  // (e2e/visual/README.md). Never run them in this default harness.
  testIgnore: ['**/visual/**'],
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
