// store/recovery.ts — startup integrity check + corruption recovery (issue #64).
//
// checkStoreIntegrity: read-only open + PRAGMA integrity_check. A file that
// cannot be opened as SQLite at all (garbage, truncated) counts as corrupt —
// the recovery prompt must fire BEFORE the host serves anything from a store
// it cannot trust.
//
// recoverStore: healthy -> 'none'. Corrupt -> prompt via choose() when
// provided (the Electron bootstrap backs this with a modal offering Restore /
// Start fresh; the prompt intentionally blocks host start because a store
// failing integrity cannot be safely served — ADR-0006), otherwise an
// automatic policy: restore from the latest backup when one exists, else
// re-initialize fresh.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { CURRENT_SCHEMA_VERSION } from './migrate.js';
import { latestBackup, restoreBackup } from './backup.js';
import { openStore, type StoreHandle } from './sqlite-store.js';

export type RecoveryChoice = 'restore' | 'fresh';

export interface IntegrityResult {
  ok: boolean;
  /** integrity_check output or the open failure message; never empty when !ok. */
  message: string;
}

type RawDatabaseConstructor = new (
  dbPath: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
};

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports -- native addon resolved at runtime
const RawDatabase = require('better-sqlite3') as RawDatabaseConstructor;

/** Read-only PRAGMA integrity_check; un-openable files are corrupt by definition. */
export function checkStoreIntegrity(dbPath: string): IntegrityResult {
  if (!fs.existsSync(dbPath)) {
    return { ok: false, message: `store file does not exist: ${dbPath}` };
  }
  let db: InstanceType<RawDatabaseConstructor> | null = null;
  try {
    db = new RawDatabase(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('PRAGMA integrity_check').get() as unknown;
    // integrity_check returns one column named like the pragma; both drivers
    // expose it as the first property of the row object.
    const message =
      row === null || typeof row !== 'object'
        ? String(row)
        : String(Object.values(row as Record<string, unknown>)[0] ?? '');
    if (message === 'ok') return { ok: true, message };
    return { ok: false, message: `integrity_check: ${message}` };
  } catch (err) {
    return { ok: false, message: `store is not readable as SQLite: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try {
      db?.close();
    } catch {
      // Already unusable — that is what we are reporting.
    }
  }
}

export interface RecoverStoreOptions {
  dbPath: string;
  backupsDir?: string;
  repoRoot?: string;
  dims: number;
  /** Interactive prompt seam; absent = automatic restore-else-fresh policy. */
  choose?: (info: { dbPath: string; message: string }) => Promise<RecoveryChoice>;
}

export interface RecoverStoreResult {
  action: RecoveryChoice | 'none';
  /** Backup path when action === 'restore'. */
  restoredFrom?: string;
}

/**
 * Re-initialize an empty schema at dbPath after deleting the corrupt file and
 * its sidecars. Returns the fresh handle (caller installs it).
 */
export function reinitializeStore(opts: { dbPath: string; repoRoot?: string; dims: number }): StoreHandle {
  for (const sidecar of [opts.dbPath, `${opts.dbPath}-wal`, `${opts.dbPath}-shm`]) {
    try {
      fs.rmSync(sidecar, { force: true });
    } catch {
      // Best effort; deletion failures resurface on the open below.
    }
  }
  return openStore({ dbPath: opts.dbPath, dims: opts.dims, ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}) });
}

/**
 * Detect corruption and execute the recovery policy. Never throws for a
 * corrupt store — the choice is either executed or, when impossible (restore
 * with no backup), fails LOUD with a clear error rather than silently
 * continuing with a broken store.
 */
export async function recoverStore(opts: RecoverStoreOptions): Promise<RecoverStoreResult> {
  const integrity = checkStoreIntegrity(opts.dbPath);
  if (integrity.ok) return { action: 'none' };

  const choice = opts.choose
    ? await opts.choose({ dbPath: opts.dbPath, message: integrity.message })
    : latestBackup(opts.backupsDir ?? '')
      ? 'restore'
      : 'fresh';

  if (choice === 'restore') {
    const backup = latestBackup(opts.backupsDir ?? '');
    if (backup === null) {
      throw new Error(
        `store is corrupt (${integrity.message}) and no backup exists to restore from; ` +
          'start fresh instead or restore a backup manually',
      );
    }
    await restoreBackup({ backupPath: backup, dbPath: opts.dbPath, dims: opts.dims });
    return { action: 'restore', restoredFrom: backup };
  }

  reinitializeStore({ dbPath: opts.dbPath, repoRoot: opts.repoRoot, dims: opts.dims }).close();
  return { action: 'fresh' };
}

/** The schema version this code understands (recovery re-init target). */
export const RECOVERY_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;
