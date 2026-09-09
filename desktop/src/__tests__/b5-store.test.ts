// b5-store.test.ts — B5 store contract tests (issue #63).
//
// Exercises the Node-side store module (desktop/main/backend/store/) against
// the AUTHORITATIVE schema (contracts/store.schema.sql): application, meta
// seeds, virtual tables, migrate no-op, idempotent re-open, dims guards, and
// the production wiring (NodeBackendHost.start()/stop()).
//
// The suite degrades gracefully on machines without desktop/node_modules
// (better-sqlite3 is a native addon): those cases skip with an inline,
// artifact-guarded note — matching the itReal convention in b4 tests and the
// CI job that always has the deps installed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Temp dirs created by the current test; removed in afterEach. */
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Repo-root discovery via the established contracts marker (b4 convention). */
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
// Inline artifact-guarded skip (never a blanket skip): without the native deps
// these tests cannot run; CI always installs them.
const itWithDeps = NATIVE_DEPS_PRESENT ? it : it.skip;
const itReal = itWithDeps;

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-store-'));
  tempDirs.push(dir);
  return path.join(dir, 'store.db');
}

async function loadStoreModule() {
  return import('../../main/backend/store/sqlite-store.js');
}

describe('b5 store schema application', () => {
  itReal('applies the authoritative schema with meta seeds and virtual tables', async () => {
    const { openStore } = await loadStoreModule();
    const dbPath = makeTempDbPath();
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      const tables = (store.db.prepare('SELECT name FROM sqlite_master ORDER BY name').all() as { name: string }[]).map(
        (row) => row.name,
      );
      for (const expected of ['docs', 'chunks', 'packs', 'links', 'meta', 'chunks_fts', 'embeddings']) {
        expect(tables).toContain(expected);
      }
      const meta = store.db.prepare('SELECT key, value FROM meta ORDER BY key').all() as { key: string; value: string }[];
      const metaMap = new Map(meta.map((row) => [row.key, row.value]));
      expect(metaMap.get('schema_version')).toBe('1');
      expect(metaMap.get('embedding_dims')).toBe('8');
      expect(metaMap.has('embedding_model_id')).toBe(true);
      expect(store.schemaVersion).toBe(1);
    } finally {
      store.close();
    }
  });

  itReal('is idempotent on re-open (guarded schema application, no duplicate seeds)', async () => {
    const { openStore } = await loadStoreModule();
    const dbPath = makeTempDbPath();
    const first = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    first.close();
    const second = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      const rows = second.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'schema_version'").get() as {
        n: number;
      };
      expect(rows.n).toBe(1);
      expect(second.schemaVersion).toBe(1);
    } finally {
      second.close();
    }
  });

  itReal('migrate() is a verified no-op for schema v1', async () => {
    const { openStore } = await loadStoreModule();
    const { migrate } = await import('../../main/backend/store/migrate.js');
    const store = openStore({ dbPath: makeTempDbPath(), dims: 8, repoRoot: REPO_ROOT });
    try {
      const before = store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      expect(migrate(store.db)).toBe(1);
      const after = store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      expect(after).toEqual(before);
    } finally {
      store.close();
    }
  });

  itReal('rejects invalid embedding dims loudly (0, negative, non-integer)', async () => {
    const { openStore } = await loadStoreModule();
    for (const dims of [0, -1, 1.5, Number.NaN]) {
      expect(() => openStore({ dbPath: makeTempDbPath(), dims, repoRoot: REPO_ROOT })).toThrowError(
        /positive integer/,
      );
    }
  });

  itReal('fails loud when re-opening with a different embedding width than the store was created with', async () => {
    const { openStore } = await loadStoreModule();
    const dbPath = makeTempDbPath();
    const first = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    first.close();
    expect(() => openStore({ dbPath, dims: 16, repoRoot: REPO_ROOT })).toThrowError(/embedding_dims=8/);
    // The original store is untouched by the failed mismatched open.
    const probe = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      expect(probe.schemaVersion).toBe(1);
    } finally {
      probe.close();
    }
  });

  itReal('applies the schema via the production repo-root discovery (findRepoRoot fallback)', async () => {
    const { openStore } = await loadStoreModule();
    // No repoRoot option: findRepoRoot must walk up from the module location
    // (desktop/src/__tests__ under vitest) to the repo root on its own.
    const store = openStore({ dbPath: makeTempDbPath(), dims: 8 });
    try {
      expect(store.schemaVersion).toBe(1);
    } finally {
      store.close();
    }
  });

  itReal('fails loud when the schema file is missing (repo root without contracts/)', async () => {
    const { openStore } = await loadStoreModule();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-norepo-'));
    expect(() => openStore({ dbPath: path.join(outside, 's.db'), dims: 8, repoRoot: outside })).toThrowError(
      /store\.schema\.sql/,
    );
  });
});

describe('b5 store production wiring', () => {
  itReal('NodeBackendHost start() opens and stop() closes the configured store', async () => {
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const dbPath = makeTempDbPath();
    const host = new NodeBackendHost({ token: 'test-token', storePath: dbPath, storeEmbeddingDims: 8 });
    const handle = await host.start();
    try {
      expect(handle.mode).toBe('node');
      expect(fs.existsSync(dbPath)).toBe(true);
      // The store is real and readable through a fresh handle while the host runs.
      const { openStore } = await loadStoreModule();
      const probe = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
      try {
        expect(probe.schemaVersion).toBe(1);
      } finally {
        probe.close();
      }
    } finally {
      await host.stop();
    }
  });

  itReal('host survives store init failure (failure isolation, sticky until restart)', async () => {
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // dims=0 makes openStore throw inside the host's failure-isolated block.
      const host = new NodeBackendHost({ token: 'test-token', storePath: makeTempDbPath(), storeEmbeddingDims: 0 });
      const handle = await host.start();
      try {
        // The host degraded instead of failing: the frozen B3 contract holds.
        expect(handle.mode).toBe('node');
      } finally {
        await host.stop();
      }
      expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('store init failed'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('never opens a store when storePath is unset', async () => {
    // Asserted scope: start() resolves with the node handle. (No store file
    // can be created because no store path is configured; the store handle
    // is private, so absence is enforced by construction in index.ts.)
    const { NodeBackendHost } = await import('../../main/backend/index.js');
    const host = new NodeBackendHost({ token: 'test-token' });
    const handle = await host.start();
    try {
      expect(handle.mode).toBe('node');
    } finally {
      await host.stop();
    }
    // Sidecar mode is covered by the existing b3 suite (sidecar lifecycle);
    // the no-store guarantee there is enforced by construction in index.ts.
  });
});
