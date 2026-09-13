// d4-links-ac3-supersede.test.ts — D4 AC3 acceptance check (issue #80).
//
// Recompute on supersede: when a document's content is superseded at the same
// path (the production DELETE-BEFORE-REINGEST path of IngestPipeline), the
// old revision's links rows must NOT survive as orphans — every links.chunk_id
// must still reference a live chunk — and the new revision's chunk must carry
// its own links row.
//
// Pre-state (legitimate at base): a training slide row is active, a doc
// 'manual.txt' revision 1 with chunk 'ch-old' exists, and a links row for
// (ch-old, slide) was computed earlier and inserted via SQL. Revision 2 then
// arrives through the REAL pipeline (stub embedder returning the slide's
// vector), which deletes ch-old and inserts a new chunk.
//
// RED AT BASE: the pipeline removes ch-old's chunk/embeddings/fts rows but
// nothing removes its links row, so the orphan-count assertion prints 1 after
// the [D4AC3] marker line. Requires desktop/node_modules (better-sqlite3).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_INGEST_CONFIG } from '../../main/backend/ingest/config.js';
import type { EmbeddingSurface } from '../../main/backend/ingest/embedder.js';
import { IngestPipeline } from '../../main/backend/ingest/pipeline.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root discovery via the established contracts marker (b4/b5 convention). */
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
const NATIVE_DEPS_PRESENT = fs.existsSync(path.join(REPO_ROOT, 'desktop', 'node_modules', 'better-sqlite3'));
const itReal = NATIVE_DEPS_PRESENT ? it : it.skip;

/** Temp dirs created by the current test; removed in afterEach. */
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-links-ac3-'));
  tempDirs.push(dir);
  return path.join(dir, 'store.db');
}

async function loadStoreModule() {
  return import('../../main/backend/store/sqlite-store.js');
}

/** The store handle's declared db type omits run()/exec(); cast to the full surface. */
interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Unit 8-dim vector whose components are exactly float32-representable, so
 * the seeded vec0 row and the stub embedder's vector agree bit-for-bit. */
function slideVector(): number[] {
  const base = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125];
  const norm = Math.sqrt(base.reduce((acc, v) => acc + v * v, 0));
  const f32 = new Float32Array(base.map((v) => v / norm));
  return Array.from(f32);
}

const SLIDE_VEC = slideVector();
const SLIDE_CHUNK_ID = 'd4ac3-slide-chunk-s1';
const OLD_DOC_ID = 'd4ac3-manual-doc-v1';
const OLD_CHUNK_ID = 'd4ac3-manual-chunk-old';

/** Stub embedder (EmbeddingSurface): every text maps to the slide vector. */
class FixedVectorEmbedder implements EmbeddingSurface {
  readonly modelId = 'd4-ac3-fixed-fixture';
  readonly dims = 8;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => SLIDE_VEC);
  }
}

function pad64(prefix: string): string {
  return prefix.padEnd(64, '0').slice(0, 64);
}

/** Seed the active training slide plus the doc 'manual.txt' revision 1 with
 * chunk ch-old and its (previously computed) links row. The links insert is
 * column-adaptive so the pre-state is legitimate under both the base 3-column
 * links DDL and the post-fix 6-column DDL. */
function seedPreState(db: SqlDb): void {
  db.prepare(
    'INSERT INTO packs (id, name, version, published_at, source_class, supersedes) VALUES (?, ?, ?, ?, ?, NULL)',
  ).run('d4ac3-training-pack', 'D4 AC3 training pack', '1.0.0', '2026-09-13T00:00:00.000Z', 'training');
  db.prepare(
    'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'd4ac3-slide-doc-s1',
    'training',
    'docs/slide-001-S1.json',
    pad64('d4ac3-slide-s1-sha'),
    'Slide S1',
    '2026-09-13T00:00:00.000Z',
    'd4ac3-training-pack',
  );
  db.prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)').run(
    SLIDE_CHUNK_ID,
    'd4ac3-slide-doc-s1',
    0,
    'Quokka hydration checklist. Drink water at fixed intervals.',
    pad64('d4ac3-slide-s1-chunk'),
  );
  db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(
    SLIDE_CHUNK_ID,
    JSON.stringify(SLIDE_VEC),
  );
  db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(
    SLIDE_CHUNK_ID,
    'Quokka hydration checklist. Drink water at fixed intervals.',
  );

  // manual.pdf-style user doc, revision 1, superseded later at the same path.
  db.prepare(
    'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  ).run(OLD_DOC_ID, 'general', 'manual.txt', pad64('d4ac3-manual-v1-sha'), 'Field manual', '2026-09-13T00:00:00.000Z');
  db.prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)').run(
    OLD_CHUNK_ID,
    OLD_DOC_ID,
    0,
    'Manual revision one. Quokka hydration checklist summary.',
    pad64('d4ac3-manual-v1-chunk'),
  );
  db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(
    OLD_CHUNK_ID,
    JSON.stringify(SLIDE_VEC),
  );
  db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(
    OLD_CHUNK_ID,
    'Manual revision one. Quokka hydration checklist summary.',
  );

  const linksColumns = new Set(
    (db.prepare('PRAGMA table_info(links)').all() as Array<{ name: string }>).map((col) => col.name),
  );
  if (linksColumns.has('rank')) {
    db.prepare(
      'INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES (?, ?, NULL, ?, 1, ?)',
    ).run(OLD_CHUNK_ID, 'S1', 0.87, '2026-09-13T00:00:00.000Z');
  } else {
    db.prepare('INSERT INTO links (chunk_id, slide_id, score) VALUES (?, ?, ?)').run(OLD_CHUNK_ID, 'S1', 0.87);
  }
}

