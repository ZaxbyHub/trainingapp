// b6-review-hardening.test.ts — swarm-pr-review feedback round (PR #101).
//
// Additive pins for the validated review findings; lives OUTSIDE the frozen
// checkpoint manifest (no existing b6 spec was modified):
//   PRR-002  createBackup stages to .part then renames; latestBackup never
//            selects a .part sibling.
//   PRR-004  meta.embedding_model_id is recorded on the first successful
//            write (flag set after COMMIT).
//   PRR-005  per-file byte cap, extracted-text cap, and zip-content cap are
//            enforced per-file without failing the batch.
//   PRR-013  the /ingest/file 400 negative path carries its contract detail
//            in the response body, not just the status code.
//   PRR-014  restoreBackup replaces a NON-EMPTY active store with the
//            backup's content (no merge, no residue).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeBackendHost } from '../../main/backend/index.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';
import { createBackup, latestBackup, restoreBackup } from '../../main/backend/store/backup.js';
import { IngestPipeline } from '../../main/backend/ingest/pipeline.js';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import { resolveIngestLimits } from '../../main/backend/ingest/config.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);
const NATIVE_DEPS_PRESENT = fs.existsSync(path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'));
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

const TOKEN = 'b6-hardening-token';
const CONFIG = { maxConcurrentFiles: 2, chunkWordCount: 256, chunkOverlapWords: 100 };
const limitsOf = (partial: Partial<{ maxFileBytes: number; maxZipBytes: number; maxTextChars: number }>) => ({
  maxFileBytes: 60 * 1024 * 1024,
  maxZipBytes: 512 * 1024 * 1024,
  maxTextChars: 8_000_000,
  ...partial,
});

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makePipeline(store: StoreHandle, limits?: ReturnType<typeof limitsOf>): IngestPipeline {
  return new IngestPipeline({
    store,
    embedder: new HashEmbedder({ dims: store.dims }),
    config: CONFIG,
    ...(limits ? { limits } : {}),
  });
}

function docCount(store: StoreHandle): number {
  return (store.db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n;
}

function httpJson(
  port: number,
  method: string,
  requestPath: string,
  body: Buffer | undefined,
  headers: Record<string, string>,
): Promise<{ status: number; json?: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown>, text });
        } catch {
          resolve({ status: res.statusCode ?? 0, text });
        }
      });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('hardening httpJson timed out')));
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

