// c3-schema-migration.test.ts — C3 acceptance check for issue #70 AC6, and
// the v3 -> v4 ladder for #278 (doc_claims + manifest reconciliation).
//
// Proves the v2 -> v3 ladder (per-version packs + active/install_path; docs
// FK drop) on a REAL seeded v2 store via the production openStore path, and
// that the Python mirror (contracts/tests/store-interop/migrate.py) agrees
// via its --selftest. The DDL shape parity between the ladder and the
// authoritative contracts/store.schema.sql is asserted here too — the same
// discipline the d4-links-store pin established for v2.
//
// The v3 -> v4 legs (#278) cover: the backfill keyed on docs.id (id !=
// sha256), reconciliation of a SECOND pack's claim from its retained
// manifest (claim survival across remove of the recorded owner, verified
// through retrieval), and the fail-closed pending state while an active
// manifest is unreadable (destructive verbs refuse; healing after the
// manifest is restored and the reconciliation re-runs at the next open).
import { afterEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { EmbeddingSurface } from '../../main/backend/ingest/embedder.js';
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
const itReal = nativeDepsIt('c3-schema-migration');

const tempDirs: string[] = [];

afterEach(() => {
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

/** Build a minimal v2-shaped store: meta(v2), packs (v2 DDL with the lone-id
 * PK and the supersedes FK), docs (v2 DDL with the docs.pack_id FK), plus one
 * installed row and one doc row to prove lossless migration. */
function seedV2Store(dbPath: string): SqlDb {
  const Database = (
    require('better-sqlite3') as new (p: string) => SqlDb
  );
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES
      ('schema_version', '2'),
      ('embedding_dims', '8');
    CREATE TABLE packs (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      version      TEXT NOT NULL,
      published_at TEXT,
      source_class TEXT NOT NULL,
      supersedes   TEXT REFERENCES packs(id)
    );
    CREATE TABLE docs (
      id           TEXT PRIMARY KEY,
      source_class TEXT NOT NULL,
      path         TEXT NOT NULL,
      sha256       TEXT NOT NULL,
      title        TEXT,
      published_at TEXT,
      pack_id      TEXT REFERENCES packs(id)
    );
    INSERT INTO packs (id, name, version, published_at, source_class, supersedes)
      VALUES ('legacy-pack', 'Legacy Pack', '1.0.0', NULL, 'bundled', NULL);
    INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id)
      VALUES ('legacy-doc-sha', 'bundled', 'docs/a.json', 'legacy-doc-sha', 'A', NULL, 'legacy-pack');
    -- v5 rebuild surface (issue #281): raw variant mirror rows the migration
    -- must normalize (soft hyphen U+00AD splits 'efficacy'; ZWSP splits
    -- 'hemoglobin'). Identity columns (text/content_hash) stay untouched.
    CREATE TABLE chunks (
      id           TEXT PRIMARY KEY,
      doc_id       TEXT NOT NULL REFERENCES docs(id),
      chunk_index  INTEGER NOT NULL,
      text         TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5 (chunk_id UNINDEXED, text);
    INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES
      ('legacy-chunk-1', 'legacy-doc-sha', 0, 'first' || char(173) || 'line ef' || char(173) || 'ficacy', 'h1'),
      ('legacy-chunk-2', 'legacy-doc-sha', 1, 'he' || char(0x200B) || 'moglobin plain', 'h2');
    INSERT INTO chunks_fts (chunk_id, text) SELECT id, text FROM chunks;
  `);
  return db;
}

describe('c3 store schema migration (issue #70 AC6)', () => {
  itReal('openStore migrates a v2 store to v4: shape, mapping, and data preserved', async () => {
    const { openStore } = await import('../../main/backend/store/sqlite-store.js');
    const { CURRENT_SCHEMA_VERSION } = await import('../../main/backend/store/migrate.js');
    expect(CURRENT_SCHEMA_VERSION).toBe(5);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-migrate-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'store.db');
    const seeded = seedV2Store(dbPath);
    seeded.close();

    // Production open path: schema apply is skipped (meta exists), the ladder
    // runs 2 -> 3.
    const store = openStore({ dbPath, dims: 8 });
    try {
      const db = store.db as unknown as SqlDb;
      expect(store.schemaVersion).toBe(5);
      expect(
        (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      ).toBe('5');

      // packs: v3 shape — PK (id, version) + active/install_path.
      const packCols = (
        db.prepare('PRAGMA table_info(packs)').all() as Array<{ name: string; pk: number }>
      ).sort((a, b) => a.pk - b.pk);
      const packNames = packCols.map((c) => c.name);
      for (const expected of ['id', 'version', 'name', 'published_at', 'source_class', 'active', 'install_path', 'supersedes']) {
        expect(packNames).toContain(expected);
      }
      const pk = packCols.filter((c) => c.pk > 0).map((c) => c.name);
      expect(pk).toEqual(['id', 'version']);

      // Row mapping: a v2 row was a live install -> active=1, install_path
      // NULL, supersedes carried verbatim (NULL stays NULL).
      const rows = db.prepare('SELECT * FROM packs').all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'legacy-pack',
        version: '1.0.0',
        active: 1,
        install_path: null,
        supersedes: null,
      });

      // docs: v3 shape (columns intact, rows preserved).
      const docCols = (
        db.prepare('PRAGMA table_info(docs)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(docCols).toEqual([
        'id',
        'source_class',
        'path',
        'sha256',
        'title',
        'published_at',
        'pack_id',
      ]);
      const docs = db.prepare('SELECT * FROM docs').all() as Array<Record<string, unknown>>;
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ id: 'legacy-doc-sha', pack_id: 'legacy-pack' });

      // v4 (#278; this connection ran v2 -> v3 first, so foreign keys are ON
      // for the v3 -> v4 step — the claims insert must be legal in both
      // pragma states): the backfill claims the seeded doc for its recorded
      // owner, keyed on docs.id. The mapped pack row has install_path NULL
      // (v2 rows were prebuilt wholesale installs), so the manifest
      // reconciliation pass is vacuously complete -> 'done'.
      const claimCols = (
        db.prepare('PRAGMA table_info(doc_claims)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(claimCols).toEqual(['doc_id', 'claimant']);
      const claims = db.prepare('SELECT doc_id, claimant FROM doc_claims').all() as Array<{
        doc_id: string;
        claimant: string;
      }>;
      expect(claims).toEqual([{ doc_id: 'legacy-doc-sha', claimant: 'pack:legacy-pack' }]);
      expect(
        (db.prepare("SELECT value FROM meta WHERE key = 'doc_claims_reconciled'").get() as { value: string })
          .value,
      ).toBe('done');

      // DDL parity: the migrated packs shape must equal a FRESH v3 apply.
      const freshPath = path.join(dir, 'fresh.db');
      const fresh = openStore({ dbPath: freshPath, dims: 8 });
      try {
        const migratedDdl = (
          db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'packs'").get() as {
            sql: string;
          }
        ).sql;
        const freshDdl = (
          fresh.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'packs'").get() as {
            sql: string;
          }
        ).sql;
        // Normalize: ALTER TABLE RENAME quotes the table name and the fresh
        // apply stores the schema file's CRLF text verbatim — compare the
        // semantic DDL, not byte storage artifacts.
        const norm = (s: string): string =>
          s.replace(/\r\n/g, '\n').replace(/"/g, '').replace(/\s+/g, ' ').trim();
        expect(norm(migratedDdl)).toBe(norm(freshDdl));
      } finally {
        fresh.close();
      }
    } finally {
      store.close();
    }
  });

  itReal('openStore migrates a v2 store to v5: the chunks_fts mirror rebuilds normalized (issue #281)', async () => {
    const { openStore } = await import('../../main/backend/store/sqlite-store.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-ftsv5-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'store.db');
    const seeded = seedV2Store(dbPath);
    seeded.close();

    const store = openStore({ dbPath, dims: 8 });
    try {
      const db = store.db as unknown as SqlDb;
      // Ladder ran through v5; identity tables are byte-identical.
      expect(store.schemaVersion).toBe(5);
      const chunkRows = db.prepare('SELECT id, text, content_hash FROM chunks ORDER BY rowid').all() as Array<{
        id: string;
        text: string;
        content_hash: string;
      }>;
      expect(chunkRows).toEqual([
        { id: 'legacy-chunk-1', text: 'first­line ef­ficacy', content_hash: 'h1' },
        { id: 'legacy-chunk-2', text: 'he​moglobin plain', content_hash: 'h2' },
      ]);
      // The mirror rows are normalized: soft hyphen and ZWSP are gone.
      const ftsRows = db.prepare('SELECT chunk_id, text FROM chunks_fts ORDER BY rowid').all() as Array<{
        chunk_id: string;
        text: string;
      }>;
      expect(ftsRows).toEqual([
        { chunk_id: 'legacy-chunk-1', text: 'firstline efficacy' },
        { chunk_id: 'legacy-chunk-2', text: 'hemoglobin plain' },
      ]);
      // And the rebuilt mirror actually answers the plain query.
      const hits = db
        .prepare('SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ?')
        .all('"efficacy"') as Array<{ chunk_id: string }>;
      expect(hits.map((h) => h.chunk_id)).toContain('legacy-chunk-1');
    } finally {
      store.close();
    }
  });

  // 120s per-test budget: the child execFileSync timeout is meaningless if
  // vitest's own (5s default) wrapper fires first — cold python + sqlite
  // startup on CI runners measured ~7-8s (observed 'Electron shell' job
  // timeout, PR #115 review PRR-001).
  itReal(
    'the Python mirror ladder agrees (migrate.py --selftest)',
    () => {
      const script = path.join(REPO_ROOT, 'contracts', 'tests', 'store-interop', 'migrate.py');
      expect(fs.existsSync(script)).toBe(true);
      const out = execFileSync('python', [script, '--selftest'], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(out).toContain('selftest OK');
    },
    120_000,
  );
});

// =============================================================================
// v3 -> v4 (issue #278): doc_claims backfill keyed on docs.id + manifest
// reconciliation + the fail-closed pending state.
// =============================================================================

interface V3PackSeed {
  id: string;
  version: string;
  name: string;
  publishedAt: string;
  /** Directory holding the retained pack.json (or null for install_path NULL). */
  installPath: string | null;
}

interface V3DocSeed {
  id: string;
  sha256: string;
  packId: string | null;
  docPath: string;
}

interface V3ChunkSeed {
  id: string;
  docId: string;
  text: string;
  vector: number[];
}

/**
 * Build an honest v3-shaped store: a real openStore apply (so vec0/FTS exist
 * and embeddings can be seeded), v3-style packs/docs/chunks rows with
 * id != sha256 docs and chunks keyed by docs.id, then the v4 surface is
 * removed (doc_claims dropped, marker deleted, schema_version stamped back
 * to '3') — the exact shape a v3-era file would present to the ladder.
 */
async function seedV3Store(
  dbPath: string,
  packs: V3PackSeed[],
  docs: V3DocSeed[],
  chunks: V3ChunkSeed[],
): Promise<void> {
  const { openStore } = await import('../../main/backend/store/sqlite-store.js');
  const store = openStore({ dbPath, dims: 8 });
  try {
    const db = store.db as unknown as SqlDb;
    const insertPack = db.prepare(
      "INSERT INTO packs (id, version, name, published_at, source_class, active, install_path, supersedes) VALUES (?, ?, ?, ?, 'bundled', 1, ?, NULL)",
    );
    for (const pack of packs) insertPack.run(pack.id, pack.version, pack.name, pack.publishedAt, pack.installPath);
    const insertDoc = db.prepare(
      'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    );
    for (const doc of docs) insertDoc.run(doc.id, 'bundled', doc.docPath, doc.sha256, 'Seed', doc.packId);
    const insertChunk = db.prepare(
      'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, 0, ?, ?)',
    );
    const insertFts = db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
    const insertEmbedding = db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)');
    for (const chunk of chunks) {
      insertChunk.run(chunk.id, chunk.docId, chunk.text, createHash('sha256').update(chunk.text).digest('hex'));
      insertFts.run(chunk.id, chunk.text);
      insertEmbedding.run(chunk.id, JSON.stringify(chunk.vector));
    }
    db.exec('DROP TABLE doc_claims');
    db.prepare("DELETE FROM meta WHERE key = 'doc_claims_reconciled'").run();
    db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
  } finally {
    store.close();
  }
}

function writeRetainedManifest(dir: string, packId: string, docShas: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'pack.json'),
    JSON.stringify({
      id: packId,
      docs: docShas.map((sha256, index) => ({ path: `docs/shared-${index}.json`, sha256 })),
    }),
    'utf8',
  );
}

const QUERY_VECTOR = [1, 0, 0, 0, 0, 0, 0, 0];
const pinnedQueryEmbedder: EmbeddingSurface = {
  modelId: 'pinned-query',
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => QUERY_VECTOR);
  },
};

describe('v3 -> v4 store schema migration (issue #278)', () => {
  itReal('backfills claims on docs.id, reconciles a second pack from its manifest, and the doc survives remove of the recorded owner', async () => {
    const { openStore } = await import('../../main/backend/store/sqlite-store.js');
    const { PackManager } = await import('../../main/backend/store/pack-manager.js');
    const { HashEmbedder } = await import('../../main/backend/ingest/embedder.js');
    const { hybridRetrieve } = await import('../../main/backend/retrieval/hybrid.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-v4-shared-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'store.db');
    const sharedSha = createHash('sha256').update('shared doc bytes v3').digest('hex');
    const ownerDir = path.join(dir, 'managed', 'owner-a', '1.0.0');
    const sharerDir = path.join(dir, 'managed', 'sharer-b', '1.0.0');
    writeRetainedManifest(ownerDir, 'owner-a', [sharedSha]);
    writeRetainedManifest(sharerDir, 'sharer-b', [sharedSha]);
    // docs.id deliberately != sha256 (PC-3): chunks key on the store id.
    await seedV3Store(
      dbPath,
      [
        { id: 'owner-a', version: '1.0.0', name: 'Owner A', publishedAt: '2026-01-01T00:00:00Z', installPath: ownerDir },
        { id: 'sharer-b', version: '1.0.0', name: 'Sharer B', publishedAt: '2026-06-01T00:00:00Z', installPath: sharerDir },
      ],
      [{ id: 'legacy-doc-id', sha256: sharedSha, packId: 'owner-a', docPath: 'docs/shared.json' }],
      [{ id: 'chunk-shared-1', docId: 'legacy-doc-id', text: 'zebra reconciled ledger shared', vector: [0.9, 0.1, 0, 0, 0, 0, 0, 0] }],
    );

    const store = openStore({ dbPath, dims: 8 });
    try {
      const db = store.db as unknown as SqlDb;
      expect(store.schemaVersion).toBe(5);
      expect(
        (db.prepare("SELECT value FROM meta WHERE key = 'doc_claims_reconciled'").get() as { value: string }).value,
      ).toBe('done');
      // Backfill claim from docs.pack_id + the RECONCILED second-pack claim,
      // both keyed on docs.id — the sha alone would have missed one pack.
      const claims = db.prepare('SELECT doc_id, claimant FROM doc_claims ORDER BY claimant').all() as Array<{
        doc_id: string;
        claimant: string;
      }>;
      expect(claims).toEqual([
        { doc_id: 'legacy-doc-id', claimant: 'pack:owner-a' },
        { doc_id: 'legacy-doc-id', claimant: 'pack:sharer-b' },
      ]);

      // Retrieval through the claimants join: the precedence winner is the
      // newer publishedAt claim (sharer-b), not the legacy docs.pack_id.
      const rows = await hybridRetrieve('zebra reconciled ledger', {
        store,
        embedder: pinnedQueryEmbedder,
        topK: 5,
      });
      const hit = rows.find((row) => row.chunkId === 'chunk-shared-1');
      expect(hit).toBeDefined();
      expect(hit?.packId).toBe('sharer-b');
      expect(hit?.packVersion).toBe('1.0.0');

      // Remove the RECORDED owner: its claim is released, the reconciled
      // sharer claim keeps the doc, its chunks, and retrievability.
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder({ dims: 8 }),
        packsRoot: path.join(dir, 'packs'),
        repoRoot: REPO_ROOT,
      });
      await manager.remove('owner-a');
      const docCount = (
        db.prepare('SELECT COUNT(*) AS n FROM docs WHERE sha256 = ?').get(sharedSha) as { n: number }
      ).n;
      expect(docCount).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE id = ?').get('chunk-shared-1')).toMatchObject({ n: 1 });
      const survivingClaims = db.prepare('SELECT claimant FROM doc_claims').all() as Array<{ claimant: string }>;
      expect(survivingClaims).toEqual([{ claimant: 'pack:sharer-b' }]);
      const afterRows = await hybridRetrieve('zebra reconciled ledger', {
        store,
        embedder: pinnedQueryEmbedder,
        topK: 5,
      });
      expect(afterRows.map((row) => row.chunkId)).toContain('chunk-shared-1');
      expect(afterRows.find((row) => row.chunkId === 'chunk-shared-1')?.packId).toBe('sharer-b');
    } finally {
      store.close();
    }
  });

  itReal('unreadable active manifest -> pending marker, destructive refusal naming it, healing after restore', async () => {
    const { openStore } = await import('../../main/backend/store/sqlite-store.js');
    const managerMod = await import('../../main/backend/store/pack-manager.js');
    const { PackManager, PackManagerError } = managerMod;
    const { HashEmbedder } = await import('../../main/backend/ingest/embedder.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-v4-pending-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'store.db');
    const sharedSha = createHash('sha256').update('pending shared doc bytes').digest('hex');
    const ownerDir = path.join(dir, 'managed', 'owner-a', '1.0.0');
    const sharerDir = path.join(dir, 'managed', 'sharer-b', '1.0.0');
    writeRetainedManifest(ownerDir, 'owner-a', [sharedSha]);
    fs.mkdirSync(sharerDir, { recursive: true }); // NO pack.json: unreadable
    await seedV3Store(
      dbPath,
      [
        { id: 'owner-a', version: '1.0.0', name: 'Owner A', publishedAt: '2026-01-01T00:00:00Z', installPath: ownerDir },
        { id: 'sharer-b', version: '1.0.0', name: 'Sharer B', publishedAt: '2026-06-01T00:00:00Z', installPath: sharerDir },
      ],
      [{ id: 'legacy-doc-id', sha256: sharedSha, packId: 'owner-a', docPath: 'docs/shared.json' }],
      [{ id: 'chunk-shared-1', docId: 'legacy-doc-id', text: 'pending zebra ledger shared', vector: [0.9, 0.1, 0, 0, 0, 0, 0, 0] }],
    );

    let store = openStore({ dbPath, dims: 8 });
    try {
      const db = store.db as unknown as SqlDb;
      expect(store.schemaVersion).toBe(5);
      expect(
        (db.prepare("SELECT value FROM meta WHERE key = 'doc_claims_reconciled'").get() as { value: string }).value,
      ).toBe('pending');
      // Only the backfill claim exists (sharer-b contributed nothing).
      const pendingClaims = db.prepare('SELECT claimant FROM doc_claims').all() as Array<{ claimant: string }>;
      expect(pendingClaims).toEqual([{ claimant: 'pack:owner-a' }]);

      // Fail closed: remove of the recorded owner REFUSES, naming the
      // unreadable manifest (a delete under a missing manifest map is
      // exactly the loss the pending state exists to prevent).
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder({ dims: 8 }),
        packsRoot: path.join(dir, 'packs'),
        repoRoot: REPO_ROOT,
      });
      await expect(manager.remove('owner-a')).rejects.toThrow(PackManagerError);
      await expect(manager.remove('owner-a')).rejects.toThrow(/sharer-b/);
      await expect(manager.remove('owner-a')).rejects.toThrow(/pack\.json/);
      // Nothing was deleted by the refused verb.
      expect(db.prepare('SELECT COUNT(*) AS n FROM packs').get()).toMatchObject({ n: 2 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM docs WHERE sha256 = ?').get(sharedSha)).toMatchObject({ n: 1 });
    } finally {
      store.close();
    }

    // Heal: restore the manifest, reopen (the reconciliation re-attempts at
    // every migrate() entry), then the same remove keeps the shared doc.
    writeRetainedManifest(sharerDir, 'sharer-b', [sharedSha]);
    store = openStore({ dbPath, dims: 8 });
    try {
      const db = store.db as unknown as SqlDb;
      expect(
        (db.prepare("SELECT value FROM meta WHERE key = 'doc_claims_reconciled'").get() as { value: string }).value,
      ).toBe('done');
      const healedClaims = db.prepare('SELECT claimant FROM doc_claims ORDER BY claimant').all() as Array<{
        claimant: string;
      }>;
      expect(healedClaims).toEqual([{ claimant: 'pack:owner-a' }, { claimant: 'pack:sharer-b' }]);
      const manager = new PackManager({
        store,
        embedder: new HashEmbedder({ dims: 8 }),
        packsRoot: path.join(dir, 'packs'),
        repoRoot: REPO_ROOT,
      });
      await manager.remove('owner-a');
      expect(db.prepare('SELECT COUNT(*) AS n FROM docs WHERE sha256 = ?').get(sharedSha)).toMatchObject({ n: 1 });
      const surviving = db.prepare('SELECT claimant FROM doc_claims').all() as Array<{ claimant: string }>;
      expect(surviving).toEqual([{ claimant: 'pack:sharer-b' }]);
    } finally {
      store.close();
    }
  });
});
