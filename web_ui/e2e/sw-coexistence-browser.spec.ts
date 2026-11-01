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

  // 2) The course SW (scope /training/) is registered too — the boot frame
  //    embeds shortly after app start; poll for both registrations.
  const origin = new URL(page.url()).origin;
  await expect
    .poll(async () => (await registrations(page)).some((r) => r.scope === `${origin}/training/`), {
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

  // 4) The course registration is gone; the app-shell registration SURVIVES.
  await expect
    .poll(async () => (await registrations(page)).some((r) => r.scope === `${origin}/training/`), {
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
