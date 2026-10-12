// i100-store-hardening.test.ts — permanent regression pins for issue #100
// (store hardening deferred from PR #99).
//
// Complements the frozen acceptance probes (C1/C2/C6, which live only in the
// trace and are gone after closure) so the fixes stay pinned forever:
//   AC1: single-flight start() on BOTH hosts (Node + Sidecar), store close
//        proof (db.open), and a Windows-strength no-leak assertion;
//   AC2: explicit connection pragmas (journal_mode=wal, busy_timeout>0) and
//        fail-loud refusal behavior (held write lock -> throw; idle foreign
//        connection -> succeed with verified wal). HONESTY NOTE: on THIS
//        build the refusal throws from the pragma statement itself
//        (better-sqlite3 SQLITE_BUSY) before the production read-back branch
//        runs — no test here exercises that branch; it is cross-build defense
//        for builds where the conversion is refused silently;
//   AC5: direct closeStore() contract pin + loadSchemaSql substitution pin;
//   AC6: openStore throws on a relative dbPath.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('repo root not found (marker contracts/api.openapi.yaml)');
}
const REPO_ROOT = findRepoRoot(path.join(THIS_DIR, '..', '..', '..'));

const tempDirs: string[] = [];
const START_CWD = process.cwd();
// Hosts created by a failing test still need stop() so stray listeners and
// sidecar children never outlive the file.
const hosts: Array<{ stop(): Promise<void> }> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (hosts.length > 0) {
    try {
      await hosts.pop()?.stop();
    } catch {
      /* already stopped or partially started */
    }
  }
  try {
    process.chdir(START_CWD);
  } catch {
    /* cwd already restored */
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leaked better-sqlite3 handle keeps a dir undeletable on Windows —
         the dedicated no-leak test asserts rmSync succeeds where it matters */
    }
  }
});

async function loadStoreModule() {
  return import('../../main/backend/store/sqlite-store');
}

describe('i100 AC1: start() is single-flight on BOTH hosts', () => {
  it('NodeBackendHost: concurrent start() calls share one handle/one listener/one store', async () => {
    const dir = makeTempDir('i100-node-sf-');
    const dbPath = path.join(dir, 'store.db');
    const { NodeBackendHost } = await import('../../main/backend/index');
    const host = new NodeBackendHost({ token: 'i100', storePath: dbPath, storeEmbeddingDims: 8 });
    hosts.push(host);

    const [a, b] = await Promise.all([host.start(), host.start()]);
    // One flight: the identical handle object (not merely equal ports).
    expect(a).toBe(b);
    expect(b.port).toBe(a.port);

    // Store-close proof: capture the internal handle's db BEFORE stop() (stop
    // nulls the host field), assert it is open while serving and closed after.
    const internal = host as unknown as { store: { db: { open: boolean } } | null };
    const dbRef = internal.store?.db;
    expect(dbRef).toBeTruthy();
    expect(dbRef?.open).toBe(true);
    await host.stop();
    expect(dbRef?.open).toBe(false);

    // Windows-strength no-leak pin: a leaked second openStore handle makes
    // this rmSync throw EPERM (the R1 reproduction's signature). Vacuous on
    // POSIX, where unlink ignores open handles.
    fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.pop();
  });

  it('SidecarBackendHost: concurrent start() calls share one handle and one child', async () => {
    // REAL stub child (SidecarManager's spawnFn/pingFn are not injectable
    // through the host): serves GET /health 200 on 127.0.0.1:$API_PORT — the
    // manager's documented env contract. Low healthTimeoutMs so a broken stub
    // fails in seconds, not the 60 s default.
    const stub =
      "require('node:http').createServer((req,res)=>{res.statusCode=req.url==='/health'?200:404;res.end('ok');}).listen(Number(process.env.API_PORT),'127.0.0.1');";
    const { createBackendHost } = await import('../../main/backend/index');
    const host = createBackendHost({
      token: 'i100',
      mode: 'sidecar',
      sidecar: { command: process.execPath, args: ['-e', stub], healthTimeoutMs: 10000 },
    });
    hosts.push(host);

    const [a, b] = await Promise.all([host.start(), host.start()]);
    expect(a).toBe(b);
    expect(b.port).toBe(a.port);
    await host.stop();
  });

  it('stop() during an in-flight start waits for it, then a restart works', async () => {
    const dir = makeTempDir('i100-stop-during-');
    const dbPath = path.join(dir, 'store.db');
    const { NodeBackendHost } = await import('../../main/backend/index');
    const host = new NodeBackendHost({ token: 'i100', storePath: dbPath, storeEmbeddingDims: 8 });
    hosts.push(host);

    const starting = host.start();
    const stopping = host.stop(); // issued while the flight is pending
    const handle = await starting;
    await stopping;
    // After stop, the front listener is gone: connecting must be refused.
    const refused = await fetch(`http://127.0.0.1:${handle.port}/health`).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);

    // Restart: fresh flight, fresh handle, no residue from the first.
    const again = await host.start();
    expect(again.port).not.toBe(handle.port);
    // /health is guarded (401 without the token), so probe with the header.
    const ok = await fetch(`http://127.0.0.1:${again.port}/health`, {
      headers: { 'X-Desktop-Token': 'i100' },
    }).then(
      (r) => r.ok,
      () => false,
    );
    expect(ok).toBe(true);
    await host.stop();
  });
});

