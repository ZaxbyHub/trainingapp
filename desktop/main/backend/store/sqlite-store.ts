// sqlite-store.ts — Node-side store module for the shared per-profile SQLite
// store (issue #63 / workstream B5).
//
// Opens a better-sqlite3 connection, loads the pinned sqlite-vec extension,
// applies the AUTHORITATIVE schema (contracts/store.schema.sql — loaded from
// disk, never copied), verifies meta.schema_version, and runs the no-op
// migrate() ladder. Ingestion/retrieval wiring over this store arrives with
// B6 (#64)/B7 (#65); the NodeBackendHost start path opens (and stop path
// closes) the store so the contract is exercised from a real production
// entry point.
//
// Native note (docs/adr/0005): better-sqlite3 is a Node-ABI native addon and
// sqlite-vec a platform DLL — this module works under plain Node (dev-server,
// vitest, CI) and in unpacked-Electron layouts; packaged-asar loading is
// owned by #84. Electron-free: safe to import from the headless dev-server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { migrate } from './migrate.js';

/** The authoritative schema file, relative to the repository root. */
export const SCHEMA_RELATIVE_PATH = 'contracts/store.schema.sql';

/**
 * Embedding dimension used when a caller does not pin one. 384 matches the
 * current Python-side embedder (BAAI/bge-small-en-v1.5, vector_store.py);
 * the production value is decided by ADR-0001 (#55, still open) and is
 * recorded per-store in meta.embedding_dims — never hardcode a width into
 * the schema itself.
 */
export const DEFAULT_EMBEDDING_DIMS = 384;

/** The DDL token the schema uses for the parameterized embedding width. */
export const EMBEDDING_DIMS_TOKEN = '__EMBEDDING_DIMS__';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native addons resolved at runtime (see file header)
const Database = require('better-sqlite3') as new (path: string) => BetterSqlite3Db;
// eslint-disable-next-line @typescript-eslint/no-var-requires -- see above
const sqliteVec = require('sqlite-vec') as { load(db: BetterSqlite3Db): void };

/** Structural subset of a better-sqlite3 Database this module uses. */
interface BetterSqlite3Db {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
}

export interface StoreOptions {
  /** Absolute path of the store file (created on first open). */
  dbPath: string;
  /** Embedding width for the vec0 table; defaults to DEFAULT_EMBEDDING_DIMS. */
  dims?: number;
  /** Repository root (where contracts/ lives). Auto-discovered by default. */
  repoRoot?: string;
}

export interface StoreHandle {
  db: BetterSqlite3Db;
  dims: number;
  schemaVersion: number;
  close(): void;
}

/** Locate the repository root by walking up to the authoritative schema. */
export function findRepoRoot(startDir: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(dir, SCHEMA_RELATIVE_PATH))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate ${SCHEMA_RELATIVE_PATH} above ${startDir}`);
}

function assertValidDims(dims: number): void {
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`embedding dims must be a positive integer, got ${String(dims)}`);
  }
}

/** Read the schema file and substitute the parameterized embedding width. */
export function loadSchemaSql(repoRoot: string, dims: number): string {
  assertValidDims(dims);
  const raw = fs.readFileSync(path.join(repoRoot, SCHEMA_RELATIVE_PATH), 'utf8');
  const sql = raw.split(EMBEDDING_DIMS_TOKEN).join(String(dims));
  if (sql.includes(EMBEDDING_DIMS_TOKEN)) {
    throw new Error(`failed to substitute ${EMBEDDING_DIMS_TOKEN} in ${SCHEMA_RELATIVE_PATH}`);
  }
  return sql;
}

/** Close a store handle returned by openStore (host stop path). */
export function closeStore(handle: StoreHandle): void {
  handle.close();
}

/**
 * Open (creating if needed) and initialize the store: load sqlite-vec, apply
 * the authoritative schema (idempotent — an existing store at the current
 * schema_version is left untouched), run the migrate() ladder, and return a
 * handle. Throws on any failure; callers that treat the store as optional
 * (NodeBackendHost start) wrap this in failure isolation.
 */
export function openStore(options: StoreOptions): StoreHandle {
  const dims = options.dims ?? DEFAULT_EMBEDDING_DIMS;
  assertValidDims(dims);
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const schemaSql = loadSchemaSql(repoRoot, dims);

  fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
  const db = new Database(options.dbPath);
  try {
    sqliteVec.load(db); // must precede any vec0 DDL/DML
    // Probe table EXISTENCE (not a meta read): on a fresh file the meta table
    // does not exist yet, and a SELECT against it would throw.
    const existing = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get() as { name: string } | undefined;
    if (existing === undefined) {
      db.exec(schemaSql);
    }
    const schemaVersion = migrate(db);
    return {
      db,
      dims,
      schemaVersion,
      close: () => db.close(),
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
