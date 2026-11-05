// c3-remove-ordering.test.ts — removeLocked ordering under a failing
// directory delete (issue #278, AC3(b) / Fix A2).
//
// RED at base, GREEN after the fix. remove() must run the claimant-scoped
// row-deletion transaction FIRST and remove managed directories best-effort
// AFTER: an rmSync failure surfaces ONE PackManagerError that lists the
// failed directory path and discloses the retry semantics, while the store
// rows are ALREADY gone (a retry reports nothing installed).
import { afterEach, describe, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeDepsIt } from './fixtures/native-deps-gate.js';

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
const FIXTURES = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs');
const itReal = nativeDepsIt('c3-remove-ordering');

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];

afterEach(() => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // already closed by the test itself
      }
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface SqlDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

describe('c3 remove ordering: rows before managed dirs (issue #278)', () => {
  itReal('an rmSync failure throws one error listing the dir while the rows are already gone', async () => {
    const storeMod = await import('../../main/backend/store/sqlite-store.js');
    const managerMod = await import('../../main/backend/store/pack-manager.js');
    const embedderMod = await import('../../main/backend/ingest/embedder.js');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-remove-order-'));
    tempDirs.push(root);
    const packsRoot = path.join(root, 'packs');
    const store = storeMod.openStore({ dbPath: path.join(root, 'store.db'), dims: 8 });
    openStores.push(store);
    const manager = new managerMod.PackManager({
      store,
      embedder: new embedderMod.HashEmbedder({ dims: 8 }),
      packsRoot,
      repoRoot: REPO_ROOT,
    });
    const fixture = path.join(root, 'fixture-copy');
    fs.cpSync(path.join(FIXTURES, 'versioned-a-1.0.0'), fixture, { recursive: true });
    await manager.install(fixture);
    const db = store.db as unknown as SqlDb;
    expect((db.prepare('SELECT COUNT(*) AS n FROM packs').get() as { n: number }).n).toBe(1);
    const managedDir = (
      db.prepare('SELECT install_path FROM packs WHERE id = ?').get('versioned-a') as { install_path: string }
    ).install_path;
    expect(managedDir.startsWith(packsRoot)).toBe(true);

    // Fail ONLY the managed-dir removals; every other rmSync (temp cleanup,
    // pack staging) passes through untouched.
    const originalRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options: fs.RmSyncOptions) => {
      if (String(target).startsWith(packsRoot)) {
        throw new Error('simulated locked managed dir');
      }
      return originalRmSync(target, options);
    }) as typeof fs.rmSync);
    try {
      const failure = await manager.remove('versioned-a').then(
        () => {
          throw new Error('expected remove() to reject');
        },
        (err: unknown) => err,
      );
      // The error names the failed directory path and discloses the retry
      // semantics (rows gone -> a retry reports nothing installed).
      expect(failure).toBeInstanceOf(managerMod.PackManagerError);
      expect(String(failure)).toContain(managedDir);
      expect(String(failure)).toMatch(/retry reports nothing installed/);
    } finally {
      rmSpy.mockRestore();
    }

    // ROWS ARE ALREADY GONE despite the thrown error: registry, docs, and
    // chunks were deleted in the transaction that ran first (AC3(b)).
    expect((db.prepare('SELECT COUNT(*) AS n FROM packs').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM doc_claims').get() as { n: number }).n).toBe(0);
    // And the retry indeed reports nothing installed.
    await expect(manager.remove('versioned-a')).rejects.toThrow(/nothing installed matches/);
  });
});
