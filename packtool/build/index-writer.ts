// build/index-writer.ts — writes the pack's prebuilt index.sqlite (issue #79).
//
// Applies the AUTHORITATIVE schema (contracts/store.schema.sql — loaded from
// disk, never copied) with the __EMBEDDING_DIMS__ token substituted, loads the
// pinned sqlite-vec extension BEFORE any vec0 DDL, then inserts this pack's
// rows in one transaction. Row shapes byte-match the runtime ingest
// (desktop/main/backend/ingest/pipeline.ts): embeddings as JSON arrays, chunk
// ids = sha256(`${docId}:${chunkIndex}:${normalized}`), meta.embedding_model_id
// stamped after COMMIT.
//
// The index carries exactly one packs row (this pack) so docs.pack_id is
// satisfiable under FK enforcement and an installer can copy every table
// wholesale. This module is ALSO the single local DDL-apply surface the
// acceptance install test reuses (one applySchema/insertPair implementation —
// no duplicated DDL, no desktop cross-package import).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { PackManifest } from './pack-json.js';

export const SCHEMA_RELATIVE_PATH = 'contracts/store.schema.sql';
export const EMBEDDING_DIMS_TOKEN = '__EMBEDDING_DIMS__';

/** Structural subset of better-sqlite3's API this module uses. */
export interface StoreDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

const require = createRequire(import.meta.url);
// Native addons resolved at runtime (CJS from ESM; mirrors sqlite-store.ts).
type DatabaseConstructor = new (path: string) => StoreDb;
const Database = require('better-sqlite3') as DatabaseConstructor;
const sqliteVec = require('sqlite-vec') as { load(db: StoreDb): void };

/** Walk up from startDir to the directory owning contracts/store.schema.sql. */
export function findRepoRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(dir, SCHEMA_RELATIVE_PATH))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** The DDL with __EMBEDDING_DIMS__ substituted (read from disk, never copied). */
export function loadSchemaSql(repoRoot: string, dims: number): string {
  const raw = fs.readFileSync(path.join(repoRoot, SCHEMA_RELATIVE_PATH), 'utf8');
  const sql = raw.split(EMBEDDING_DIMS_TOKEN).join(String(dims));
  if (sql.includes(EMBEDDING_DIMS_TOKEN)) {
    // Parity with sqlite-store.ts: a surviving token means a divergent schema
    // file — refuse rather than write a store with a malformed vec0 DDL.
    throw new Error(`failed to substitute ${EMBEDDING_DIMS_TOKEN} in ${SCHEMA_RELATIVE_PATH}`);
  }
  return sql;
}

/**
 * Open a fresh store file with the pinned schema. sqlite-vec MUST load before
 * the vec0 DDL executes. Exposed for the acceptance install test so the test's
 * "profile store" is created by the same code path as the pack index.
 */
export function openStoreWithSchema(dbPath: string, dims: number, repoRoot: string): StoreDb {
  const db = new Database(dbPath);
  try {
    sqliteVec.load(db);
    db.exec(loadSchemaSql(repoRoot, dims));
    return db;
  } catch (error) {
    // Never leak the native handle on a failed open: an open handle makes
    // subsequent temp-dir cleanup fail with EPERM on Windows.
    try {
      db.close();
    } catch {
      // fall through — the original error is the useful one
    }
    throw error;
  }
}

export interface PackIndexDocRow {
  docId: string;
  /** Pack-relative doc path (docs/...), matching the manifest entry. */
  path: string;
  sha256: string;
  title: string;
  publishedAt: string;
}

export interface PackIndexChunkRow {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
  vector: number[];
}

/** One precomputed doc-chunk -> training-slide link (D4/#80). */
export interface PackIndexLinkRow {
  chunkId: string;
  slideId: string;
  /** Owning doc pack id; null for unpackaged docs. */
  packId: string | null;
  score: number;
  rank: number;
  computedAt: string;
}

export interface WritePackIndexOptions {
  dbPath: string;
  repoRoot: string;
  dims: number;
  manifest: PackManifest;
  docs: PackIndexDocRow[];
  chunks: PackIndexChunkRow[];
  /** Optional precomputed links (packtool links / #73 build-docs). */
  links?: PackIndexLinkRow[];
}

/**
 * Create the pack index: schema + one packs row + docs/chunks/embeddings/fts
 * rows + meta stamps, all in one transaction. Vector serialization is
 * JSON.stringify (pipeline.ts:381 parity).
 */
