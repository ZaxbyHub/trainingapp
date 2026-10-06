import { defineConfig, devices } from '@playwright/test';

/**
 * Manual-only harness for e2e/frame-input/frame-input.repro.ts (lane I, PRR-151-030
 * follow-up). Not used by CI or by web_ui/playwright.config.ts (whose default
 * testMatch only picks *.spec.ts / *.test.ts). The repro serves its own pages; there
 * is no webServer here. From web_ui/:
 *
 *   npx playwright test --config e2e/frame-input/repro.config.ts --project chromium --project firefox --project firefox-no-fission
 *   npx playwright test --config e2e/frame-input/repro.config.ts --project moz-firefox --project moz-firefox-no-fission
 *
 * Projects:
 *   - chromium, firefox: the bundled engines exactly as the e2e suite runs them
 *     (Playwright's bundled Firefox is driven over its Juggler protocol).
 *   - firefox-no-fission: the bundled Firefox with MOZ_FORCE_DISABLE_FISSION=1, the
 *     same switch isolation spec 6 uses.
 *   - moz-firefox, moz-firefox-no-fission: the locally INSTALLED stock Firefox driven
 *     over WebDriver BiDi (Playwright channel 'moz-firefox'; needs Firefox in its
 *     default install location), with and without Fission.
 *
 * Tried and found to change nothing (not kept as projects): the user pref
 * fission.autostart=false on the bundled Firefox, and remote.events.async.enabled=true
 * on stock Firefox over BiDi.
 */
const noFission = { env: { ...process.env, MOZ_FORCE_DISABLE_FISSION: '1' } };

export default defineConfig({
  testDir: '.',
  testMatch: '*.repro.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../test-results/frame-input-repro',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'firefox-no-fission', use: { ...devices['Desktop Firefox'], launchOptions: noFission } },
    { name: 'moz-firefox', use: { ...devices['Desktop Firefox'], channel: 'moz-firefox' } },
    { name: 'moz-firefox-no-fission', use: { ...devices['Desktop Firefox'], channel: 'moz-firefox', launchOptions: noFission } },
  ],
});
