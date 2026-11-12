// c3-fts-reindex-migration.test.ts — E-AC7 (issue #281): a desktop store
// created at the previous schema version rebuilds chunks_fts from chunks.text
// through normalizeForSearch on first open under v5, advances the version, and
// leaves chunks, embeddings and docs rows byte-identical. Dedicated spec (the
// frozen C7 surface); the ladder pins live in c3-schema-migration.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../main/backend/store/sqlite-store.js';
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
const itReal = nativeDepsIt('c3-fts-reindex-migration');
const SOFT = String.fromCharCode(0x00ad);
const ZWSP = String.fromCharCode(0x200b);
const LIG = String.fromCharCode(0xfb02);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface SqlDbShape {
  prepare(sql: string): {
    run(...p: unknown[]): unknown;
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

describe('c3 E-AC7: the v5 re-index migration (issue #281)', () => {
  itReal('a v4 store rebuilds chunks_fts normalized on first open; identity tables byte-identical', async () => {
    const { openStore: open } = await import('../../main/backend/store/sqlite-store.js');
    void open;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-reindex-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'store.db');

    // Seed a real CURRENT-schema store via the production open path, then
    // regress it to a faithful v4 shape: raw variant mirror rows, version 4.
    const seed = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    const db = seed.db as unknown as SqlDbShape;
    db.exec(
      "INSERT INTO docs (id, source_class, path, sha256) VALUES ('doc-1', 'general', 'docs/a.md', 'sha-a')",
    );
    const rawTexts = [
      `first${SOFT}line ef${SOFT}ficacy`,
      `he${ZWSP}moglobin ${LIG}ow protocol`,
    ];
    const identityRows: Array<{ id: string; text: string; content_hash: string }> = [];
    rawTexts.forEach((text, i) => {
      const id = `chk-legacy-${i}`;
      db.prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)').run(
        id,
        'doc-1',
        i,
        text,
        `hash-${i}`,
      );
      identityRows.push({ id, text, content_hash: `hash-${i}` });
    });
    // A deterministic embeddings row: the identity assertion must compare
    // non-empty snapshots (pr323 review PRR-018: [] vs [] cannot detect a
    // destructive embeddings change).
    seed.db
      .prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)')
      .run('chk-legacy-0', '[0.25,0.5,0.125,0.75,0.375,0.625,0.875,0.0625]');
    seed.close();
    const regress = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    const rdb = regress.db as unknown as SqlDbShape;
    rdb.exec('DELETE FROM chunks_fts');
    for (const row of identityRows) {
      rdb.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(row.id, row.text);
    }
    rdb.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
    // Snap the identity tables pre-migration.
    const preChunks = rdb.prepare('SELECT id, text, content_hash FROM chunks ORDER BY rowid').all();
    const preDocs = rdb.prepare('SELECT * FROM docs ORDER BY id').all();
    const preEmbeddings = rdb.prepare('SELECT chunk_id, embedding FROM embeddings ORDER BY chunk_id').all();
    regress.close();

    // Reopen: the ladder runs 4 -> 5 and rebuilds the mirror.
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      const sdb = store.db as unknown as SqlDbShape;
      expect(store.schemaVersion).toBe(5);
      const version = (
        sdb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
      ).value;
      expect(version).toBe('5');
      // Mirror rows normalized.
      const ftsRows = sdb.prepare('SELECT chunk_id, text FROM chunks_fts ORDER BY rowid').all() as Array<{
        chunk_id: string;
        text: string;
      }>;
      expect(ftsRows.map((r) => r.text)).toEqual(['firstline efficacy', 'hemoglobin flow protocol']);
      // Identity tables byte-identical to the pre-migration snapshot.
      expect(sdb.prepare('SELECT id, text, content_hash FROM chunks ORDER BY rowid').all()).toEqual(preChunks);
      expect(sdb.prepare('SELECT * FROM docs ORDER BY id').all()).toEqual(preDocs);
      expect(sdb.prepare('SELECT chunk_id, embedding FROM embeddings ORDER BY chunk_id').all()).toEqual(preEmbeddings);
      // And the rebuilt mirror answers the plain query.
      const hits = sdb.prepare('SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ?').all('"efficacy"') as Array<{
        chunk_id: string;
      }>;
      expect(hits.map((h) => h.chunk_id)).toContain('chk-legacy-0');
    } finally {
      store.close();
    }
  });

  itReal('a corrupt FTS mirror recovers by drop+recreate — the corpus is never deleted (pr323 review PRR-002)', async () => {
    // Executed probe (fix-reviewer r1): DELETE FROM chunks_fts on an index
    // whose %_data shadow rows are gone raises "database disk image is
    // malformed", while DROP TABLE chunks_fts still succeeds — exactly the
    // shape recoverChunksFts exists for. Deleting the whole try/catch block
    // (or propagating the error to open failure) turns this leg RED.
    const { createRequire } = await import('node:module');
    const requireDesk = createRequire(path.join(REPO_ROOT, 'desktop', 'package.json'));
    const Database = requireDesk('better-sqlite3') as new (
      p: string,
      o?: { readonly?: boolean },
    ) => SqlDbShape & { close(): void };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-recover-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'store.db');

    // Seed a v4 store with raw mirror rows (same recipe as the happy-path leg).
    const seed = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    const db = seed.db as unknown as SqlDbShape;
    db.exec(
      "INSERT INTO docs (id, source_class, path, sha256) VALUES ('doc-1', 'general', 'docs/a.md', 'sha-a')",
    );
    const rawTexts = [
      `first${SOFT}line ef${SOFT}ficacy`,
      `he${ZWSP}moglobin ${LIG}ow protocol`,
    ];
    const identityRows: Array<{ id: string; text: string; content_hash: string }> = [];
    rawTexts.forEach((text, i) => {
      const id = `chk-legacy-${i}`;
      db.prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)').run(
        id,
        'doc-1',
        i,
        text,
        `hash-${i}`,
      );
      identityRows.push({ id, text, content_hash: `hash-${i}` });
    });
    seed.db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(
      'chk-legacy-0',
      '[0.25,0.5,0.125,0.75,0.375,0.625,0.875,0.0625]',
    );
    seed.close();
    const regress = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    const rdb = regress.db as unknown as SqlDbShape;
    rdb.exec('DELETE FROM chunks_fts');
    for (const row of identityRows) {
      rdb.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(row.id, row.text);
    }
    rdb.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
    const preChunks = rdb.prepare('SELECT id, text, content_hash FROM chunks ORDER BY rowid').all();
    const preDocs = rdb.prepare('SELECT * FROM docs ORDER BY id').all();
    const preEmbeddings = rdb.prepare('SELECT chunk_id, embedding FROM embeddings ORDER BY chunk_id').all();
    regress.close();

    // Corrupt the index at the SQLite layer: wipe the FTS5 %_data shadow
    // rows (a real on-disk corruption, not a stub). better-sqlite3's default
    // defensive mode forbids shadow-table writes — unsafeMode(true) is its
    // documented opt-out (the defensive PRAGMA does not lift it). The handle
    // closes even if the statement fails, or the afterEach rmSync hits the
    // Windows file lock (EPERM).
    const raw = new Database(dbPath);
    try {
      raw.unsafeMode(true);
      raw.exec('DELETE FROM chunks_fts_data');
    } finally {
      raw.close();
    }

    // Reopen: 4 -> 5; the rebuild's DELETE throws, recoverChunksFts drops and
    // recreates the mirror, the corpus is untouched.
    const store = openStore({ dbPath, dims: 8, repoRoot: REPO_ROOT });
    try {
      const sdb = store.db as unknown as SqlDbShape;
      expect(store.schemaVersion).toBe(5);
      // Identity tables byte-identical (the corruption must never touch them).
      expect(sdb.prepare('SELECT id, text, content_hash FROM chunks ORDER BY rowid').all()).toEqual(preChunks);
      expect(sdb.prepare('SELECT * FROM docs ORDER BY id').all()).toEqual(preDocs);
      expect(sdb.prepare('SELECT chunk_id, embedding FROM embeddings ORDER BY chunk_id').all()).toEqual(preEmbeddings);
      // The mirror is recreated from chunks.text — normalized, MATCHable.
      const ftsRows = sdb.prepare('SELECT chunk_id, text FROM chunks_fts ORDER BY rowid').all() as Array<{
        chunk_id: string;
        text: string;
      }>;
      expect(ftsRows.map((r) => r.text)).toEqual(['firstline efficacy', 'hemoglobin flow protocol']);
      const hits = sdb.prepare('SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ?').all('"efficacy"') as Array<{
        chunk_id: string;
      }>;
      expect(hits.map((h) => h.chunk_id)).toContain('chk-legacy-0');
    } finally {
      store.close();
    }
  });
});
