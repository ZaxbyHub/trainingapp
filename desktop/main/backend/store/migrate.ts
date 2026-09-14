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
// The better-sqlite3 handle is intentionally typed structurally (the driver
// and this module resolve better-sqlite3 through createRequire so the native
// addon is loaded from desktop/node_modules in both src and dist layouts).

export const CURRENT_SCHEMA_VERSION = 2;

/** Structural subset of a better-sqlite3 Database this module needs. */
export interface StoreDb {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
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
  return readSchemaVersion(db);
}
