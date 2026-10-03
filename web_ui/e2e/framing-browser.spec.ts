/**
 * framing-browser.spec.ts — the app shell is never frameable, and course
 * playback refuses to start in a framed app (browser-training-parity AC11,
 * ADR-0012; review round 1 F1).
 *
 *   1. Hosting: app-shell responses (and every player-origin file but the
 *      boot page) carry frame-ancestors 'none' and X-Frame-Options: DENY; the
 *      boot page carries a restrictive header CSP that only the app origin
 *      may frame (the app embeds it; final-critic FC6).
 *   2. A foreign top-level page that frames the app gets no app document.
 *   3. Defense in depth: even when a host omits those headers (stripped here
 *      by a route), a framed app never embeds the training boot frame.
 *   4. (boot-nesting-browser.spec.ts) The boot frame does nothing unless its
 *      parent is the top-level page.
 *
 * Foreign pages are served by Playwright routes on http://outer.test.
 */
import { expect, test, type Page } from '@playwright/test';

const OUTER = 'http://outer.test';

async function serveOuter(page: Page, pages: Record<string, string>): Promise<void> {
  await page.route(`${OUTER}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = pages[path];
    return body === undefined ? route.fulfill({ status: 404, body: 'nope' }) : route.fulfill({ status: 200, contentType: 'text/html', body });
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === 'outer.test' ? route.fallback() : route.abort();
  });
});

test('app-shell responses refuse framing; the player boot file stays embeddable', async ({ page, baseURL }) => {
  for (const path of ['/', '/index.html', '/some/spa/route']) {
    const res = await page.request.get(`${baseURL}${path}`);
    expect(res.headers()['content-security-policy'], path).toBe("frame-ancestors 'none'");
    expect(res.headers()['x-frame-options'], path).toBe('DENY');
  }
  // The boot page, requested on the PLAYER origin (the app origin's loopback
  // alias), is embeddable by the app origin only, under a restrictive header
  // CSP (final-critic FC6); every other player-origin file refuses framing.
  const app = new URL(baseURL ?? 'http://127.0.0.1:4174');
  const player = new URL(app.href);
  player.hostname = app.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  const boot = await page.request.get(`${player.origin}/training-boot.html`);
  expect(boot.headers()['x-frame-options']).toBeUndefined();
  expect(boot.headers()['content-security-policy']).toBe(
    `default-src 'none'; script-src ${player.origin}/training-boot.js; worker-src ${player.origin}/training/sw.js; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors ${app.origin}`,
  );
  expect(boot.headers()['cross-origin-resource-policy']).toBe('cross-origin');
  for (const path of ['/training-boot.js', '/training/sw.js', '/training', '/training/pack/story.html']) {
    const res = await page.request.get(`${player.origin}${path}`);
    expect(res.headers()['content-security-policy'], path).toBe("frame-ancestors 'none'");
    expect(res.headers()['x-frame-options'], path).toBe('DENY');
  }
});

test('a foreign page cannot frame the app', async ({ page, baseURL }) => {
  // App responses pass through unchanged (fetched and re-fulfilled with their
  // real headers) so the outcome is decided by the anti-framing headers, not by
  // Chromium's Local Network Access block on a non-local top page.
  await page.route(`${baseURL}/**`, async (route) => route.fulfill({ response: await route.fetch() }));
  await serveOuter(page, { '/': `<!doctype html><iframe id="app" src="${baseURL}/"></iframe>` });
  await page.goto(`${OUTER}/`);
  await page.waitForTimeout(3000);
  for (const frame of page.frames()) {
    expect(await frame.locator('nav[aria-label="Main navigation"]').count(), frame.url()).toBe(0);
  }
});

test('a framed app never starts the course player, even if a host omits the anti-framing headers', async ({ page, baseURL }) => {
  // Simulate a misconfigured host: strip the anti-framing headers from app responses.
  await page.route(`${baseURL}/**`, async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers['content-security-policy'];
    delete headers['x-frame-options'];
    await route.fulfill({ response, headers });
  });
  await serveOuter(page, { '/': `<!doctype html><iframe id="app" src="${baseURL}/" style="width:1200px;height:800px"></iframe>` });
  const warnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes('course playback is disabled')) warnings.push(msg.text());
  });
  await page.goto(`${OUTER}/`);
  const app = page.frameLocator('#app');
  await expect(app.locator('nav[aria-label="Main navigation"]')).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(2000);
  await expect(app.locator('iframe[data-testid="training-player-boot"]')).toHaveCount(0);
  expect(warnings.length).toBeGreaterThan(0);

  // Control: the same app at top level does embed the boot frame.
  await page.goto(`${baseURL}/`);
  await expect(page.locator('iframe[data-testid="training-player-boot"]')).toHaveCount(1, { timeout: 30_000 });
});
