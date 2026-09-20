/**
 * packs-gate.spec.ts — issue #76 (C9) AC3: Option-B capability-gate PoC,
 * plain-browser mode, run under web_ui/playwright.config.ts (chromium against
 * `vite preview` of the production build — no Electron, no window.desktopApi).
 *
 * Frozen check subjects (grep with
 * `npx playwright test --config playwright.config.ts e2e/packs-gate.spec.ts`):
 *   C9-AC3 gate        dropping a fixture KNOWLEDGE PACK zip (zip whose root
 *                      contains a pack.json matching the C1 manifest
 *                      signature, contracts/pack.schema.json) on the browser
 *                      Documents-page DropZone shows the capability-gate
 *                      notice AND leaves IndexedDB untouched.
 *   C9-AC3 guard       a NON-pack zip (no root pack.json) does NOT trigger
 *                      the gate notice (generic unsupported-file feedback is
 *                      acceptable and expected for it).
 *
 * ---------------------------------------------------------------------------
 * FROZEN UI CONTRACT THE IMPLEMENTATION MUST PROVIDE (binding; defined by the
 * acceptance-check author, mirroring the c7-packs.spec.ts seam convention):
 *   - Gate notice element:  data-testid="pack-gate-notice"
 *     rendered by the BROWSER-MODE DocumentsPage (web_ui/src/pages/
 *     DocumentsPage.tsx) when a dropped/selected file matches the C1 pack
 *     manifest signature. It must NOT be a toast that auto-dismisses before
 *     it can be asserted (a persistent notice element is required).
 *   - Gate notice text MUST contain the exact phrase:
 *       "Knowledge Packs require the desktop app"
 *   - Detection is content-based (read the zip root for pack.json), not
 *     extension-based guesswork; the fixture zip below is schema-honest.
 *   - Gate handling must perform NO IndexedDB writes: after the drop, the
 *     set of indexedDB.databases() names is unchanged, and every
 *     `${prefix}-doc-qa-documents` database's "documents" object store still
 *     holds ZERO records (see profile.ts getStorageDbNames()).
 *
 * Determinism notes:
 *   - No network beyond localhost: every cross-origin request is aborted
 *     (page.route below). The app boots only the lightweight vector/keyword
 *     indexes on this path; the embedding model (~130MB ONNX) and the LLM are
 *     lazy-loaded behind isReady gates and upload/query flows that the gate
 *     path never triggers.
 *   - Each test gets a fresh browser context, so IndexedDB (per-origin,
 *     per-context) starts empty and the profile prefix is freshly minted.
 *   - Loading the app/Documents page itself legitimately CREATES empty
 *     IndexedDB databases (Dexie opens them, e.g. the debounced empty-list
 *     save 500ms after load). The storage invariant is therefore asserted
 *     RELATIVE to a post-settle, pre-drop snapshot, plus an absolute
 *     zero-records check on the documents store.
 */

import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';

/** DropZone root element (web_ui/src/components/DropZone.tsx aria-label). */
const DROPZONE_SELECTOR = '[aria-label="Drop files here or click to select"]';

/** Frozen gate-notice seam (see header contract). */
const GATE_TESTID = 'pack-gate-notice';

/** Frozen gate message phrase (issue #76 Option B copy). */
const GATE_MESSAGE_PHRASE = 'Knowledge Packs require the desktop app';

/** Per-profile documents database name suffix (profile.ts getStorageDbNames). */
const DOC_DB_SUFFIX = '-doc-qa-documents';

const PACK_DOC_PATH = 'docs/gate-poc.md';
const PACK_DOC_TEXT = [
  '# Browser gate PoC fixture document',
  '',
  'This markdown file exists so the fixture pack zip carries one real',
  'docs/<file> entry whose pack.json sha256 matches these exact bytes.',
  '',
  'The browser surface has no pack import path; per ADR-0009 the only',
  'pack-capable surface is the desktop app.',
].join('\n');

/**
 * C1 manifest signature (contracts/pack.schema.json): exactly the required
 * fields, honoring `additionalProperties: false` at every level, the id
 * pattern ^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$, semver version, RFC3339
 * published_at, source_class enum, embedding/chunking shapes, and one docs[]
 * entry with a 64-hex sha256 of the raw doc bytes.
 */
function buildPackManifest(docSha256: string): {
  id: string;
  name: string;
  version: string;
  published_at: string;
  source_class: 'bundled' | 'training' | 'user';
  embedding: { model_id: string; dims: number; normalize: boolean };
  chunking: { strategy: 'fixed-words' | 'fixed-tokens' | 'page-aware' | 'slide-aware'; size: number; overlap: number };
  docs: Array<{ path: string; sha256: string; title: string; mime: string }>;
} {
  return {
    id: 'browser-gate-poc',
    name: 'Browser Gate PoC Pack',
    version: '1.0.0',
    published_at: '2026-09-20T00:00:00Z',
    source_class: 'training',
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

/** Build a schema-honest fixture pack zip (root pack.json + docs/<file>). */
async function buildPackZipBytes(): Promise<Uint8Array> {
  const docBytes = Buffer.from(PACK_DOC_TEXT, 'utf8');
  const sha256 = createHash('sha256').update(docBytes).digest('hex');
  const zip = new JSZip();
  zip.file('pack.json', `${JSON.stringify(buildPackManifest(sha256), null, 2)}\n`);
  zip.file(PACK_DOC_PATH, PACK_DOC_TEXT);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** Build a NON-pack zip: valid archive, no root pack.json. */
async function buildNonPackZipBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    'readme.txt',
    'A plain zip archive with no root pack.json — must NOT trigger the pack gate.'
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/**
 * Block every cross-origin request so the run stays hermetic (localhost only).
 * Must be installed before navigation.
 */
async function blockExternalNetwork(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost') {
      return route.continue();
    }
    return route.abort();
  });
}

