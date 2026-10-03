/**
 * packs-browser.spec.ts — browser-training-parity (ADR-0012, superseding the
 * ADR-0009 capability gate that e2e/packs-gate*.spec.ts pinned): the PLAIN
 * browser app (no Electron, no window.desktopApi) installs knowledge/training
 * packs through the same Packs UI as the desktop app, refuses hostile
 * archives with the desktop wording, and plays an installed course from the
 * DEDICATED player origin (the app server's loopback alias).
 *
 * Run under web_ui/playwright.config.ts (chromium against `vite preview` of
 * the production build on 127.0.0.1:4174; the player origin is then
 * http://localhost:4174).
 *
 * UI seams (shared with the desktop app, see src/components/PacksPanel.tsx):
 *   data-testid="packs-panel", "pack-install-input", "pack-row-<id>-<ver>",
 *   "pack-status-<id>-<ver>", Training page "training-pack-select" and
 *   "training-player-frame". The retired gate notice
 *   (data-testid="pack-gate-notice") must never appear.
 */
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';

const DROPZONE_SELECTOR = '[aria-label="Drop files here or click to select"]';
const PACK_ID = 'browser-parity-course';
const PACK_NAME = 'Browser Parity Course';
const SLIDE_DOC_PATH = 'docs/slide-001-5rN4PvXJM5d.json';
const SLIDE_DOC = Buffer.from(
  JSON.stringify({ slide_id: '5rN4PvXJM5d', slide_title: 'Welcome', section_title: 'Launch Menu', on_screen_text: 'Start the course' }),
  'utf8',
);

function manifest(version: string): Record<string, unknown> {
  return {
    id: PACK_ID,
    name: PACK_NAME,
    version,
    published_at: '2026-10-01T00:00:00Z',
    source_class: 'training',
    embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
    chunking: { strategy: 'slide-aware', size: 256, overlap: 0 },
    docs: [{ path: SLIDE_DOC_PATH, sha256: createHash('sha256').update(SLIDE_DOC).digest('hex'), title: 'Welcome', mime: 'application/json' }],
  };
}

async function coursePackZip(version: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('pack.json', JSON.stringify(manifest(version)));
  zip.file(SLIDE_DOC_PATH, SLIDE_DOC);
  zip.file('assets/player/story.html', `<!doctype html><html><head><title>course</title></head><body>BROWSER-PARITY:${version}</body></html>`);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

/** A raw zip carrying a traversal entry (JSZip would normalize the name away). */
function zipSlipArchive(): Buffer {
  const entries = [
    { name: 'pack.json', data: Buffer.from(JSON.stringify(manifest('1.0.0'))) },
    { name: '../evil.txt', data: Buffer.from('pwn') },
  ];
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(zlib.crc32 ? zlib.crc32(e.data) : 0, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(zlib.crc32 ? zlib.crc32(e.data) : 0, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

async function openDocuments(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });
}

async function installViaPanel(page: Page, bytes: Buffer, fileName: string): Promise<void> {
  await page.getByTestId('pack-install-input').setInputFiles({ name: fileName, mimeType: 'application/zip', buffer: bytes });
}

async function dropOnDropZone(page: Page, bytes: Buffer, fileName: string): Promise<void> {
  await page.evaluate(
    ({ b64, name, selector }) => {
      const bin = window.atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      const transfer = new DataTransfer();
      transfer.items.add(new File([arr], name, { type: 'application/zip' }));
      document.querySelector(selector)?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    },
    { b64: bytes.toString('base64'), name: fileName, selector: DROPZONE_SELECTOR },
  );
}

/** Records in this profile's documents store (the document pipeline's storage). */
async function documentRecords(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const dbs = await (indexedDB as unknown as { databases(): Promise<Array<{ name?: string }>> }).databases();
    let total = 0;
    for (const { name } of dbs) {
      if (!name || !name.endsWith('-doc-qa-documents')) continue;
      total += await new Promise<number>((resolve) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('documents')) {
            db.close();
            resolve(0);
            return;
          }
          const count = db.transaction('documents', 'readonly').objectStore('documents').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => resolve(0);
        };
        req.onerror = () => resolve(0);
      });
    }
    return total;
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? route.fallback() : route.abort();
  });
});

test('a pack installs through the Packs panel and its course plays from the dedicated player origin', async ({ page }) => {
  await openDocuments(page);
  await installViaPanel(page, await coursePackZip('1.0.0'), `${PACK_ID}-1.0.0.zip`);
  await expect(page.getByTestId(`pack-row-${PACK_ID}-1.0.0`)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId(`pack-status-${PACK_ID}-1.0.0`)).toHaveText(/active/i);
  await expect(page.getByTestId('pack-gate-notice')).toHaveCount(0);

  await page.getByRole('button', { name: 'Training', exact: true }).click();
  await expect(page.getByTestId('training-pack-select').locator('option', { hasText: PACK_NAME })).toHaveCount(1, { timeout: 30_000 });
  const frame = page.locator('iframe[data-testid="training-player-frame"]');
  await expect(frame).toBeVisible({ timeout: 30_000 });
  const src = new URL((await frame.getAttribute('src')) ?? '');
  const appOrigin = new URL(page.url()).origin;
  expect(src.origin).not.toBe(appOrigin);
  expect(src.pathname).toBe(`/training/${PACK_ID}/story.html`);
  await expect(page.frameLocator('iframe[data-testid="training-player-frame"]').locator('body')).toContainText('BROWSER-PARITY:1.0.0', {
    timeout: 60_000,
  });
});

test('a pack zip dropped on the DropZone installs (the ADR-0009 gate is gone) and never reaches the document store', async ({ page }) => {
  await openDocuments(page);
  await page.waitForTimeout(800);
  const before = await documentRecords(page);
  await dropOnDropZone(page, await coursePackZip('1.0.0'), `${PACK_ID}-1.0.0.zip`);
  await expect(page.getByTestId(`pack-row-${PACK_ID}-1.0.0`)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('pack-gate-notice')).toHaveCount(0);
  expect(await documentRecords(page)).toBe(before);
});

test('a hostile pack is refused with the desktop wording and nothing is installed', async ({ page }) => {
  await openDocuments(page);
  await installViaPanel(page, zipSlipArchive(), 'zip-slip.zip');
  await expect(page.getByRole('alert').filter({ hasText: /unsafe archive entry path \(dot segment\)/ }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`pack-row-${PACK_ID}-1.0.0`)).toHaveCount(0);
});

test('a zip without pack.json is refused as a pack and stores nothing', async ({ page }) => {
  await openDocuments(page);
  const zip = new JSZip();
  zip.file('readme.txt', 'A plain archive with no root pack.json.');
  const bytes = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
  await page.waitForTimeout(800);
  const before = await documentRecords(page);
  await dropOnDropZone(page, bytes, 'not-a-pack.zip');
  await expect(page.getByText(/no pack\.json manifest at the archive root/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('pack-gate-notice')).toHaveCount(0);
  expect(await documentRecords(page)).toBe(before);
});
