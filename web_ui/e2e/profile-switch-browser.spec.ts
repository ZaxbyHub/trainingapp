/**
 * profile-switch-browser.spec.ts — issue #34 item 6p (AC5): runtime profile
 * switching through the REAL Settings UI. Creates conversation history in
 * profile A (raw IndexedDB, the app's own Dexie schema), verifies it renders,
 * switches to a freshly minted profile via Settings → Profile data, and
 * asserts isolation after the reload (profile B's history is EMPTY); a switch
 * BACK through the same UI returns profile A's history.
 *
 * Chromium-only (the profile-switch surface is engine-independent; the frozen
 * e2e drivers run the chromium project). Run under web_ui/playwright.config.ts.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ timeout: 120_000 });

const CONV_TITLE = 'Profile A history';

async function waitReady(page: Page): Promise<void> {
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
    timeout: 60_000,
  });
}

/** Write one conversation straight into the ACTIVE profile's Dexie database. */
async function seedConversation(page: Page, title: string): Promise<void> {
  const prefix = await page.evaluate(() => localStorage.getItem('doc-qa-profile-id'));
  expect(prefix, 'profile id is minted at boot').toBeTruthy();
  await page.evaluate(
    async ({ name, title }) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        // Open WITHOUT a pinned version: Dexie 4 declares the app's v2 schema
        // at native IndexedDB version 20, and a lower pinned open VersionErrors
        // (the same trap the lumen-baseline seed hit). Opening version-less
        // uses whatever the app created.
        const r = indexedDB.open(name);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains('conversations')) {
            r.result.createObjectStore('conversations', { keyPath: 'id' });
          }
          if (!r.result.objectStoreNames.contains('meta')) {
            r.result.createObjectStore('meta', { keyPath: 'key' });
          }
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise<void>((res, rej) => {
        const t = db.transaction('conversations', 'readwrite');
        t.objectStore('conversations').put({
          id: 'profile-switch-e2e',
          title,
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 60_000,
          mode: 'wllama',
          modelUsed: 'test',
          messages: [
            { id: 'u1', role: 'user', content: 'question for profile A', timestamp: Date.now() - 60_000 },
            { id: 'a1', role: 'assistant', content: 'answer for profile A', timestamp: Date.now() - 60_000 },
          ],
        });
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
      db.close();
    },
    { name: `${prefix}-doc-qa-conversations`, title },
  );
}

async function openProfileData(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByText('Settings').click();
  await expect(page.getByTestId('profile-data-section')).toBeVisible({ timeout: 30_000 });
}

test('profiles isolate conversation history across real switches', async ({ page }) => {
  // 1) Profile A: history exists and renders.
  await page.goto('/');
  await waitReady(page);
  await seedConversation(page, CONV_TITLE);
  await page.reload();
  await waitReady(page);
  const profileA = await page.evaluate(() => localStorage.getItem('doc-qa-profile-id'));
  await expect(page.getByRole('button', { name: CONV_TITLE, exact: false })).toBeVisible({ timeout: 30_000 });

  // 2) Switch to a brand-new profile through the Settings UI (mint + reload).
  await openProfileData(page);
  await page.getByTestId('profile-create').click();
  await waitReady(page);
  const profileB = await page.evaluate(() => localStorage.getItem('doc-qa-profile-id'));
  expect(profileB).toBeTruthy();
  expect(profileB).not.toBe(profileA);

  // 3) Isolation: profile B sees NO conversation history (empty-chat surface).
  await expect(page.getByRole('button', { name: CONV_TITLE, exact: false })).toHaveCount(0, { timeout: 30_000 });

  // 4) Switch BACK to profile A through the registered-profile row (confirm).
  await openProfileData(page);
  const switchButton = page.getByTestId(`profile-switch-${profileA}`);
  await expect(switchButton).toBeVisible({ timeout: 30_000 });
  await switchButton.click(); // arm
  await page.getByTestId(`profile-switch-${profileA}`).click(); // confirm → reload
  await waitReady(page);
  expect(await page.evaluate(() => localStorage.getItem('doc-qa-profile-id'))).toBe(profileA);

  // 5) Profile A's history is back.
  await expect(page.getByRole('button', { name: CONV_TITLE, exact: false })).toBeVisible({ timeout: 30_000 });
});
