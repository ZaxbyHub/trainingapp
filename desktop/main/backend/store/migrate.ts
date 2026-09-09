// migrate.ts — Node-side no-op migration skeleton for the B5 store (issue #63).
//
// Establishes the migration pattern B6 (#64) extends: migrate() reads
// meta.schema_version and advances the store through the version ladder. v1
// is the initial schema (contracts/store.schema.sql), so the current
// implementation is a verified no-op — it must never throw on a v1 store and
// must never alter schema_version. Mirror implementation:
// contracts/tests/store-interop/migrate.py.
//
// The better-sqlite3 handle is intentionally typed structurally (the driver
// and this module resolve better-sqlite3 through createRequire so the native
// addon is loaded from desktop/node_modules in both src and dist layouts).

export const CURRENT_SCHEMA_VERSION = 1;

/** Structural subset of a better-sqlite3 Database this module needs. */
export interface StoreDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
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
 * Bring the store to CURRENT_SCHEMA_VERSION. Returns the final version.
 *
 * No-op for a v1 store. Future versions extend this ladder; a store from the
 * future (version > CURRENT) fails loud instead of guessing.
 */
export function migrate(db: StoreDb): number {
  const version = readSchemaVersion(db);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `store schema_version ${version} is newer than this code understands (${CURRENT_SCHEMA_VERSION})`,
    );
  }
  // version === CURRENT_SCHEMA_VERSION: nothing to do for v1 (verified no-op;
  // B6 appends the 1->2 step here).
  return version;
}
