// migrate.ts — Node-side migration ladder for the B5 store (issue #63).
//
// migrate() reads meta.schema_version and advances the store through the
// version ladder. v1 was the initial schema (contracts/store.schema.sql).
// v2 (D4/#80) finalizes the links table (adds pack_id/rank/computed_at): the
// v1 table was a write-free reserved shape (zero rows by construction — no
// writer ever touched it), so the 1->2 step drops and recreates it losslessly
// and re-stamps meta.schema_version. The step's DDL mirrors the authoritative
// links definition in contracts/store.schema.sql:84-105; the parity pin in
// desktop/src/__tests__/d4-links-store.test.ts fails if the two shapes drift.
// Mirror implementation: contracts/tests/store-interop/migrate.py.
//
// v3 (C3/#70) makes the packs table per-version — PK (id, version) — and adds
// active/install_path (PackManager lifecycle state; mirror: pack_manager.py).
// supersedes becomes a JSON array of "id@version" strings; any legacy scalar
// value is wrapped into a single-element array. docs.pack_id's FK is dropped
// by re-creating docs with the v3 DDL (the FK was inert — connections default
// to foreign_keys OFF and this ladder is the only runtime code that flips them
// ON — but leaving v2-migrated files with a composite-PK
// parent reference would break the day enforcement turns on, so the ladder
// keeps every store byte-consistent with a fresh v3 apply).
//
// v4 (#278) adds the doc_claims table (one row per document claimant) and
// backfills one claim per existing docs row from docs.pack_id ('pack:<id>' /
// 'user'). Because v3 recorded only ONE owner per doc, the backfill alone
// would lose the second pack's claim on shared content, so the step also
// RECONCILES claims from every ACTIVE pack's retained manifest (pack.json at
// the row's stored absolute install_path — no path recomputation). A pack
// whose manifest is unreadable contributes no claims and leaves
// meta.doc_claims_reconciled = 'pending' (fail closed): the claimant-aware
// lifecycle verbs refuse while pending, because a docsMap derived from a
// missing manifest cannot prove which docs the pack claims. The
// reconciliation pass re-runs on every migrate() entry, so a store that
// migrated while a manifest was unavailable heals on the next open once the
// manifest is readable again; a complete pass stamps 'done'.
//
// The better-sqlite3 handle is intentionally typed structurally (the driver
// and this module resolve better-sqlite3 through createRequire so the native
// addon is loaded from desktop/node_modules in both src and dist layouts).

import fs from 'node:fs';
import path from 'node:path';
import { normalizeForSearch } from '../ingest/normalize.js';

export const CURRENT_SCHEMA_VERSION = 5;

/** Structural subset of a better-sqlite3 Database this module needs. */
export interface StoreDb {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
}

function readSchemaVersion(db: StoreDb): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: unknown }
    | undefined;
  if (row === undefined) {
    throw new Error('store is missing meta.schema_version; apply contracts/store.schema.sql first');
  }
  const parsed = Number(row.value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`meta.schema_version is not an integer: ${String(row.value)}`);
  }
  return parsed;
}

/**
 * v1 -> v2: finalize the links table. The v1 reserved table had no writers
 * (D4/#80 introduces the first), so drop-and-recreate loses nothing. The DDL
 * MUST stay byte-equivalent in shape to contracts/store.schema.sql's links
 * definition — the d4-links-store parity pin enforces it.
 */
function migrateV1ToV2(db: StoreDb): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP INDEX IF EXISTS links_slide_id_idx');
    db.exec('DROP TABLE IF EXISTS links');
    db.exec(
      'CREATE TABLE links (\n' +
        '    chunk_id    TEXT NOT NULL REFERENCES chunks(id),\n' +
        '    slide_id    TEXT NOT NULL,\n' +
        '    pack_id     TEXT,\n' +
        '    score       REAL NOT NULL,\n' +
        '    rank        INTEGER NOT NULL,\n' +
        '    computed_at TEXT NOT NULL,\n' +
        '    PRIMARY KEY (chunk_id, slide_id)\n' +
        ')',
    );
    db.exec('CREATE INDEX links_slide_id_idx ON links(slide_id)');
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The connection may be unusable after some failures; surface the cause.
    }
    throw error;
  }
}