describe('d4 AC3 (issue #80): superseding content removes its stale links rows', () => {
  itReal('re-ingesting manual.txt at the same path leaves zero orphaned links rows', { timeout: 30_000 }, async () => {
    const { openStore } = await loadStoreModule();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 8, repoRoot: REPO_ROOT });
    try {
      const db = (store.db as unknown) as SqlDb;
      seedPreState(db);
      const seededLink = db
        .prepare('SELECT COUNT(*) AS n FROM links WHERE chunk_id = ?')
        .get(OLD_CHUNK_ID) as { n: number };
      expect(seededLink.n).toBe(1);

      // better-sqlite3 enforces PRAGMA foreign_keys = ON by default, and the
      // base schema declares links.chunk_id REFERENCES chunks(id) with no ON
      // DELETE action — so at base (where NO writer cleans links rows) the
      // stale row would make the supersede DELETE abort with a constraint
      // error instead of leaving the orphan behind. The behavior under test
      // is the EXPLICIT stale-links cleanup on supersede (mirroring how the
      // pipeline already deletes embeddings/chunks_fts rows by hand because
      // FKs cannot be enforced on virtual tables), which must not depend on
      // the connection's FK pragma — so this scenario runs with FK
      // enforcement off.
      db.exec('PRAGMA foreign_keys = OFF');

      // The REAL production mutation: NEW content at the SAME path. The
      // pipeline's DELETE-BEFORE-REINGEST removes revision 1's doc, chunks,
      // embeddings and fts rows inside the same transaction that inserts
      // revision 2 (topical vector again via the stub embedder).
      const pipeline = new IngestPipeline({
        store,
        embedder: new FixedVectorEmbedder(),
        config: { ...DEFAULT_INGEST_CONFIG },
      });
      const rev2 = 'Manual revision two. Quokka hydration checklist expanded with fixed water intervals and splint strap guidance.';
      const result = await pipeline.ingestFile({ name: 'manual.txt', data: Buffer.from(rev2, 'utf8') });
      expect(result.success, `re-ingest failed: ${result.message ?? 'unknown'}`).toBe(true);
      expect(result.chunks_added).toBeGreaterThan(0);

      // Production mutation confirmed: ch-old is gone.
      const oldChunk = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE id = ?').get(OLD_CHUNK_ID) as { n: number };
      expect(oldChunk.n).toBe(0);
      const newChunks = (
        db
          .prepare('SELECT c.id AS id FROM chunks c JOIN docs d ON c.doc_id = d.id WHERE d.path = ?')
          .all('manual.txt') as Array<{ id: string }>
      ).map((row) => row.id);
      expect(newChunks.length).toBeGreaterThan(0);

      // Load-bearing assertion (a): zero orphaned links rows.
      console.log('[D4AC3] asserting no orphaned links rows after content supersede');
      const orphans = db
        .prepare('SELECT COUNT(*) AS n FROM links WHERE chunk_id NOT IN (SELECT id FROM chunks)')
        .get() as { n: number };
      expect(orphans.n).toBe(0);

      // Load-bearing assertion (b): the replacement chunk has its links row.
      const placeholders = newChunks.map(() => '?').join(', ');
      const linked = db
        .prepare(`SELECT COUNT(*) AS n FROM links WHERE chunk_id IN (${placeholders})`)
        .get(...newChunks) as { n: number };
      expect(linked.n).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
