// b6-corruption-recovery.test.ts — B6 corruption detection + recovery checks
// (issue #64, C6; AC6).
//
// Covers, against the REAL store (better-sqlite3 + sqlite-vec):
//   - checkStoreIntegrity / recoverStore: garbage detection, choose() prompt,
//     restore-from-latest vs fresh re-init, auto-restore, no-backup refusal,
//     healthy stores recover as action 'none';
//   - host wiring: a corrupt store at host.start() runs the recovery flow via
//     onStoreCorruption and never crashes the host.
//
// RED AT BASE: statically imports the not-yet-existing store/backup.js and
// store/recovery.js — the intended failing-first state. Requires
// desktop/node_modules (better-sqlite3); CI always has it.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeBackendHost } from '../../main/backend/index.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';
import { createBackup } from '../../main/backend/store/backup.js';
import { checkStoreIntegrity, recoverStore } from '../../main/backend/store/recovery.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'b6-test-token';

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

function sha256hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function normalized(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
}

function countRows(store: StoreHandle, table: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Seed one doc + chunk + embeddings + fts row directly (interop insert rules). */
function seedDoc(store: StoreHandle, docId: string, marker: string): void {
  const chunkId = `${docId}-chunk0`;
  const text = `${marker} seeded chunk text for backup and recovery roundtrips.`;
  const vector = JSON.stringify(Array.from({ length: store.dims }, (_, i) => ((i % 7) + 1) / 8));
  store.db
    .prepare("INSERT INTO docs (id, source_class, path, sha256) VALUES (?, 'general', ?, ?)")
    .run(docId, `${docId}.txt`, sha256hex(text));
  store.db
    .prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, 0, ?, ?)')
    .run(chunkId, docId, text, sha256hex(normalized(text)));
  store.db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(chunkId, text);
  store.db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(chunkId, vector);
}

/** Overwrite the db file with non-SQLite garbage bytes. */
function corruptFile(filePath: string): void {
  fs.writeFileSync(filePath, Buffer.alloc(4096, 0xde));
}

function httpJson(
  port: number,
  method: string,
  requestPath: string,
  body: unknown,
  token: string,
): Promise<{ status: number; json?: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const isJson = body !== undefined && !Buffer.isBuffer(body);
    const payload =
      body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = { 'x-desktop-token': token };
    if (isJson) headers['content-type'] = 'application/json';
    if (payload !== undefined) headers['content-length'] = String(payload.length);
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
    req.setTimeout(20_000, () => req.destroy(new Error(`httpJson ${method} ${requestPath} timed out`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('b6 C6 (AC6): corruption detection and recovery', () => {
  itReal('checkStoreIntegrity flags garbage; recoverStore honors an explicit restore choice', async () => {
    const root = makeTempDir('b6-c6-corrupt-');
    const dbPath = path.join(root, 'store.sqlite');
    const backupsDir = path.join(root, 'backups');
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    seedDoc(store, 'doc-precious', 'PRECIOUS-DOC');
    await createBackup(store, backupsDir);
    store.close();
    corruptFile(dbPath);

    expect(checkStoreIntegrity(dbPath).ok).toBe(false);

    let prompts = 0;
    const outcome = await recoverStore({
      dbPath,
      backupsDir,
      repoRoot: REPO_ROOT,
      dims: 8,
      choose: async () => {
        prompts += 1;
        return 'restore';
      },
    });
    expect(prompts).toBe(1);
    expect(outcome.action).toBe('restore');
    expect(typeof outcome.restoredFrom).toBe('string');
    const reopened = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(countRows(reopened, 'docs')).toBe(1);
    } finally {
      reopened.close();
    }
    expect(checkStoreIntegrity(dbPath).ok).toBe(true);
  });

  itReal("recoverStore 'fresh' deletes the corrupt file and re-initializes an empty store", async () => {
    const root = makeTempDir('b6-c6-fresh-');
    const dbPath = path.join(root, 'store.sqlite');
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    seedDoc(store, 'doc-lost', 'LOST-DOC');
    store.close();
    corruptFile(dbPath);

    const outcome = await recoverStore({ dbPath, repoRoot: REPO_ROOT, dims: 8, choose: async () => 'fresh' });
    expect(outcome.action).toBe('fresh');
    const reopened = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(countRows(reopened, 'docs')).toBe(0);
      expect(reopened.schemaVersion).toBe(1);
    } finally {
      reopened.close();
    }
    expect(checkStoreIntegrity(dbPath).ok).toBe(true);
  });

  itReal('auto-restore without choose; explicit restore with no backup fails loud', async () => {
    const root = makeTempDir('b6-c6-auto-');
    const dbPath = path.join(root, 'store.sqlite');
    const backupsDir = path.join(root, 'backups');
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    seedDoc(store, 'doc-auto', 'AUTO-DOC');
    await createBackup(store, backupsDir);
    store.close();
    corruptFile(dbPath);

    // choose absent + a backup exists: auto-restore from the latest backup.
    const outcome = await recoverStore({ dbPath, backupsDir, repoRoot: REPO_ROOT, dims: 8 });
    expect(outcome.action).toBe('restore');
    const reopened = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(countRows(reopened, 'docs')).toBe(1);
    } finally {
      reopened.close();
    }

    // choose => 'restore' but NO backup: a clear error, never silent success.
    const root2 = makeTempDir('b6-c6-nobackup-');
    const dbPath2 = path.join(root2, 'store.sqlite');
    const store2 = openStore({ dbPath: dbPath2, dims: 8, repoRoot: REPO_ROOT });
    store2.close();
    corruptFile(dbPath2);
    await expect(
      recoverStore({ dbPath: dbPath2, repoRoot: REPO_ROOT, dims: 8, choose: async () => 'restore' }),
    ).rejects.toThrow();
  });

  itReal('a healthy store recovers as action none and stays untouched', async () => {
    const root = makeTempDir('b6-c6-healthy-');
    const dbPath = path.join(root, 'store.sqlite');
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    seedDoc(store, 'doc-keep', 'KEEP-DOC');
    store.close();
    expect(checkStoreIntegrity(dbPath).ok).toBe(true);

    const outcome = await recoverStore({ dbPath, backupsDir: path.join(root, 'backups'), repoRoot: REPO_ROOT, dims: 8 });
    expect(outcome.action).toBe('none');
    const probe = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(countRows(probe, 'docs')).toBe(1);
    } finally {
      probe.close();
    }
  });

  itReal('host start on a corrupt store runs recovery via onStoreCorruption and still serves', async () => {
    const root = makeTempDir('b6-c6-hostcorrupt-');
    const storePath = path.join(root, 'store.sqlite');
    const store = openStore({ dbPath: storePath, dims: 8, repoRoot: REPO_ROOT });
    store.close();
    corruptFile(storePath);

    let prompted: { dbPath: string; message: string } | null = null;
    const host = new NodeBackendHost({
      token: TOKEN,
      storePath,
      storeEmbeddingDims: 8,
      env: { TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
      onStoreCorruption: async (info) => {
        prompted = info;
        return 'fresh';
      },
    });
    const handle = await host.start();
    try {
      expect(handle.mode).toBe('node');
      expect(prompted).not.toBeNull();
      expect(prompted?.dbPath).toBe(storePath);
      expect(typeof prompted?.message).toBe('string');
      expect((prompted?.message ?? '').length).toBeGreaterThan(0);
      const listed = await httpJson(handle.port, 'GET', '/documents', undefined, TOKEN);
      expect(listed.status).toBe(200);
      expect(listed.json?.total).toBe(0);
    } finally {
      await host.stop();
    }
  });
});
