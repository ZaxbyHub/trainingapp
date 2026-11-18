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

test('a genuine v2 plaintext store upgrades, migrates to ciphertext at rest, and persists', async ({ page, context }) => {
  // Plan item 8 fixture (review F6): the plaintext v2 database EXISTS at the
  // native version the pre-encryption build declared (2) BEFORE the app ever
  // opens it - pinned profile id in the init script, seeded v2 schema and
  // plaintext rows via raw IndexedDB at document start.
  await page.addInitScript(async () => {
    localStorage.setItem('doc-qa-profile-id', 'atrestv2');
    const DB = 'atrestv2-doc-qa-conversations';
    const seed = (resolve, reject) => {
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = () => {
        const conn = req.result;
        if (!conn.objectStoreNames.contains('conversations')) {
          const store = conn.createObjectStore('conversations', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('title', 'title', { unique: false });
        }
        if (!conn.objectStoreNames.contains('meta')) {
          conn.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const conn = req.result;
        const tx = conn.transaction('conversations', 'readwrite');
        const store = tx.objectStore('conversations');
        for (const row of [
          {
            id: 'v2-a',
            title: 'AtRestE2E Title Alfa',
            messages: [{ id: 'v2-a-u1', role: 'user', content: 'AtRestE2E message bravo', timestamp: 1 }],
            createdAt: 1,
            updatedAt: 1,
            mode: 'wllama',
            modelUsed: 'legacy',
          },
          {
            id: 'v2-b',
            title: 'AtRestE2E Title Charlie',
            messages: [{ id: 'v2-b-u1', role: 'user', content: 'AtRestE2E message delta', timestamp: 2 }],
            createdAt: 2,
            updatedAt: 2,
            mode: 'wllama',
            modelUsed: 'legacy',
          },
        ]) {
          store.put(row);
        }
        tx.oncomplete = () => { conn.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    };
    await new Promise(seed);
  });

  // The app boots against the EXISTING v2 database: schema upgrade to the
  // current ladder + first-open migration on the first public operation.
  await page.goto('/');
  await waitReady(page);

  // (1) Public reads render the migrated originals.
  await expect(page.getByRole('button', { name: 'AtRestE2E Title Alfa', exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'AtRestE2E Title Charlie', exact: false })).toBeVisible({ timeout: 30_000 });

  // (2) RAW storage holds ciphertext envelopes - no plaintext at rest.
  const stored = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('atrestv2-doc-qa-conversations');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise((res, rej) => {
      const t = db.transaction('conversations', 'readonly');
      const g = t.objectStore('conversations').getAll();
      g.onsuccess = () => res(g.result ?? []);
      g.onerror = () => rej(g.error);
    });
    db.close();
    return rows;
  });
  expect(stored).toHaveLength(2);
  const rawJson = JSON.stringify(stored);
  for (const marker of ['AtRestE2E Title Alfa', 'AtRestE2E message bravo', 'AtRestE2E Title Charlie', 'AtRestE2E message delta']) {
    expect(rawJson, `raw rows must not leak ${marker}`).not.toContain(marker);
  }
  for (const row of stored) {
    expect(row['v']).toBe(1);
    expect(typeof (row['e'] as Record<string, unknown>)['iv']).toBe('string');
    expect(typeof (row['e'] as Record<string, unknown>)['ct']).toBe('string');
  }

  // (3) Custody: the per-prefix 32-byte secret lives in the localStorage map.
  const custody = await page.evaluate(() => {
    const raw = localStorage.getItem('doc-qa-profile-secret');
    if (raw === null) return 0;
    const secret = (JSON.parse(raw) as Record<string, string>)['atrestv2'];
    return typeof secret === 'string' ? atob(secret).length : 0;
  });
  expect(custody).toBe(32);

  // (4) Reload persists: the same envelopes authenticate under the secret.
  await page.reload();
  await waitReady(page);
  await expect(page.getByRole('button', { name: 'AtRestE2E Title Alfa', exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'AtRestE2E Title Charlie', exact: false })).toBeVisible({ timeout: 30_000 });
  void context;
});
