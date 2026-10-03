/**
 * boot-nesting-browser.spec.ts — the player-origin boot frame does nothing
 * unless its parent is the top-level page (browser-training-parity AC11,
 * ADR-0012; review round 1 F1 item 3). Nested one level deeper (for example
 * inside course content or inside a framed app) it registers no course
 * worker and accepts no relay port; directly under the top page (the app's
 * own embedding) it registers (control row).
 *
 * The top pages are fulfilled by Playwright routes on the app origin. Chromium's
 * Local Network Access checks treat route-fulfilled pages as non-local, so they
 * could not embed the real loopback boot page at all; this file tests the boot
 * script's own parent check, not LNA, so LNA is switched off here (the control
 * row proves the embedding then works).
 */
import { expect, test, type Frame, type Page } from '@playwright/test';

test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } });

function frameByUrl(page: Page, prefix: string): Frame | undefined {
  return page.frames().find((f) => f.url().startsWith(prefix));
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? route.fallback() : route.abort();
  });
});

test('the boot frame registers no course worker unless its parent is the top-level page', async ({ page, baseURL }) => {
  // The test pages are served on the APP origin (a loopback, i.e. secure,
  // context): service workers need every ancestor to be a secure context, so a
  // plain-http foreign top page would make both rows vacuous.
  const app = new URL(baseURL ?? 'http://127.0.0.1:4174');
  const player = new URL(app.href);
  player.hostname = app.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  const bootUrl = `${player.origin}/training-boot.html`;
  const pages: Record<string, string> = {
    '/__frame-test/direct': `<!doctype html><iframe src="${bootUrl}"></iframe>`,
    '/__frame-test/nested': `<!doctype html><iframe src="${app.origin}/__frame-test/middle"></iframe>`,
    '/__frame-test/middle': `<!doctype html><iframe src="${bootUrl}"></iframe>`,
  };
  await page.route(`${app.origin}/__frame-test/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pages[new URL(route.request().url()).pathname] ?? '' }),
  );
  const registered = async (): Promise<boolean> => {
    const boot = frameByUrl(page, bootUrl);
    if (boot === undefined) return false;
    return boot.evaluate(async () => 'serviceWorker' in navigator && (await navigator.serviceWorker.getRegistration('/training/')) !== undefined);
  };

  await page.goto(`${app.origin}/__frame-test/nested`);
  await expect.poll(() => frameByUrl(page, bootUrl) !== undefined, { timeout: 15_000 }).toBe(true);
  expect(await frameByUrl(page, bootUrl)!.evaluate(() => window.isSecureContext && 'serviceWorker' in navigator)).toBe(true);
  await page.waitForTimeout(3000);
  expect(await registered()).toBe(false);

  // Control (same top-level site): directly under the top page it registers.
  await page.goto(`${app.origin}/__frame-test/direct`);
  await expect.poll(registered, { timeout: 15_000 }).toBe(true);
});
