/**
 * offline-reload-browser.spec.ts — issue #34 item 7 (AC2, check C2): a TRUE
 * end-to-end offline reload. Loads the app online, waits for the app shell,
 * awaits navigator.serviceWorker.ready (the app-shell SW must be ACTIVE
 * before the offline leg or the reload race invalidates the result), takes
 * the context offline with context.setOffline(true), reloads, and asserts
 * the app shell renders again — no browser error page.
 *
 * The spec must not stub the service worker, the network stack, or the build
 * output: it proves the shipped public/sw.js + sw-precache-manifest.js
 * actually serve the shell offline. check-c2.sh runs it under BOTH serving
 * surfaces of playwright.config.ts (PW_WEB_SERVER=preview — vite preview —
 * and PW_WEB_SERVER=serve-offline — scripts/serve-offline.mjs, the declared
 * deployment server).
 *
 * Chromium-only by design (the frozen C2 driver passes --project=chromium):
 * the property under test is the SW offline shell, not engine parity.
 */
import { expect, test } from '@playwright/test';

test.describe.configure({ timeout: 120_000 });

test('the app shell boots offline after one online load (app-shell SW)', async ({ page, context }) => {
  // 1) Load the app online and wait for a stable app-shell marker: the boot
  //    overlay lifts once the lightweight indexes initialize, then either the
  //    first-run model gate or the chat composer is rendered (model-gate.ts
  //    waitForChatPage convention).
  await page.goto('/');
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
    timeout: 60_000,
  });
  const gateOrComposer = page.getByRole('alertdialog').or(page.getByLabel('Message input')).first();
  await expect(gateOrComposer).toBeVisible({ timeout: 60_000 });

  // 2) The app-shell SW must be ACTIVE (installed + activated) before the
  //    offline leg: serviceWorker.ready resolves only then.
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('navigator.serviceWorker missing: the app-shell SW never registered');
    }
    const registration = await navigator.serviceWorker.ready;
    if (registration.active === null) {
      throw new Error('serviceWorker.ready resolved with no active worker');
    }
  });

  // 3) Offline.
  await context.setOffline(true);
  try {
    // 4) Reload.
    await page.reload({ waitUntil: 'domcontentloaded' });

    // 5) The app shell renders again: no browser error page. An offline
    //    failure would leave the network error document (no #root content,
    //    no gate/composer). The boot overlay may show briefly while the
    //    offline shell re-initializes; the gate-or-composer marker is the
    //    stable end state in both weighted and unweighted builds.
    await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(gateOrComposer).toBeVisible({ timeout: 60_000 });
    // The served document is still the app's own markup, not an error page.
    const hasRoot = await page.evaluate(
      () => document.getElementById('root') !== null && document.body.innerText.length >= 0,
    );
    expect(hasRoot, 'offline reload served the app document').toBe(true);
  } finally {
    await context.setOffline(false);
  }
});