/**
 * v2 -> v3 (C3/#70): per-version packs table + lifecycle columns; docs loses
 * its inert packs FK. Every step runs inside one BEGIN IMMEDIATE and mirrors
 * contracts/store.schema.sql's v3 DDL (the c3-schema-migration parity pin
 * enforces shape agreement). The packs row mapping: (id, version, name,
 * published_at, source_class) carried verbatim, active=1 (a v2 packs row
 * represented an installed pack whose chunk rows were live), install_path=NULL
 * (v2 writers were prebuilt wholesale installs with no managed folder),
 * supersedes normalized to a JSON array (scalar ids wrapped; NULL preserved).
 */
function migrateV2ToV3(db: StoreDb): void {
  // Official SQLite schema-change procedure: FK checks must be OFF while the
  // restructure drops parent tables (v2 docs references packs; v2/v3 chunks
  // reference docs). Foreign keys are OFF by default (SQLite's default;
  // better-sqlite3 issues no pragma), and PRAGMA foreign_keys is a no-op
  // inside a transaction — flip BEFORE the BEGIN. The finally sets ON
  // unconditionally: the connection that ran this ladder keeps FKs enforced
  // until it closes (fresh v3 stores never run it and stay OFF; a reopened
  // migrated store connects OFF again). The python mirror
  // (contracts/tests/store-interop/migrate.py) instead restores the pragma's
  // prior value — a recorded divergence, not to be silently unified.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    migrateV2ToV3Inner(db);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrateV2ToV3Inner(db: StoreDb): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(
      'CREATE TABLE packs_v3 (\n' +
        '    id           TEXT NOT NULL,\n' +
        '    version      TEXT NOT NULL,\n' +
        '    name         TEXT NOT NULL,\n' +
        '    published_at TEXT,\n' +
        '    source_class TEXT NOT NULL,\n' +
        '    active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),\n' +
        '    install_path TEXT,\n' +
        '    supersedes   TEXT,\n' +
        '    PRIMARY KEY (id, version)\n' +
        ')',
    );
    // Copy + normalize: wrap a legacy scalar supersedes id into a JSON array;
    // NULL (the only value any v2 writer ever produced) stays NULL.
    const legacyPacks = db
      .prepare('SELECT id, version, name, published_at, source_class, supersedes FROM packs')
      .all() as Array<Record<string, unknown>>;
    const insertV3 = db.prepare(
      'INSERT INTO packs_v3 (id, version, name, published_at, source_class, active, install_path, supersedes) ' +
        'VALUES (?, ?, ?, ?, ?, 1, NULL, ?)',
    );
    for (const row of legacyPacks) {
      const raw = row['supersedes'];
      const normalized =
        raw === null || raw === undefined || (typeof raw === 'string' && raw.startsWith('['))
          ? raw === undefined
            ? null
            : (raw as string)
          : JSON.stringify([String(raw)]);
      insertV3.run(
        row['id'],
        row['version'],
        row['name'],
        row['published_at'] ?? null,
        row['source_class'],
        normalized ?? null,
      );
    }
    db.exec('DROP TABLE packs');
    db.exec('ALTER TABLE packs_v3 RENAME TO packs');

    // docs: re-create with the v3 DDL (pack_id FK dropped). Foreign keys are
    // OFF for the duration of this migration (the pragma flip above), so the
    // drop is behavior-preserving; re-creating keeps migrated files
    // identical in shape to a fresh v3 apply.
    db.exec(
      'CREATE TABLE docs_v3 (\n' +
        '    id           TEXT PRIMARY KEY,\n' +
        '    source_class TEXT NOT NULL,\n' +
        '    path         TEXT NOT NULL,\n' +
        '    sha256       TEXT NOT NULL,\n' +
        '    title        TEXT,\n' +
        '    published_at TEXT,\n' +
        '    pack_id      TEXT\n' +
        ')',
    );
    db.exec(
      'INSERT INTO docs_v3 (id, source_class, path, sha256, title, published_at, pack_id) ' +
        'SELECT id, source_class, path, sha256, title, published_at, pack_id FROM docs',
    );
    db.exec('DROP INDEX IF EXISTS docs_sha256_uq');
    db.exec('DROP TABLE docs');
    db.exec('ALTER TABLE docs_v3 RENAME TO docs');
    db.exec('CREATE UNIQUE INDEX docs_sha256_uq ON docs(sha256)');

    db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The connection may be unusable after some failures; surface the cause.
    }
    throw error;
  }
}

