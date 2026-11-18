/**
 * at-rest-encryption-browser.spec.ts — issue #367 plan item 8 (PC-06
 * real-browser proof): a plaintext conversations store seeded through raw
 * IndexedDB is MIGRATED to AES-GCM envelopes by the first public operation
 * after an upgrade boot — the public list renders the originals, the RAW
 * storage holds ciphertext envelopes (no plaintext of title/messages), the
 * per-prefix secret lives in the localStorage custody map, and a reload
 * persists. fake-indexeddb unit (C3 + the adoption/matrix/tamper specs) +
 * this real-Chromium row = two-sided proof.
 *
 * Chromium-only (the at-rest surface is engine-independent; the frozen e2e
 * drivers run the chromium project). Run under web_ui/playwright config
 * (vite preview of the production build on 127.0.0.1:4174).
 */
import { expect, test, type Page } from '@playwright/test';
// Chromium-only: navigates via page.reload, which hangs on Playwright-Firefox
// under the app's COOP/COEP headers (documented harness limitation; see
// profile-switch-browser.spec.ts). The behavior itself is pinned
// engine-neutrally by the db-crypto matrix/adoption/tamper specs.
test.skip(({ browserName }) => browserName !== 'chromium', 'chromium-only (reload under COI hangs on Playwright-Firefox)');

test.describe.configure({ timeout: 120_000 });

const TITLE_A = 'AtRestE2E Title Alfa';
const MSG_A = 'AtRestE2E message bravo';
const TITLE_B = 'AtRestE2E Title Charlie';
const MSG_B = 'AtRestE2E message delta';
const MARKERS = [TITLE_A, MSG_A, TITLE_B, MSG_B];
const SECRET_MAP_KEY = 'doc-qa-profile-secret';

async function waitReady(page: Page): Promise<void> {
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
    timeout: 60_000,
  });
}

interface SeedRow {
  id: string;
  title: string;
  content: string;
}

/** Seed plaintext conversation rows via a raw version-less IDB open. */
async function seedPlaintextRows(page: Page, rows: SeedRow[]): Promise<void> {
  const prefix = await page.evaluate(() => localStorage.getItem('doc-qa-profile-id'));
  expect(prefix, 'profile id is minted at boot').toBeTruthy();
  await page.evaluate(
    async ({ name, rows }) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
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
        const store = t.objectStore('conversations');
        for (const row of rows) {
          store.put({
            id: row.id,
            title: row.title,
            messages: [
              { id: `${row.id}-u1`, role: 'user', content: row.content, timestamp: Date.now() - 60_000 },
            ],
            createdAt: Date.now() - 60_000,
            updatedAt: Date.now() - 60_000,
            mode: 'wllama',
            modelUsed: 'e2e',
          });
        }
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
      db.close();
    },
    { name: `${prefix}-doc-qa-conversations`, rows },
  );
}

/** Raw rows of the active profile's conversations db (version-less getAll). */
async function rawRows(page: Page): Promise<Array<Record<string, unknown>>> {
  const prefix = await page.evaluate(() => localStorage.getItem('doc-qa-profile-id'));
  expect(prefix, 'profile id is minted at boot').toBeTruthy();
  return page.evaluate(async (name: string) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise<unknown[]>((res, rej) => {
      const t = db.transaction('conversations', 'readonly');
      const g = t.objectStore('conversations').getAll();
      g.onsuccess = () => res(g.result ?? []);
      g.onerror = () => rej(g.error);
    });
    db.close();
    return rows as Array<Record<string, unknown>>;
  }, `${prefix}-doc-qa-conversations`);
}

test('plaintext rows migrate to ciphertext at rest; reads render and persist across reload', async ({ page }) => {
  // Boot: profile id minted, Dexie schema created (empty store).
  await page.goto('/');
  await waitReady(page);

  // (0) The upgrade fixture: plaintext rows on disk.
  await seedPlaintextRows(page, [
    { id: 'atrest-a', title: TITLE_A, content: MSG_A },
    { id: 'atrest-b', title: TITLE_B, content: MSG_B },
  ]);
  const seeded = await rawRows(page);
  expect(seeded).toHaveLength(2);
  const seededJson = JSON.stringify(seeded);
  for (const marker of MARKERS) {
    expect(seededJson, `fixture sanity: ${marker} plaintext on disk`).toContain(marker);
  }

  // (1) Reload: the first public operation migrates the store (C3 wording:
  // raw rows ciphertext after the first public operation returns).
  await page.reload();
  await waitReady(page);

  // (2) Public reads render the originals.
  await expect(page.getByRole('button', { name: TITLE_A, exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: TITLE_B, exact: false })).toBeVisible({ timeout: 30_000 });

  // (3) RAW storage holds ciphertext envelopes — no plaintext at rest.
  const stored = await rawRows(page);
  expect(stored).toHaveLength(2);
  const rawJson = JSON.stringify(stored);
  for (const marker of MARKERS) {
    expect(rawJson, `raw rows must not leak ${marker}`).not.toContain(marker);
  }
  for (const row of stored) {
    expect(row['v']).toBe(1);
    const e = row['e'] as Record<string, unknown>;
    expect(typeof e['iv']).toBe('string');
    expect(typeof e['ct']).toBe('string');
  }

  // (4) Custody: the per-prefix secret lives in the localStorage map.
  const custody = await page.evaluate((key: string) => {
    const raw = localStorage.getItem(key);
    const prefix = localStorage.getItem('doc-qa-profile-id') ?? '';
    if (raw === null) return { hasPrefix: false, byteLen: 0 };
    const map = JSON.parse(raw) as Record<string, string>;
    const secret = map[prefix];
    if (typeof secret !== 'string') return { hasPrefix: false, byteLen: 0 };
    return { hasPrefix: true, byteLen: atob(secret).length };
  }, SECRET_MAP_KEY);
  expect(custody.hasPrefix, 'secret map carries the active prefix').toBe(true);
  expect(custody.byteLen).toBe(32);

  // (5) Reload persists: the envelopes authenticate under the persisted secret.
  await page.reload();
  await waitReady(page);
  await expect(page.getByRole('button', { name: TITLE_A, exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: TITLE_B, exact: false })).toBeVisible({ timeout: 30_000 });
});
