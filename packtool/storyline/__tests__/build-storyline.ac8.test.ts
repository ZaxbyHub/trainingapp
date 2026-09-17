// AC8 — the prebuilt index conforms to the frozen store schema AND retrieves
// (issue #79): meta stamps match the manifest, row counts are equal, a vec0
// MATCH with a stored vector self-hits its chunk, and an FTS5 MATCH on a
// distinctive word returns the expected chunk. Frozen driver:
// repro/c7-index-sqlite.sh filters this file via `vitest run build-storyline.ac8`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStorylinePack } from '../../build/compose';
import { readPackJson, extractPackIndex } from './helpers/extract-pack-index';
import { makeSyntheticPublish } from './helpers/build-fixture';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (p: string, options?: { readonly?: boolean }) => {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
};
const sqliteVec = require('sqlite-vec') as { load(db: unknown): void };

interface PackShape {
  id: string;
  embedding: { model_id: string; dims: number; normalize: boolean };
  docs: Array<{ path: string; sha256: string }>;
}

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('build-storyline.ac8: prebuilt index conforms and retrieves', () => {
  it('meta stamps match, rows align, and vec0/FTS5 queries hit', { timeout: 20_000 }, async () => {
    // 20s: lazily loads the better-sqlite3/sqlite-vec natives.
    const root = mkdtempSync(join(tmpdir(), 'ac8-'));
    scratchRoots.push(root);
    const { publishDir } = makeSyntheticPublish(root);
    const result = await buildStorylinePack({
      publishDir,
      out: join(root, 'pack.zip'),
      embedder: 'hash',
      id: 'fixture-pack',
      version: '1.0.0',
    });

    const manifest = await readPackJson<PackShape>(result.packPath);
    const indexPath = await extractPackIndex(result.packPath, root);
    // Open + extension load INSIDE the guarded region so a failure can never
    // leak the native handle (an open handle makes afterEach rmSync fail with
    // EPERM on Windows).
    let db: ReturnType<typeof Database> | null = null;
    try {
      db = new Database(indexPath, { readonly: true });
      sqliteVec.load(db);
      // Meta stamps.
      const meta = (key: string): string =>
        (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string }).value;
      expect(meta('schema_version')).toBe('3');
      expect(meta('embedding_dims')).toBe(String(manifest.embedding.dims));
      expect(Number.parseInt(meta('embedding_dims'), 10)).toBe(384);
      expect(meta('embedding_model_id')).toBe(manifest.embedding.model_id);

      // Row-count parity across chunks / embeddings / fts.
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const chunks = count('chunks');
      expect(chunks).toBeGreaterThan(0);
      expect(chunks).toBe(count('embeddings'));
      expect(chunks).toBe(count('chunks_fts'));

      // Index docs table mirrors the manifest docs[] hash set.
      const indexHashes = (db.prepare('SELECT sha256 FROM docs ORDER BY sha256').all() as Array<{ sha256: string }>)
        .map((row) => row.sha256)
        .sort();
      const manifestHashes = manifest.docs.map((doc) => doc.sha256).sort();
      expect(indexHashes).toEqual(manifestHashes);

      // vec0 self-hit: a stored vector queried back must find its own chunk
      // with a NEGLIGIBLE distance (PR review TC-2 — a broken vec0 returning
      // arbitrary rows that merely include the input row must not pass).
      const stored = db
        .prepare('SELECT chunk_id, embedding FROM embeddings LIMIT 1')
        .get() as { chunk_id: string; embedding: string };
      const nearest = db
        .prepare('SELECT chunk_id, distance FROM embeddings WHERE embedding MATCH ? AND k = 3 ORDER BY distance')
        .all(stored.embedding) as Array<{ chunk_id: string; distance: number }>;
      expect(nearest.length).toBeGreaterThan(0);
      expect(nearest[0]?.chunk_id).toBe(stored.chunk_id);
      expect(nearest[0]?.distance).toBeLessThan(1e-6);

      // FTS5 hit on a distinctive word returns the chunk containing it.
      const fts = db
        .prepare('SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts)')
        .all('"Quokka"') as Array<{ chunk_id: string }>;
      expect(fts.length).toBeGreaterThan(0);
      const quokkaChunk = db
        .prepare('SELECT id FROM chunks WHERE text LIKE ?')
        .get('%Quokka%') as { id: string };
      expect(fts.map((row) => row.chunk_id)).toContain(quokkaChunk.id);
    } finally {
      try {
        db?.close();
      } catch {
        // never mask the test result with a close failure
      }
    }
  });
});