/** Minimal manifest shape the v4 reconciliation reads from pack.json. */
interface ReconcileManifest {
  docs: Array<{ sha256?: unknown }>;
}

/**
 * Read an installed pack's retained manifest from its stored absolute
 * install_path (Binding Phase-4 note: pack.json is read from install_path
 * itself — the store dir is never consulted to recompute the path). Returns
 * null when the manifest is missing, unparseable, or malformed — the caller
 * decides what that means.
 */
function readPackManifestOrNull(installPath: string): ReconcileManifest | null {
  try {
    const raw = fs.readFileSync(path.join(installPath, 'pack.json'));
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const docs = (parsed as { docs?: unknown }).docs;
    if (!Array.isArray(docs)) return null;
    return { docs: docs as ReconcileManifest['docs'] };
  } catch {
    return null;
  }
}

/**
 * Reconcile pack claims from every ACTIVE pack's retained manifest: for each
 * listed doc sha, resolve the store docs.id by content hash and INSERT OR
 * IGNORE the (doc_id, 'pack:<id>') claim. Inactive versions contribute
 * nothing (their claims arrive when they are activated). A row with a NULL
 * install_path (packtool wholesale rows, which retain no managed folder)
 * contributes nothing either — its docs keep the docs.pack_id-derived
 * backfill claim. Returns true when any active pack's manifest was
 * unreadable (the caller stamps the pending marker).
 */
function reconcileDocClaimsLocked(db: StoreDb): boolean {
  const rows = db
    .prepare('SELECT id, version, install_path FROM packs WHERE active = 1')
    .all() as Array<{ id: unknown; version: unknown; install_path: unknown }>;
  const insertClaim = db.prepare('INSERT OR IGNORE INTO doc_claims (doc_id, claimant) VALUES (?, ?)');
  const findDocId = db.prepare('SELECT id FROM docs WHERE sha256 = ?');
  let pending = false;
  for (const row of rows) {
    if (typeof row.install_path !== 'string' || row.install_path.length === 0) continue;
    const manifest = readPackManifestOrNull(row.install_path);
    if (manifest === null) {
      pending = true;
      continue;
    }
    const claimant = `pack:${String(row.id)}`;
    for (const entry of manifest.docs) {
      if (typeof entry?.sha256 !== 'string') continue;
      const doc = findDocId.get(entry.sha256) as { id: unknown } | undefined;
      // Manifest shas are lowercase by validation; tolerate a mixed-case row.
      const byLower =
        doc === undefined
          ? (findDocId.get(entry.sha256.toLowerCase()) as { id: unknown } | undefined)
          : undefined;
      const docId = doc ?? byLower;
      if (docId !== undefined && typeof docId.id === 'string') {
        insertClaim.run(docId.id, claimant);
      }
    }
  }
  return pending;
}

/** Stamp the reconciliation marker (INSERT OR REPLACE: a fresh v4 apply has
 * no row yet; every later pass overwrites the previous state). */
function stampReconciled(db: StoreDb, pending: boolean): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('doc_claims_reconciled', ?)").run(
    pending ? 'pending' : 'done',
  );
}

/**
 * Reconciliation re-attempt for stores already at v4: runs on EVERY migrate()
 * entry (not only the v3->v4 step) so a store that migrated while an active
 * manifest was unreadable heals on the next open. Idempotent: claims are
 * INSERT OR IGNORE and a complete pass re-stamps 'done'.
 */
function reconcileDocClaims(db: StoreDb): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    stampReconciled(db, reconcileDocClaimsLocked(db));
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The connection may be unusable after some failures; surface the cause.
    }
    throw error;
  }
}

