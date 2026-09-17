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
// by re-creating docs with the v3 DDL (the FK was inert — no runtime enables
// PRAGMA foreign_keys — but leaving v2-migrated files with a composite-PK
// parent reference would break the day enforcement turns on, so the ladder
// keeps every store byte-consistent with a fresh v3 apply).
//
// The better-sqlite3 handle is intentionally typed structurally (the driver
// and this module resolve better-sqlite3 through createRequire so the native
// addon is loaded from desktop/node_modules in both src and dist layouts).

export const CURRENT_SCHEMA_VERSION = 3;

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
  // reference docs). better-sqlite3 runs with foreign_keys ON by default, and
  // PRAGMA foreign_keys is a no-op inside a transaction — flip BEFORE the
  // BEGIN and back ON in the finally. Mirror: contracts/tests/store-interop/
  // migrate.py.
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

    // docs: re-create with the v3 DDL (pack_id FK dropped). FKs are never
    // enforced today, so the drop is behavior-preserving; re-creating keeps
    // migrated files identical in shape to a fresh v3 apply.
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
  return readSchemaVersion(db);
}
