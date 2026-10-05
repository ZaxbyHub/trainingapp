/**
 * Lumen phase 7: the in-chat model gate is a non-modal alertdialog over the chat page
 * only. Real-browser keyboard contract (jsdom ignores `inert` and Tab order):
 *  - Shift+Tab from the gate's first button reaches the shell navigation (no trap);
 *  - Tab from the gate's last button never lands in the covered chat content, which is inert.
 * Needs a build without staged weights (the gate must be up); skipped otherwise.
 */
import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, { timeout: 60_000 });
  const gate = page.getByRole('alertdialog', { name: 'Model not ready' });
  test.skip((await gate.count()) === 0, 'model gate absent (staged weights)');
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

test('Tab out of the gate never lands in the inert chat content', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Use a local server or cloud model' }).focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await activeIn(page, '.chat-page__content'), `Tab #${i + 1}`).toBe(false);
  }
});