/**
 * v3 -> v4 (#278): create doc_claims, backfill one claim per docs row from
 * its recorded owner (pack_id NOT NULL -> 'pack:<id>'; NULL -> 'user'; an
 * orphaned docs row whose pack_id names a removed pack backfills the dead
 * claim — retrieval's active-pack join excludes it, consistently), then run
 * the manifest reconciliation inside the same transaction and stamp the
 * marker. The DDL matches the authoritative contracts/store.schema.sql.
 */
function migrateV3ToV4(db: StoreDb): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(
      'CREATE TABLE doc_claims (\n' +
        '    doc_id     TEXT NOT NULL,\n' +
        '    claimant   TEXT NOT NULL,\n' +
        '    PRIMARY KEY (doc_id, claimant)\n' +
        ')',
    );
    db.exec(
      "INSERT OR IGNORE INTO doc_claims (doc_id, claimant) " +
        "SELECT id, 'pack:' || pack_id FROM docs WHERE pack_id IS NOT NULL",
    );
    db.exec(
      "INSERT OR IGNORE INTO doc_claims (doc_id, claimant) " +
        "SELECT id, 'user' FROM docs WHERE pack_id IS NULL",
    );
    stampReconciled(db, reconcileDocClaimsLocked(db));
    db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The connection may be unusable after some failures; surface the cause.
    }
    throw error;
  }
}

/**
 * v4 -> v5 (issue #281, Workstream E): rebuild the derived lexical mirror
 * chunks_fts from chunks.text through normalizeForSearch so documents whose
 * extracted text carries Word optional hyphens, zero-width characters,
 * ligatures or fullwidth forms are found by the plain query the user types.
 * Identity is untouched: chunks.text, chunk ids and content_hash are
 * byte-identical (ADR-0004); only the mirror rows change.
 */
function migrateV4ToV5(db: StoreDb): void {
  try {
    rebuildChunksFtsNormalized(db);
  } catch (error) {
    // pr323 review PRR-002: a malformed FTS5 inverted index makes even
    // DELETE FROM chunks_fts raise SQLITE_CORRUPT_VTAB. At base that fault
    // surfaced at query time and degraded only the lexical leg; if it
    // propagated from here, openStore would fail and the corruption-recovery
    // path would rmSync the WHOLE store (chunks, docs, embeddings) over a
    // damaged DERIVED mirror. Recover inside the migration instead: drop the
    // virtual table and recreate it from the authoritative DDL (mirrors
    // contracts/store.schema.sql; schema-bump-guard pins that file's hash so
    // drift fails CI), leaving identity tables untouched. Worst case is an
    // empty lexical mirror — never a deleted corpus.
    try {
      db.exec('ROLLBACK');
    } catch {
      // The connection may be unusable after some failures; best effort.
    }
    recoverChunksFts(db, error);
    return;
  }
  // Heal a pending manifest reconciliation in the same open (mirrors the
  // v3->v4 step; the else-branch reconcile only runs for already-v5 stores,
  // so without this a v4 store with doc_claims_reconciled='pending' healed
  // one open later than before — impl-review r1 question).
  stampReconciled(db, reconcileDocClaimsLocked(db));
}

const CHUNKS_FTS_DDL =
  'CREATE VIRTUAL TABLE chunks_fts USING fts5 (chunk_id UNINDEXED, text)';

function rebuildChunksFtsNormalized(db: StoreDb): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM chunks_fts');
    // Paged reads (not one .all()): a large store must not materialize every
    // chunk row in memory inside the write transaction (impl-review r1
    // question). better-sqlite3 cannot INSERT on a connection that is mid-
    // iterate, so page by rowid instead.
    const insertFts = db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
    const page = db.prepare(
      'SELECT rowid, id, text FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT 500',
    );
    let lastRowid = 0;
    for (;;) {
      const batch = page.all(lastRowid) as Array<{ rowid: number; id: string; text: string }>;
      if (batch.length === 0) break;
      for (const row of batch) {
        insertFts.run(row.id, normalizeForSearch(row.text));
      }
      const last = batch.at(-1);
      if (last) lastRowid = last.rowid;
    }
    db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The connection may be unusable after some failures; surface the cause.
    }
    throw error;
  }
}

