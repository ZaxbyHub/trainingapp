// store/backup.ts — backup/restore for the per-profile store (issue #64).
//
// createBackup: flush WAL (wal_checkpoint TRUNCATE) and VERIFY the flush
// completed, then copy to <backupsDir>/<UTC-timestamp>/<store.sqlite>. The
// copy is only a complete snapshot when every WAL page reached the main file:
// a busy checkpoint (another connection holds a read snapshot) with
// checkpointed < log leaves a stale-but-VALID main file that would pass
// restoreBackup's validation and silently roll the store back on recovery —
// so that shape fails the backup loud (issue #100 swarm-pr-review PRR-001).
// Timestamp dirs include milliseconds and a monotonic sequence suffix so
// rapid successive backups never collide and sort lexicographically =
// chronologically.
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
// Lazy (first use, never import): importing this module must stay safe on
// machines without the staged native addon (issue #193 D2 gate wiring).
let rawDatabaseCtor: RawDatabaseConstructor | null = null;
function rawDatabase(): RawDatabaseConstructor {
  if (rawDatabaseCtor === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native addon resolved at runtime
    rawDatabaseCtor = require('better-sqlite3') as RawDatabaseConstructor;
  }
  return rawDatabaseCtor;
}

/**
 * Flush WAL so the main db file is a complete, self-consistent snapshot, and
 * verify that it became one (issue #100 swarm-pr-review PRR-001).
 *
 * `PRAGMA wal_checkpoint(TRUNCATE)` returns { busy, log, checkpointed }:
 * busy != 0 means the truncation/flush was refused because another
 * connection holds a read snapshot. The copy below reads ONLY the main file,
 * so it is complete iff every WAL page was written back (checkpointed ===
 * log). Without this check a foreign reader (a DB browser, a second host
 * sharing --store-path) can make createBackup return ok:true with a stale —
 * but validation-passing — snapshot that restoreBackup would later copy over
 * the live store: silent data loss through the recovery path itself.
 */
function checkpoint(store: {
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } };
}): { busy: number; log: number; checkpointed: number } {
  const row = store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
    | { busy?: number | bigint; log?: number | bigint; checkpointed?: number | bigint }
    | undefined;
  const busy = Number(row?.busy ?? 0);
  const log = Number(row?.log ?? 0);
  const checkpointed = Number(row?.checkpointed ?? 0);
  if (busy !== 0 && checkpointed !== log) {
    throw new Error(
      `backup refused: WAL checkpoint incomplete (busy=${busy}, checkpointed=${checkpointed}/${log}) — ` +
        'close other connections to the store file and retry',
    );
  }
  return { busy, log, checkpointed };
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
  const db = new (rawDatabase())(backupPath, { readonly: true });
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
