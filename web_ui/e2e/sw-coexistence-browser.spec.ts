/**
 * sw-coexistence-browser.spec.ts — issue #34 item 7 (plan R2 coexistence
 * evidence + finding 8): the app-shell service worker and the training-course
 * service worker coexist on the same origin (most-specific scope wins), and
 * the course 'trainingapp-unregister' teardown — sent exactly the way the
 * app's releaseBrowserTrainingIfEmpty sends it (a postMessage from the app
 * page to the embedded boot frame) — leaves the app-shell registration
 * intact.
 *
 * Chromium-only; run under web_ui/playwright.config.ts.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ timeout: 120_000 });

// Chromium-only: the property under test is the app-shell service worker
// and context.setOffline (a Chromium-only Playwright protocol surface;
// Firefox crashes with setForceOffline target-registry undefined). The
// frozen C2 driver runs --project=chromium for the same reason.
test.skip(({ browserName }) => browserName !== 'chromium', 'chromium-only (app-shell SW + setOffline)');

interface RegInfo {
  scope: string;
}

async function registrations(page: Page): Promise<RegInfo[]> {
  return page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('no serviceWorker container');
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.map((r) => ({ scope: r.scope }));
  });
}

async function waitReady(page: Page): Promise<void> {
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
    timeout: 60_000,
  });
}

test('the app-shell SW and the course SW coexist; course teardown keeps the app shell', async ({ page }) => {
  await page.goto('/');
  await waitReady(page);

  // 1) The app-shell SW is registered and ACTIVE at the origin root.
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (registration.active === null) throw new Error('app-shell SW not active');
    if (!registration.scope.endsWith('/')) {
      throw new Error(`unexpected app-shell scope: ${registration.scope}`);
    }
  });

  // 2) The course SW lives in the PLAYER ORIGIN's registry (the boot frame
  //    embeds a loopback host alias — localhost vs 127.0.0.1 are distinct
  //    origins with distinct service-worker registries, the isolation ADR's
  //    whole point), so coexistence means one live worker per origin. Register
  //    it from inside the boot frame (its origin), as the real course flow does.
  const origin = new URL(page.url()).origin;
  const bootFrame = () => page.frames().find((f) => f.url().includes('training-boot'));
  await expect.poll(async () => bootFrame() !== undefined, { timeout: 30_000 }).toBe(true);
  const frame = bootFrame()!;
  const frameRegs = async () =>
    frame.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope));
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready; // app-shell worker is live in the app registry
  });
  await frame.evaluate(async () => {
    await navigator.serviceWorker.register('/training/sw.js?app=' + encodeURIComponent('http://localhost:9'), {
      scope: '/training/',
    });
  });
  await expect
    .poll(async () => (await frameRegs()).some((scope) => scope.endsWith('/training/')), {
      timeout: 30_000,
    })
    .toBe(true);
  expect((await registrations(page)).some((r) => r.scope === `${origin}/`)).toBe(true);

  // 3) Course teardown: post the unregister message to the boot frame from
  //    the app page — the exact path releaseBrowserTrainingIfEmpty takes
  //    (bootFrame.contentWindow.postMessage to the player origin). The
  //    player origin comes from the frame's src (contentWindow.location is
  //    unreadable cross-origin).
  const posted = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[aria-hidden="true"]');
    if (frame === null || frame.contentWindow === null || frame.src === '') return false;
    const player = new URL(frame.src).origin;
    frame.contentWindow.postMessage({ type: 'trainingapp-unregister' }, player);
    return true;
  });
  expect(posted, 'the training boot frame is embedded').toBe(true);

  // 4) The course registration is gone FROM THE PLAYER REGISTRY; the
  //    app-shell registration in the app registry SURVIVES.
  await expect
    .poll(async () => (await frameRegs()).some((scope) => scope.endsWith('/training/')), {
      timeout: 30_000,
    })
    .toBe(false);
  const after = await registrations(page);
  expect(after.some((r) => r.scope === `${origin}/`)).toBe(true);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (registration.active === null) throw new Error('app-shell SW lost its active worker');
  });
});