/**
 * Last-resort recovery when the in-place FTS rebuild fails on a damaged
 * virtual table: drop and recreate chunks_fts from the authoritative DDL and
 * repopulate what the identity tables still hold. If even the drop/recreate
 * fails, stamp v5 with the mirror degraded (lexical leg errors per query at
 * worst — the pre-#323 behavior) rather than letting the open failure route
 * the store into rmSync. Throws only when the database file itself is
 * unusable (even the v5 stamp fails) — plain mirror damage never does.
 */
function recoverChunksFts(db: StoreDb, cause: unknown): void {
  const detail = cause instanceof Error ? cause.message : String(cause);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('DROP TABLE IF EXISTS chunks_fts');
    db.exec(CHUNKS_FTS_DDL);
    try {
      // Paged like the in-place rebuild: a large corpus must not materialize
      // every chunk row inside the write transaction (impl-review r1).
      const insertFts = db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
      const page = db.prepare(
        'SELECT rowid, id, text FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT 500',
      );
      let lastRowid = 0;
      for (;;) {
        const batch = page.all(lastRowid) as Array<{ rowid: number; id: string; text: string }>;
        if (batch.length === 0) break;
        for (const row of batch) {
          insertFts.run(row.id, normalizeForSearch(row.text));
        }
        const last = batch.at(-1);
        if (last) lastRowid = last.rowid;
      }
    } catch (repopulateError) {
      // The fresh table is usable; a partial repopulation is a degraded
      // mirror, not a corpus loss. Keep the version stamp.
      console.error(
        `[trainingapp] chunks_fts repopulation incomplete after FTS corruption `
          + `(${repopulateError instanceof Error ? repopulateError.message : String(repopulateError)}); `
          + 'lexical recall is degraded until the affected documents are re-ingested',
      );
    }
    db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
    db.exec('COMMIT');
    console.error(
      `[trainingapp] chunks_fts was corrupt and could not be rebuilt in place `
        + `(${detail}); the mirror was dropped and recreated from chunks.text. `
        + 'Identity tables are untouched.',
    );
  } catch (fatalError) {
    // Even DROP/recreate failed: stamp v5 so the ladder advances and the
    // lexical leg degrades per-query (the pre-#323 corruption behavior)
    // instead of the open failure routing the store into rmSync.
    console.error(
      `[trainingapp] chunks_fts recovery failed (${fatalError instanceof Error ? fatalError.message : String(fatalError)}); `
        + 'stamping schema v5 with a degraded lexical mirror — the corpus is preserved',
    );
    // The transaction opened above may still be active on this connection
    // (better-sqlite3 does not auto-rollback on a failed DDL); stamping
    // requires a clean transaction state (fix-reviewer r1).
    try {
      db.exec('ROLLBACK');
    } catch {
      // Nothing was open — fine.
    }
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
      db.exec('COMMIT');
    } catch {
      // The database file itself is unusable; surface the original cause.
      throw new Error(`chunks_fts recovery failed and the store could not be stamped: ${detail}`);
    }
  }
}

/**
 * Bring the store to CURRENT_SCHEMA_VERSION. Returns the final version.
 * Future versions extend this ladder; a store from the future (version >
 * CURRENT) fails loud instead of guessing.
 */
export function migrate(db: StoreDb): number {
  const version = readSchemaVersion(db);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `store schema_version ${version} is newer than this code understands (${CURRENT_SCHEMA_VERSION})`,
    );
  }
  if (version < 2) {
    migrateV1ToV2(db);
  }
  if (version < 3) {
    migrateV2ToV3(db);
  }
  if (version < 4) {
    migrateV3ToV4(db);
  }
  if (version < 5) {
    migrateV4ToV5(db);
  } else {
    // Stores already at v5 re-attempt the manifest reconciliation on every
    // migrate() entry (heals a pending store once its manifest is readable).
    reconcileDocClaims(db);
  }
  return readSchemaVersion(db);
}