describe('b6 review hardening (PR #101 feedback round)', () => {
  itReal('createBackup publishes atomically: no .part residue, and latestBackup ignores a planted .part (PRR-002)', () => {
    const root = makeTempDir('b6-hd-backup-');
    const storePath = path.join(root, 'store.sqlite');
    const store = openStore({ dbPath: storePath, dims: 8, repoRoot: REPO_ROOT });
    try {
      store.db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'x')").run();
      const backupsDir = path.join(root, 'backups');
      const backup = createBackup(store, backupsDir);
      const backupDir = path.dirname(backup.path);
      expect(fs.existsSync(backup.path)).toBe(true);
      expect(fs.readdirSync(backupDir).some((f) => f.endsWith('.part'))).toBe(false);
      // A planted partial sibling is invisible to restore selection.
      fs.writeFileSync(path.join(backupDir, 'store.sqlite.part'), Buffer.from('garbage'));
      expect(latestBackup(backupsDir)).toBe(backup.path);
    } finally {
      store.close();
    }
  });

  itReal('restoreBackup replaces a NON-EMPTY active store with the backup content (PRR-014)', async () => {
    const root = makeTempDir('b6-hd-restore-');
    const storePath = path.join(root, 'store.sqlite');
    const store = openStore({ dbPath: storePath, dims: 8, repoRoot: REPO_ROOT });
    const pipeline = makePipeline(store);
    const docA = Buffer.from('REV-A unique backup marker text for restore, repeated marker. '.repeat(8), 'utf8');
    const docB = Buffer.from('REV-B newer content that restore must remove again. '.repeat(8), 'utf8');
    const first = await pipeline.ingestFile({ name: path.join(root, 'a.txt'), data: new Uint8Array(docA) });
    expect(first.success).toBe(true);
    const backup = createBackup(store, path.join(root, 'backups'));

    const second = await pipeline.ingestFile({ name: path.join(root, 'b.txt'), data: new Uint8Array(docB) });
    expect(second.success).toBe(true);
    expect(docCount(store)).toBe(2);
    store.close();

    await restoreBackup({ backupPath: backup.path, dbPath: storePath, dims: 8 });
    const reopened = openStore({ dbPath: storePath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(docCount(reopened)).toBe(1);
      const marker = reopened.db
        .prepare("SELECT COUNT(*) AS n FROM chunks WHERE text LIKE '%REV-A unique backup marker%'")
        .get() as { n: number };
      expect(marker.n).toBeGreaterThan(0);
      const stale = reopened.db
        .prepare("SELECT COUNT(*) AS n FROM chunks WHERE text LIKE '%REV-B newer content%'")
        .get() as { n: number };
      expect(stale.n).toBe(0);
    } finally {
      reopened.close();
    }
  });

  itReal('per-file byte and extracted-text caps produce per-file failures (PRR-005)', async () => {
    const root = makeTempDir('b6-hd-caps-');
    const storePath = path.join(root, 'store.sqlite');
    const store = openStore({ dbPath: storePath, dims: 8, repoRoot: REPO_ROOT });
    const byteCapPipeline = makePipeline(store, limitsOf({ maxFileBytes: 8 }));
    const textCapPipeline = makePipeline(store, limitsOf({ maxTextChars: 12 }));
    try {
      const oversized = await byteCapPipeline.ingestFile({
        name: path.join(root, 'big.txt'),
        data: new Uint8Array(Buffer.from('0123456789abcdef', 'utf8')),
      });
      expect(oversized.success).toBe(false);
      expect(oversized.message).toContain('file too large');

      const wordy = await textCapPipeline.ingestFile({
        name: path.join(root, 'wordy.txt'),
        data: new Uint8Array(Buffer.from('alpha beta gamma', 'utf8')),
      });
      expect(wordy.success).toBe(false);
      expect(wordy.message).toContain('per-document cap');
      expect(docCount(store)).toBe(0);
    } finally {
      store.close();
    }
  });

  itReal('zip-content cap refuses an office doc whose entries declare more than the cap (PRR-005)', async () => {
    const root = makeTempDir('b6-hd-zipcap-');
    const storePath = path.join(root, 'store.sqlite');
    const store = openStore({ dbPath: storePath, dims: 8, repoRoot: REPO_ROOT });
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('word/document.xml', 'x'.repeat(4096));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const docxPath = path.join(root, 'bomb.docx');
    fs.writeFileSync(docxPath, buffer);
    const pipeline = makePipeline(store, limitsOf({ maxZipBytes: 16 }));
    try {
      const outcome = await pipeline.ingestFile({ name: docxPath, data: new Uint8Array(buffer) });
      expect(outcome.success).toBe(false);
      expect(outcome.message).toContain('extraction cap');
      expect(docCount(store)).toBe(0);
    } finally {
      store.close();
    }
  });

  itReal('missing-file-part 400 carries its contract detail in the body (PRR-013)', async () => {
    const root = makeTempDir('b6-hd-http-');
    const host = new NodeBackendHost({
      token: TOKEN,
      storePath: path.join(root, 'store', 'store.sqlite'),
      storeEmbeddingDims: 8,
      env: { TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
    });
    const handle = await host.start();
    try {
      const boundary = 'b6hd7351boundary';
      const body = Buffer.from(`--${boundary}--\r\n`, 'utf8');
      const res = await httpJson(handle.port, 'POST', '/ingest/file', body, {
        'x-desktop-token': TOKEN,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
      });
      expect(res.status).toBe(400);
      expect(res.json?.detail).toBe('Missing/invalid file part (multipart field "file")');
    } finally {
      await host.stop();
    }
  });

  itReal('limits resolver: frozen defaults, per-key env overrides (additive to resolveIngestConfig)', () => {
    expect(resolveIngestLimits({})).toEqual({
      maxFileBytes: 60 * 1024 * 1024,
      maxZipBytes: 512 * 1024 * 1024,
      maxTextChars: 8_000_000,
    });
    expect(
      resolveIngestLimits({
        TRAININGAPP_INGEST_MAX_FILE_BYTES: '1024',
        TRAININGAPP_INGEST_MAX_ZIP_BYTES: '2048',
        TRAININGAPP_INGEST_MAX_TEXT_CHARS: '4096',
      }),
    ).toEqual({ maxFileBytes: 1024, maxZipBytes: 2048, maxTextChars: 4096 });
    // Invalid values fall back per key (positive-int contract).
    expect(resolveIngestLimits({ TRAININGAPP_INGEST_MAX_FILE_BYTES: '-5' })).toMatchObject({
      maxFileBytes: 60 * 1024 * 1024,
    });
  });

  itReal('meta.embedding_model_id is recorded on the first successful write (PRR-004 pin)', async () => {
    const root = makeTempDir('b6-hd-meta-');
    const storePath = path.join(root, 'store.sqlite');
    const store = openStore({ dbPath: storePath, dims: 8, repoRoot: REPO_ROOT });
    const pipeline = makePipeline(store);
    try {
      const outcome = await pipeline.ingestFile({
        name: path.join(root, 'meta.txt'),
        data: new Uint8Array(Buffer.from('meta embedding model id pin text. '.repeat(8), 'utf8')),
      });
      expect(outcome.success).toBe(true);
      const row = store.db.prepare("SELECT value FROM meta WHERE key = 'embedding_model_id'").get() as
        | { value: unknown }
        | undefined;
      expect(row).toBeDefined();
      expect(String(row?.value)).toBe('hash');
    } finally {
      store.close();
    }
  });
});