export function writePackIndex(options: WritePackIndexOptions): void {
  const { dbPath, repoRoot, dims, manifest, docs, chunks, links } = options;
  const db = openStoreWithSchema(dbPath, dims, repoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const insertPack = db.prepare(
        'INSERT INTO packs (id, name, version, published_at, source_class, supersedes) VALUES (?, ?, ?, ?, ?, NULL)',
      );
      insertPack.run(manifest.id, manifest.name, manifest.version, manifest.published_at, manifest.source_class);

      const insertDoc = db.prepare(
        'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const doc of docs) {
        // source_class flows from the manifest (never hardcoded), so the
        // packs and docs rows can never disagree (PR review WD-1).
        insertDoc.run(doc.docId, manifest.source_class, doc.path, doc.sha256, doc.title, doc.publishedAt, manifest.id);
      }

      const insertChunk = db.prepare(
        'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)',
      );
      const insertVector = db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)');
      const insertFts = db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
      for (const chunk of chunks) {
        insertChunk.run(chunk.chunkId, chunk.docId, chunk.chunkIndex, chunk.text, chunk.contentHash);
        insertVector.run(chunk.chunkId, JSON.stringify(chunk.vector));
        insertFts.run(chunk.chunkId, chunk.text);
      }

      if (links !== undefined && links.length > 0) {
        const insertLink = db.prepare(
          'INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES (?, ?, ?, ?, ?, ?)',
        );
        for (const link of links) {
          insertLink.run(link.chunkId, link.slideId, link.packId, link.score, link.rank, link.computedAt);
        }
      }

      const setModel = db.prepare("UPDATE meta SET value = ? WHERE key = 'embedding_model_id'");
      setModel.run(manifest.embedding.model_id);

      db.exec('COMMIT');
    } catch (error) {
      // Preserve the ORIGINAL error if the rollback itself fails (PR review
      // C1) — a throwing ROLLBACK must not mask why the transaction failed.
      try {
        db.exec('ROLLBACK');
      } catch {
        // nothing to roll back, or rollback failed — original error wins
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * Copy a pack index's rows into an existing (profile-shaped) store without
 * invoking any embedder — the install side of the "zero client-side
 * re-embedding" acceptance proof. Rows are copied verbatim from the prebuilt
 * index (both files already carry the pinned schema), so install is pure data
 * movement.
 *
 * Precondition (PR review C2): targetDb must NOT hold an active transaction —
 * the BEGIN IMMEDIATE here would fail with "cannot start a transaction within
 * a transaction". Callers on a live profile store should run this on a quiet
 * connection (the store schema's single-writer assumption).
 */
export function installPackRows(
  targetDb: StoreDb,
  sourceDbPath: string,
): { docs: number; chunks: number; links: number } {
  let source: StoreDb | null = null;
  try {
    source = new Database(sourceDbPath);
    try {
      sqliteVec.load(source);
    } catch (error) {
      try {
        source.close();
      } catch {
        // the load error is the useful one
      }
      source = null;
      throw error;
    }
    const packRows = source.prepare('SELECT id, name, version, published_at, source_class, supersedes FROM packs').all() as Array<
      Record<string, unknown>
    >;
    const docRows = source
      .prepare('SELECT id, source_class, path, sha256, title, published_at, pack_id FROM docs')
      .all() as Array<Record<string, unknown>>;
    const chunkRows = source
      .prepare('SELECT id, doc_id, chunk_index, text, content_hash FROM chunks')
      .all() as Array<Record<string, unknown>>;
    const vectorRows = source
      .prepare('SELECT chunk_id, embedding FROM embeddings')
      .all() as Array<Record<string, unknown>>;
    const ftsRows = source
      .prepare('SELECT chunk_id, text FROM chunks_fts')
      .all() as Array<Record<string, unknown>>;
    // D4/#80: links are part of the pack's precomputed payload — a wholesale
    // install that skipped them would silently strip the pack's slide links.
    const linkRows = source
      .prepare('SELECT chunk_id, slide_id, pack_id, score, rank, computed_at FROM links')
      .all() as Array<Record<string, unknown>>;

    targetDb.exec('BEGIN IMMEDIATE');
    try {
      const insertPack = targetDb.prepare(
        'INSERT INTO packs (id, name, version, published_at, source_class, supersedes) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const row of packRows) {
        insertPack.run(row['id'], row['name'], row['version'], row['published_at'], row['source_class'], row['supersedes']);
      }
      const insertDoc = targetDb.prepare(
        'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const row of docRows) {
        insertDoc.run(row['id'], row['source_class'], row['path'], row['sha256'], row['title'], row['published_at'], row['pack_id']);
      }
      const insertChunk = targetDb.prepare(
        'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)',
      );
      for (const row of chunkRows) {
        insertChunk.run(row['id'], row['doc_id'], row['chunk_index'], row['text'], row['content_hash']);
      }
      const insertVector = targetDb.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)');
      for (const row of vectorRows) {
        insertVector.run(row['chunk_id'], row['embedding']);
      }
      const insertFts = targetDb.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
      for (const row of ftsRows) {
        insertFts.run(row['chunk_id'], row['text']);
      }
      const insertLink = targetDb.prepare(
        'INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const row of linkRows) {
        insertLink.run(
          row['chunk_id'],
          row['slide_id'],
          row['pack_id'],
          row['score'],
          row['rank'],
          row['computed_at'],
        );
      }
      const setModel = targetDb.prepare("UPDATE meta SET value = ? WHERE key = 'embedding_model_id'");
      if (packRows[0] !== undefined) {
        // The installing store must record the pack's embedding model so a
        // mismatch with the runtime embedder is detectable (C8 hardens this).
        const embModel = source.prepare("SELECT value FROM meta WHERE key = 'embedding_model_id'").get() as
          | { value: string }
          | undefined;
        setModel.run(embModel?.value ?? '');
      }
      targetDb.exec('COMMIT');
    } catch (error) {
      // Preserve the ORIGINAL error if the rollback itself fails (PR review
      // C1) — a throwing ROLLBACK must not mask why the transaction failed.
      try {
        targetDb.exec('ROLLBACK');
      } catch {
        // nothing to roll back, or rollback failed — original error wins
      }
      throw error;
    }
    return { docs: docRows.length, chunks: chunkRows.length, links: linkRows.length };
  } finally {
    source?.close();
  }
}
