import { defineConfig } from '@playwright/test';

/**
 * Playwright-under-Electron suite (issue #67, B9 / AC1).
 *
 * Transport: the REAL Electron app boots in dev mode against `vite preview`
 * of the production renderer build (webServer below pins --host 127.0.0.1 so
 * the vite-bound address matches ELECTRON_START_URL's origin — the desktop
 * navigation lockdown compares origins literally). The backend runs
 * in-process inside Electron with the deterministic stub engine + hash
 * embedder, so no LLM weights are needed.
 *
 * One exception: desktop-model-gate.spec.ts boots the REAL llama engine against
 * an EMPTY model directory (still no weights: the engine loads lazily) so the
 * desktop model gate renders (PR #151 review PRR-151-028).
 *
 * No Playwright browser download is required: _electron drives the Electron
 * binary already present in desktop/node_modules.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm --prefix ../web_ui run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  outputDir: './test-results',
});
