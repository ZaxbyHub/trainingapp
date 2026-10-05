/**
 * Lumen phase 7: the in-chat model gate is a non-modal alertdialog over the chat page
 * only. Real-browser keyboard contract (jsdom ignores `inert` and Tab order):
 *  - Shift+Tab from the gate's first button reaches the shell navigation (no trap);
 *  - Tab from the gate's last button never lands in the covered chat content, which is inert.
 * Needs a build without staged weights (the gate must be up): it FAILS without a gate
 * unless LUMEN_ALLOW_NO_OVERLAY=1 (local builds with staged weights). CI never stages them.
 */
import { expect, test, type Page } from '@playwright/test';

/**
 * Wait for the chat page itself (the gate or, absent a gate, the composer) rather than
 * for boot text to disappear, which can be satisfied before boot has started on a slow
 * runner. A missing gate FAILS unless LUMEN_ALLOW_NO_OVERLAY=1 (builds with staged weights);
 * CI builds never stage weights.
 */
async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const gate = page.getByRole('alertdialog', { name: 'Model not ready' });
  await expect(gate.or(page.getByLabel('Message input')).first()).toBeVisible({ timeout: 60_000 });
  const present = (await gate.count()) > 0;
  if (!present && process.env.LUMEN_ALLOW_NO_OVERLAY === '1') test.skip(true, 'overlay opt-out (LUMEN_ALLOW_NO_OVERLAY=1)');
  expect(present, 'model gate must render; set LUMEN_ALLOW_NO_OVERLAY=1 only for builds with staged weights').toBe(true);
  await expect(gate).toBeVisible();
}

const activeIn = (page: Page, selector: string) =>
  page.evaluate((sel) => !!document.activeElement?.closest(sel), selector);

test('Shift+Tab from the gate reaches the shell navigation', async ({ page }) => {
  await boot(page);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await activeIn(page, '.ui-shell__sidebar, .ui-shell__topbar')).toBe(true);
  expect(await activeIn(page, '[role="alertdialog"]')).toBe(false);
});

test('Tab from the gate leaves it (no trap) and never lands in the inert chat content', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Use a local server or cloud model' }).focus();
  // Forward Tab from the last gate button must leave the gate; with a trap it would wrap
  // back to Retry. Inert content is skipped, so it lands outside the chat region entirely.
  await page.keyboard.press('Tab');
  expect(await activeIn(page, '[role="alertdialog"]'), 'Tab left the gate').toBe(false);
  expect(await activeIn(page, '.chat-page__content')).toBe(false);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await activeIn(page, '.chat-page__content'), `Tab #${i + 2}`).toBe(false);
  }
});

test('activating Settings from the nav while the gate is up keeps focus there (not yanked back to the opener)', async ({ page }) => {
  await boot(page);
  const nav = page.locator('.ui-shell__sidebar');
  // Make the opener the Chat nav item: leave the gate's page, then come back with the keyboard.
  await nav.getByRole('button', { name: 'Documents', exact: true }).click();
  const chat = nav.getByRole('button', { name: 'Chat', exact: true });
  await chat.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog', { name: 'Model not ready' })).toBeVisible();
  // The user Tabs into the nav and activates Settings while the gate is up.
  const settings = nav.getByRole('button', { name: 'Settings', exact: true });
  await settings.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog', { name: 'Model not ready' })).toHaveCount(0);
  await expect(settings).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).not.toBe('Chat');
});
