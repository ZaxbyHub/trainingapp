import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Lumen phase-0 visual-baseline harness (docs/design/design-language.md section 6).
 *
 * Opt-in and NOT part of `npm run test:e2e`: the default config
 * (playwright.config.ts) ignores e2e/visual/. Baselines are rendered by
 * Windows chromium, so they are stored per-platform under
 * `e2e/visual/__screenshots__/win32/` (see snapshotPathTemplate). CI (ubuntu) runs
 * only the axe + tooltip-overflow specs from this config (`npm run test:visual:a11y:ci`
 * in the required web-ui-e2e job) and never the pixel spec (lumen-baseline) until
 * Linux baselines are generated deliberately. No updateSnapshots is set, so on another
 * platform the default 'missing' mode fails and writes untracked PNGs under
 * __screenshots__/<platform>/: delete them, never commit them. Runbook: e2e/visual/README.md.
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
// Resolved against this file, not the cwd, so it holds wherever playwright is launched from.
if (!existsSync(fileURLToPath(new URL('./dist/index.html', import.meta.url)))) {
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
