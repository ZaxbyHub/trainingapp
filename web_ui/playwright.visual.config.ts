import { existsSync } from 'node:fs';
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
 * Run (builds first, so dist/ is never stale or foreign):
 *   npm run test:visual
 * Or, after an up-to-date `npm run build`:
 *   npx playwright test --config playwright.visual.config.ts
 *
 * The overlay text and pixels depend on build-time model-exclusion env
 * (.env.production written by `npm run prepare-models`, see
 * ModelBlockedOverlay.tsx): baselines were taken from a plain `npm run build`
 * WITHOUT staged weights. A build made after prepare-models changes the
 * overlay screenshots; rebuild from a clean state (no .env.production) to compare.
 * Regenerate baselines (only from a known-good UI):
 *   npx playwright test --config playwright.visual.config.ts --update-snapshots
 *
 * Port 4391 is pinned with --strictPort so it never collides with the
 * default e2e harness (4174), desktop (4173) or other local dev servers.
 */
const PORT = 4391;

// Fail fast rather than screenshot whatever (or nothing) dist/ happens to hold.
if (!existsSync('dist/index.html')) {
  throw new Error('web_ui/dist is missing: run `npm run test:visual` (builds first) or `npm run build`.');
}

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
      // Per-pixel color tolerance 0 (default 0.2 hides subtle recolors): unchanged means pixel-identical.
      threshold: 0,
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
