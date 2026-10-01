import { defineConfig, devices } from '@playwright/test';

/**
 * Lumen phase-0 visual-baseline harness (design-language.md section 6).
 *
 * Opt-in and NOT part of `npm run test:e2e`: the default config
 * (playwright.config.ts) ignores e2e/visual/. Baselines are rendered by
 * Windows chromium, so they are stored per-platform (`-win32` suffix, see
 * snapshotPathTemplate) and CI (ubuntu) never runs this config until Linux
 * baselines are generated deliberately.
 *
 * Run (after `npm run build`):
 *   npx playwright test --config playwright.visual.config.ts
 * Regenerate baselines (only from a known-good UI):
 *   npx playwright test --config playwright.visual.config.ts --update-snapshots
 *
 * Port 4391 is pinned with --strictPort so it never collides with the
 * default e2e harness (4174), desktop (4173) or other local dev servers.
 */
const PORT = 4391;

export default defineConfig({
  testDir: './e2e/visual',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0,
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 },
    },
  ],
  webServer: {
    command: `npm --prefix . run preview -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  outputDir: './test-results/visual',
});