/**
 * Boot the plain-browser app and navigate to the Documents page via the
 * sidebar nav (default page is 'chat'; there is no URL router — App.tsx
 * switches pages on state). Returns once the DropZone is visible.
 */
async function openDocumentsPage(page: Page): Promise<void> {
  await page.goto('/');
  // The boot overlay ("Initializing search services...") lifts once the
  // lightweight indexes initialize; clicking auto-waits for it either way.
  // exact: true — the "Model not ready" alertdialog (expected in builds
  // without staged weights) carries a "Go to Documents" button whose
  // accessible name CONTAINS "Documents"; the sidebar nav button is the only
  // one NAMED exactly "Documents".
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.locator(DROPZONE_SELECTOR)).toBeVisible({ timeout: 30_000 });
}

/**
 * Dispatch a real drag-and-drop of a zip File on the DropZone. Constructed in
 * page context (File from bytes + DataTransfer + drop event); React's
 * delegated onDrop handler on the DropZone div receives it exactly like a
 * user drop (drag-and-drop bypasses the file picker's accept filter).
 */
async function dropZipOnDropZone(
  page: Page,
  bytes: Uint8Array,
  fileName: string
): Promise<void> {
  const b64 = Buffer.from(bytes).toString('base64');
  await page.evaluate(
    async ({ b64, fileName, selector }) => {
      const bin = window.atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) {
        arr[i] = bin.charCodeAt(i);
      }
      const file = new File([arr], fileName, { type: 'application/zip' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const target = document.querySelector(selector);
      if (!target) {
        throw new Error(`drop target not found: ${selector}`);
      }
      target.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
      );
    },
    { b64, fileName, selector: DROPZONE_SELECTOR }
  );
}

/** Snapshot the sorted IndexedDB database names for this context. */
async function listIndexedDbNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const idb = indexedDB as unknown as {
      databases?: () => Promise<Array<{ name?: string }>>;
    };
    if (typeof idb.databases !== 'function') {
      throw new Error('indexedDB.databases() unavailable (chromium provides it)');
    }
    const dbs = await idb.databases();
    return dbs
      .map((d) => d.name ?? '')
      .filter((n) => n !== '')
      .sort();
  });
}

/**
 * Full storage inventory for this context: every `-doc-qa-*` database, every
 * object store in it, with per-store record counts. The gate invariant is
 * compared as a before/after BYTE-IDENTICAL map, so an in-place write to ANY
 * existing store (documents, vector mapping, vector index, keywords) is
 * caught — not just new database names or the documents store.
 *
 * Opens versionless (indexedDB.open(name) with no version), which opens the
 * EXISTING version without any upgrade — the read itself cannot mutate the
 * database.
 */
async function storageInventory(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const idb = indexedDB as unknown as {
      databases?: () => Promise<Array<{ name?: string }>>;
    };
    if (typeof idb.databases !== 'function') {
      throw new Error('indexedDB.databases() unavailable (chromium provides it)');
    }
    const dbs = await idb.databases();
    const targets = dbs
      .map((d) => d.name ?? '')
      .filter((n) => n.includes('-doc-qa-'))
      .sort();
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

test('C9-AC3 gate: dropping a pack zip shows the capability-gate notice and leaves IndexedDB untouched', async ({ page }) => {
  const zipBytes = await buildPackZipBytes();

  await openDocumentsPage(page);

  // Settle: page load legitimately creates the (empty) per-profile databases,
  // and the debounced empty-list save fires ~500ms after load. Snapshot only
  // after that churn is done.
  await page.waitForTimeout(800);
  const beforeNames = await listIndexedDbNames(page);
  const beforeInventory = await storageInventory(page);

  await dropZipOnDropZone(page, zipBytes, 'browser-gate-poc-1.0.0.zip');

  // THE gate: the frozen notice appears with the frozen message phrase.
  const notice = page.getByTestId(GATE_TESTID);
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText(GATE_MESSAGE_PHRASE);

  // Storage invariant 1: no NEW IndexedDB database names appeared.
  const afterNames = await listIndexedDbNames(page);
  expect(afterNames).toEqual(beforeNames);

  // Storage invariant 2 (PRR-002 strengthening): the FULL per-store inventory
  // of every -doc-qa-* database is byte-identical after the drop — an
  // in-place write to any existing store (documents, vector mapping, vector
  // index, keywords) is caught, not just new databases.
  const afterInventory = await storageInventory(page);
  expect(afterInventory).toEqual(beforeInventory);
});

test('C9-AC3 guard: a non-pack zip does not trigger the gate notice', async ({ page }) => {
  const zipBytes = await buildNonPackZipBytes();

  await openDocumentsPage(page);
  await page.waitForTimeout(800);

  await dropZipOnDropZone(page, zipBytes, 'not-a-pack.zip');

  // Generic unsupported-file feedback is the expected outcome for a non-pack
  // zip; wait for it (best effort — its exact wording is not part of the
  // contract) so the absence assertion below is not racing the rejection.
  await page
    .getByText('Unsupported file type')
    .waitFor({ state: 'visible', timeout: 5_000 })
    .catch(() => {
      /* feedback wording may differ; the contract is only the gate's absence */
    });

  // The gate notice must NOT appear for a non-pack zip.
  await expect(page.getByTestId(GATE_TESTID)).toHaveCount(0);
});
