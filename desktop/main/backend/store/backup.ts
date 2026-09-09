// store/backup.ts — backup/restore for the per-profile store (issue #64).
//
// createBackup: flush WAL (wal_checkpoint TRUNCATE — after it the -wal file is
// empty, so copying the main db file alone is a complete snapshot) then copy
// to <backupsDir>/<UTC-timestamp>/<store.sqlite>. Timestamp dirs include
// milliseconds and a monotonic sequence suffix so rapid successive backups
// never collide and sort lexicographically = chronologically.
//
// restoreBackup: validate the backup (schema_version integer in
// [1, CURRENT_SCHEMA_VERSION], embedding_dims match) BEFORE touching the
// active file — a refused restore leaves the active bytes identical. Stale
// -wal/-shm sidecars are removed so an old log cannot desynchronize the
// restored snapshot.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION } from './migrate.js';

export interface BackupResult {
  path: string;
  bytes: number;
}

/** Structural subset of better-sqlite3 used for the read-only validation. */
interface RawDb {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
}

type RawDatabaseConstructor = new (dbPath: string, options?: { readonly?: boolean }) => RawDb;

// Resolve better-sqlite3 through this module's package context so the native
// addon loads from desktop/node_modules in both src and dist layouts (same
// pattern as sqlite-store.ts).
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports -- native addon resolved at runtime
const RawDatabase = require('better-sqlite3') as RawDatabaseConstructor;

/** Flush WAL so the main db file is a complete, self-consistent snapshot. */
function checkpoint(store: { db: { prepare(sql: string): { get(...params: unknown[]): unknown } } }): void {
  store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
}

function timestampDirName(sequence: number): string {
  const now = new Date();
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  const base =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}T` +
    `${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}${pad(now.getUTCMilliseconds(), 3)}`;
  return `${base}-${String(sequence).padStart(4, '0')}`;
}

let backupSequence = 0;

/** Create a consistent backup of the OPEN store under <backupsDir>/<ts>/. */
export function createBackup(store: { dbPath: string; db: { prepare(sql: string): { get(...params: unknown[]): unknown } } }, backupsDir: string): BackupResult {
  checkpoint(store);
  let target: string;
  do {
    backupSequence = (backupSequence + 1) % 10000;
    target = path.join(backupsDir, timestampDirName(backupSequence), 'store.sqlite');
  } while (fs.existsSync(target));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Stage-then-publish (PRR-002): a crash mid-copy leaves only an invisible
  // .part sibling — latestBackup() selects store.sqlite only, so a partial
  // copy can never be picked for restore.
  const staging = `${target}.part`;
  try {
    fs.copyFileSync(store.dbPath, staging);
    fs.renameSync(staging, target);
  } catch (err) {
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      // Best effort; a leftover .part is never selected for restore.
    }
    throw err;
  }
  return { path: target, bytes: fs.statSync(target).size };
}

/**
 * Most recent backup's store.sqlite path (lexicographic = chronological), or
 * null when the directory holds none.
 */
export function latestBackup(backupsDir: string): string | null {
  if (!fs.existsSync(backupsDir)) return null;
  const dirs = fs
    .readdirSync(backupsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const dirName = dirs[i];
    if (dirName === undefined) continue;
    const candidate = path.join(backupsDir, dirName, 'store.sqlite');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface BackupMeta {
  schemaVersion: number;
  embeddingDims: number;
}

function readBackupMeta(backupPath: string): BackupMeta {
  const db = new RawDatabase(backupPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: unknown }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const schemaVersion = Number(map.get('schema_version'));
    const embeddingDims = Number(map.get('embedding_dims'));
    if (!Number.isInteger(schemaVersion)) {
      throw new Error('backup is missing a valid meta.schema_version; refusing to restore');
    }
    if (!Number.isInteger(embeddingDims)) {
      throw new Error('backup is missing a valid meta.embedding_dims; refusing to restore');
    }
    return { schemaVersion, embeddingDims };
  } finally {
    db.close();
  }
}

export interface RestoreOptions {
  backupPath: string;
  /** Active store file to replace. */
  dbPath: string;
  dims: number;
}

/**
 * Replace the active store with a VALIDATED backup. Validation opens the
 * backup read-only BEFORE any active byte changes; on refusal the active file
 * is byte-identical to before the call.
 */
export async function restoreBackup(opts: RestoreOptions): Promise<{ schemaVersion: number }> {
  const meta = readBackupMeta(opts.backupPath);
  if (meta.schemaVersion < 1 || meta.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `backup schema_version ${meta.schemaVersion} is outside this code's range (1..${CURRENT_SCHEMA_VERSION}); ` +
        'refusing to restore',
    );
  }
  if (meta.embeddingDims !== opts.dims) {
    throw new Error(
      `backup embedding_dims ${meta.embeddingDims} does not match the active store's dims ${opts.dims}; ` +
        'refusing to restore',
    );
  }
  fs.copyFileSync(opts.backupPath, opts.dbPath);
  for (const sidecar of [`${opts.dbPath}-wal`, `${opts.dbPath}-shm`]) {
    try {
      fs.rmSync(sidecar, { force: true });
    } catch {
      // Best effort; a missing sidecar is the normal case.
    }
  }
  return { schemaVersion: meta.schemaVersion };
}
