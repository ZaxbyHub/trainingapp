/**
 * packs-gate-picker.spec.ts — SELECTED-file (picker-path) half of the C9 gate
 * PoC (issue #76 / ADR-0009). Companion to the FROZEN e2e/packs-gate.spec.ts
 * (checkpoint-manifest C3), which owns the drop-path contract; this additive
 * spec pins the review-round-2 requirement that a pack zip arriving through
 * the file INPUT — HTML accept is a chooser hint, not an enforcement
 * boundary, and Playwright's setInputFiles bypasses it exactly like a
 * programmatic or OS-dialog-overridden selection — gets the same gate with
 * the same zero-write guarantee, while non-pack files stay ungated.
 *
 * Provenance: driver/mutation probes live in
 * .agents/issue-traces/76-browser-packs-adr/repro/ (trace-local per repo
 * convention).
 */
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

const DROPZONE_INPUT_SELECTOR = 'input[type="file"]';
const GATE_TESTID = 'pack-gate-notice';
const GATE_MESSAGE_PHRASE = 'Knowledge Packs require the desktop app';
const PACK_DOC_TEXT = '# Browser gate PoC (picker path)\n\nFixture document.\n';
const PACK_DOC_PATH = 'docs/browser-gate-poc.md';

function buildPackManifest(docSha256: string): Record<string, unknown> {
  return {
    id: 'opmed-core',
    name: 'OpMed Core Bundle',
    version: '1.0.0',
    published_at: '2026-09-20T00:00:00Z',
    source_class: 'bundled',
    embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
    chunking: { strategy: 'fixed-words', size: 200, overlap: 40 },
    docs: [
      {
        path: PACK_DOC_PATH,
        sha256: docSha256,
        title: 'Browser gate PoC fixture document',
        mime: 'text/markdown',
      },
    ],
  };
}

async function buildPackZipBytes(): Promise<Uint8Array> {
  const docBytes = Buffer.from(PACK_DOC_TEXT, 'utf8');
  const sha256 = createHash('sha256').update(docBytes).digest('hex');
  const zip = new JSZip();
  zip.file('pack.json', `${JSON.stringify(buildPackManifest(sha256), null, 2)}\n`);
  zip.file(PACK_DOC_PATH, PACK_DOC_TEXT);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

async function buildNonPackZipBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('readme.txt', 'A plain zip archive with no root pack.json.');
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

async function blockExternalNetwork(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost') {
      return route.continue();
    }
    return route.abort();
  });
}

async function openDocumentsPage(page: Page): Promise<void> {
  await page.goto('/');
  // exact: true — the "Model not ready" dialog carries a "Go to Documents"
  // button whose accessible name merely CONTAINS "Documents".
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.locator('[aria-label="Drop files here or click to select"]')).toBeVisible({
    timeout: 30_000,
  });
}

async function listIndexedDbNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const idb = indexedDB as unknown as {
      databases?: () => Promise<Array<{ name?: string }>>;
    };
    const dbs = await idb.databases?.();
    return (dbs ?? [])
      .map((d) => d.name ?? '')
      .filter((n) => n !== '')
      .sort();
  });
}

/**
 * Full storage inventory for this context: every `-doc-qa-*` database, every
 * object store in it, with per-store record counts. Used to compare the
 * snapshot before the selection against after — an in-place write to ANY
 * existing store (documents, vector index, keywords) changes the map, not
 * just the database-name list. Vector stores hold their own row shapes;
 * count() is engine-agnostic.
 */
async function storageInventory(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const idb = indexedDB as unknown as {
      databases?: () => Promise<Array<{ name?: string }>>;
    };
    const dbs = (await idb.databases?.()) ?? [];
    const targets = dbs.map((d) => d.name ?? '').filter((n) => n.includes('-doc-qa-')).sort();
    const inventory: Record<string, number> = {};
    for (const name of targets) {
      const storeNames = await new Promise<string[]>((resolve) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => {
          const db = req.result;
          const names = Array.from(db.objectStoreNames);
          db.close();
          resolve(names);
        };
        req.onerror = () => resolve([]);
      });
      for (const store of storeNames) {
        inventory[`${name}::${store}`] = await new Promise<number>((resolve) => {
          const req = indexedDB.open(name);
          req.onsuccess = () => {
            const db = req.result;
            try {
              const tx = db.transaction(store, 'readonly');
              const countReq = tx.objectStore(store).count();
              countReq.onsuccess = () => {
                db.close();
                resolve(countReq.result);
              };
              countReq.onerror = () => {
                db.close();
                resolve(-1);
              };
            } catch {
              db.close();
              resolve(-1);
            }
          };
          req.onerror = () => resolve(-1);
        });
      }
    }
    return inventory;
  });
}

test.beforeEach(async ({ page }) => {
  await blockExternalNetwork(page);
});

test('C9-AC3 picker gate: a SELECTED pack zip shows the gate and leaves IndexedDB untouched', async ({
  page,
}) => {
  const zipBytes = await buildPackZipBytes();

  await openDocumentsPage(page);
  await page.waitForTimeout(800);
  const beforeNames = await listIndexedDbNames(page);
  const beforeInventory = await storageInventory(page);

  // setInputFiles bypasses accept exactly like a programmatic selection —
  // the runtime must not rely on the chooser hint for the capability gate.
  await page.setInputFiles(
    DROPZONE_INPUT_SELECTOR,
    { name: 'browser-gate-poc-1.0.0.zip', mimeType: 'application/zip', buffer: Buffer.from(zipBytes) },
    { timeout: 10_000 }
  );

  const notice = page.getByTestId(GATE_TESTID);
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText(GATE_MESSAGE_PHRASE);

  const afterNames = await listIndexedDbNames(page);
  expect(afterNames).toEqual(beforeNames);
  // Stronger invariant: no in-place writes to ANY existing `-doc-qa-*`
  // store either — the full per-store inventory must be byte-identical.
  expect(await storageInventory(page)).toEqual(beforeInventory);
});

test('C9-AC3 picker guard: a SELECTED non-pack zip does not trigger the gate', async ({
  page,
}) => {
  const zipBytes = await buildNonPackZipBytes();

  await openDocumentsPage(page);
  await page.waitForTimeout(800);

  await page.setInputFiles(
    DROPZONE_INPUT_SELECTOR,
    { name: 'not-a-pack.zip', mimeType: 'application/zip', buffer: Buffer.from(zipBytes) },
    { timeout: 10_000 }
  );

  await page
    .getByText('Unsupported file type')
    .waitFor({ state: 'visible', timeout: 5_000 })
    .catch(() => {
      /* wording not part of the contract; the gate's absence is */
    });
  await expect(page.getByTestId(GATE_TESTID)).toHaveCount(0);
});
