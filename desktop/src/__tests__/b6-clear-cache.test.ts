// b6-clear-cache.test.ts — B6 host-level Clear-Cache semantics (issue #64,
// C7; AC7).
//
// DELETE /documents on the production host must (a) remove the on-disk store
// files' content by re-initializing the SAME path as an empty schema and
// (b) keep serving without a restart — the SQLite-mode Clear Cache bar set by
// the web_ui precedent (SettingsPage deleteEdgeVecBlob).
//
// RED AT BASE: statically imports the not-yet-existing store modules wired
// through the host — the intended failing-first state. Requires
// desktop/node_modules (better-sqlite3); CI always has it.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeBackendHost } from '../../main/backend/index.js';
import { openStore, type StoreHandle } from '../../main/backend/store/sqlite-store.js';

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

function words(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

function countRows(store: StoreHandle, table: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
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

describe('b6 C7 (AC7): host-level clear cache', () => {
  itReal('DELETE /documents clears the on-disk store and keeps serving at the same path', async () => {
    const root = makeTempDir('b6-c7-clear-');
    const storePath = path.join(root, 'store.sqlite');
    const docsDir = path.join(root, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, 'one.txt'), `${words(200, 'clear')} clear cache content\n`, 'utf8');

    const host = new NodeBackendHost({
      token: TOKEN,
      storePath,
      storeEmbeddingDims: 8,
      env: { TRAININGAPP_DESKTOP_EMBEDDER: 'hash' },
      storeBackupsDir: path.join(root, 'backups'),
    });
    const handle = await host.start();
    try {
      const ingested = await httpJson(handle.port, 'POST', '/ingest', { directory: docsDir }, TOKEN);
      expect(ingested.json?.documents).toBe(1);
      expect((await httpJson(handle.port, 'GET', '/documents', undefined, TOKEN)).json?.total).toBe(1);

      const cleared = await httpJson(handle.port, 'DELETE', '/documents', undefined, TOKEN);
      expect(cleared.status).toBe(200);
      expect(cleared.json?.status).toBe('cleared');

      // While the host is STILL RUNNING: clearDocuments unlinked dbPath,
      // dbPath-wal and dbPath-shm before re-initializing. The reopened store
      // runs in rollback-journal mode (better-sqlite3 default; the schema sets
      // no WAL pragma), so the fresh connection never recreates -wal/-shm —
      // plain absence here is direct evidence the old sidecars were removed.
      expect(fs.existsSync(`${storePath}-wal`)).toBe(false);
      expect(fs.existsSync(`${storePath}-shm`)).toBe(false);

      // Still serving WITHOUT a restart, from a re-initialized empty store.
      expect((await httpJson(handle.port, 'GET', '/documents', undefined, TOKEN)).json?.total).toBe(0);
    } finally {
      await host.stop();
    }
    // After shutdown the SAME path holds a fresh empty schema, not the old bytes.
    expect(fs.existsSync(storePath)).toBe(true);
    const probe = openStore({ dbPath: storePath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(countRows(probe, 'docs')).toBe(0);
      expect(probe.schemaVersion).toBe(1);
    } finally {
      probe.close();
    }
  });
});