describe('i100 AC2: store connection pragmas', () => {
  it('openStore sets journal_mode=wal and busy_timeout>0 on a fresh file', async () => {
    const dir = makeTempDir('i100-pragmas-');
    const { openStore } = await loadStoreModule();
    const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: 8, repoRoot: REPO_ROOT });
    try {
      const jm = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      const bt = store.db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(jm.journal_mode).toBe('wal');
      expect(bt.timeout).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('a second accessor does not defeat the hardening: openStore verifies wal with a foreign idle connection open', async () => {
    const dir = makeTempDir('i100-wal-foreign-');
    const dbPath = path.join(dir, 'store.db');
    const require2 = createRequire(import.meta.url);
    const Database = require2('better-sqlite3') as new (p: string) => {
      pragma(sql: string, opts?: { simple?: boolean }): unknown;
      close(): void;
    };
    // Empirically (this SQLite build), an idle same-process second connection
    // does NOT block the WAL conversion — openStore must still come out with a
    // verified wal journal, i.e. the hardening is absent-for-nothing in the
    // shared-file case the issue exists for.
    const foreign = new Database(dbPath);
    try {
      const { openStore } = await loadStoreModule();
      const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
      try {
        const jm = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
        expect(jm.journal_mode).toBe('wal');
      } finally {
        store.close();
      }
    } finally {
      foreign.close();
    }
  });

  it('WAL conversion refused under a held write lock fails loud; retry after release succeeds', async () => {
    const dir = makeTempDir('i100-wal-refuse-');
    const dbPath = path.join(dir, 'store.db');
    const require2 = createRequire(import.meta.url);
    const Database = require2('better-sqlite3') as new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
    // A foreign connection holding a write lock mid-transaction is the real
    // refusal shape: better-sqlite3 surfaces it as "database is locked" and
    // openStore fails loud (SQLITE_BUSY from the pragma on this build; the
    // production read-back covers silent-refusal builds)
    // instead of quietly serving with journal_mode=delete.
    const foreign = new Database(dbPath);
    foreign.exec('BEGIN IMMEDIATE');
    foreign.prepare('CREATE TABLE probe (x)').run();
    try {
      const { openStore } = await loadStoreModule();
      expect(() => openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT })).toThrow();
    } finally {
      try {
        foreign.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      foreign.close();
    }
    // Lock released: the same call now converts and serves wal.
    const { openStore } = await loadStoreModule();
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      const jm = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(jm.journal_mode).toBe('wal');
    } finally {
      store.close();
    }
  });
});

describe('i100 AC5: store module coverage pins', () => {
  it('closeStore() closes the underlying connection directly', async () => {
    const dir = makeTempDir('i100-closestore-');
    const { openStore, closeStore } = await loadStoreModule();
    const store = openStore({ dbPath: path.join(dir, 'store.db'), dims: 8, repoRoot: REPO_ROOT });
    expect(store.db.open).toBe(true);
    closeStore(store);
    expect(store.db.open).toBe(false);
  });

  it('loadSchemaSql substitutes every __EMBEDDING_DIMS__ occurrence', async () => {
    const { loadSchemaSql } = await loadStoreModule();
    const sql = loadSchemaSql(REPO_ROOT, 8);
    // Two occurrences in the DDL body: the vec0 width and the meta seed.
    expect(sql).not.toContain('__EMBEDDING_DIMS__');
    expect(sql).toContain('float[8]');
    expect(sql).toContain(`('embedding_dims', '8')`);
  });
});

describe('i100 AC6: openStore rejects a relative dbPath', () => {
  it('throws before creating cwd-relative directories', async () => {
    const dir = makeTempDir('i100-relpath-');
    process.chdir(dir);
    const { openStore } = await loadStoreModule();
    expect(() => openStore({ dbPath: path.join('rel-probe', 'store.db'), dims: 8, repoRoot: REPO_ROOT })).toThrow(
      /absolute/,
    );
    expect(fs.existsSync(path.join(dir, 'rel-probe'))).toBe(false);
  });
});
