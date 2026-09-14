// d4-links-ac2-install.test.ts — D4 AC2 acceptance check (issue #80).
//
// Recompute on pack install: with a training pack's slide rows ACTIVE in the
// store, newly arriving document content (the client-side doc-introduction
// surface: IngestPipeline.ingestFile over the REAL store) gets links rows for
// its chunks WITHOUT any manual trigger. The stub embedder returns a vector
// identical to the seeded slide's vector, so the ingested chunk's top link
// must be that slide with score ~1.0 and rank 1.
//
// Seeding uses existing surfaces only: openStore (B5) + plain SQL over the
// authoritative schema (packs/docs/chunks/embeddings/chunks_fts rows shaped
// exactly like packtool's index writer output). The mutation is the REAL
// production ingest path with an injected stub embedder (EmbeddingSurface).
//
// Slide-id convention (issue text): the <slideId> piece of the training doc
// path 'docs/slide-NNN-<slideId>.json' — the seeded slide doc uses
// 'docs/slide-001-S1.json', so the expected links.slide_id is 'S1'.
//
// RED AT BASE: nothing writes the links table, so the load-bearing count
// assertion prints 0 rows after the [D4AC2] marker line. Requires
// desktop/node_modules (better-sqlite3); CI always has it.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-links-ac2-'));
  tempDirs.push(dir);
  return path.join(dir, 'store.db');
}

async function loadStoreModule() {
  return import('../../main/backend/store/sqlite-store.js');
}

/** The store handle's declared db type omits run(); cast to the full surface. */
interface SqlDb {
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
const SLIDE_CHUNK_ID = 'd4ac2-slide-chunk-s1';

/** Stub embedder (EmbeddingSurface): every text maps to the slide vector. */
class FixedVectorEmbedder implements EmbeddingSurface {
  readonly modelId = 'd4-ac2-fixed-fixture';
  readonly dims = 8;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => SLIDE_VEC);
  }
}

function pad64(prefix: string): string {
  return prefix.padEnd(64, '0').slice(0, 64);
}

/** Seed one active training pack with one slide doc ('docs/slide-001-S1.json'),
 * its chunk, embedding and fts mirror — row shapes mirror packtool's writer. */
function seedTrainingSlide(db: SqlDb): void {
  db.prepare(
    'INSERT INTO packs (id, name, version, published_at, source_class, supersedes) VALUES (?, ?, ?, ?, ?, NULL)',
  ).run('d4ac2-training-pack', 'D4 AC2 training pack', '1.0.0', '2026-09-13T00:00:00.000Z', 'training');
  db.prepare(
    'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'd4ac2-slide-doc-s1',
    'training',
    'docs/slide-001-S1.json',
    pad64('d4ac2-slide-s1-sha'),
    'Slide S1',
    '2026-09-13T00:00:00.000Z',
    'd4ac2-training-pack',
  );
  db.prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)').run(
    SLIDE_CHUNK_ID,
    'd4ac2-slide-doc-s1',
    0,
    'Quokka hydration checklist. Drink water at fixed intervals.',
    pad64('d4ac2-slide-s1-chunk'),
  );
  db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)').run(
    SLIDE_CHUNK_ID,
    JSON.stringify(SLIDE_VEC),
  );
  db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)').run(
    SLIDE_CHUNK_ID,
    'Quokka hydration checklist. Drink water at fixed intervals.',
  );
}

describe('d4 AC2 (issue #80): links rows appear for newly ingested doc chunks', () => {
  itReal('ingesting a doc whose chunk mirrors the active slide vector links it to S1', { timeout: 30_000 }, async () => {
    const { openStore } = await loadStoreModule();
    const store = openStore({ dbPath: makeTempDbPath(), dims: 8, repoRoot: REPO_ROOT });
    try {
      const db = (store.db as unknown) as SqlDb;
      seedTrainingSlide(db);
      // Sanity: the training slide is present and active in the store.
      const slide = db.prepare('SELECT id FROM chunks WHERE id = ?').get(SLIDE_CHUNK_ID);
      expect(slide).toBeTruthy();

      // The REAL production ingest path with an injected stub embedder whose
      // vector is bit-identical to the seeded slide vector (cosine exactly 1).
      const pipeline = new IngestPipeline({
        store,
        embedder: new FixedVectorEmbedder(),
        config: { ...DEFAULT_INGEST_CONFIG },
      });
      const docText =
        'Field handbook for the quokka hydration checklist. Drink water at fixed intervals. ' +
        'Secure the splint with two straps during the drill.';
      const result = await pipeline.ingestFile({ name: 'handbook.txt', data: Buffer.from(docText, 'utf8') });
      expect(result.success).toBe(true);
      expect(result.chunks_added).toBeGreaterThan(0);

      const chunkIds = (
        db
          .prepare('SELECT c.id AS id FROM chunks c JOIN docs d ON c.doc_id = d.id WHERE d.path = ?')
          .all('handbook.txt') as Array<{ id: string }>
      ).map((row) => row.id);
      expect(chunkIds.length).toBeGreaterThan(0);

      // The load-bearing assertion: links rows exist for the fresh chunks
      // with NO manual trigger.
      console.log('[D4AC2] asserting links rows exist for freshly ingested doc chunk');
      const placeholders = chunkIds.map(() => '?').join(', ');
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM links WHERE chunk_id IN (${placeholders})`)
        .get(...chunkIds) as { n: number };
      expect(count.n).toBeGreaterThan(0);

      // Detail pins (post-fix schema carries rank; guard the base columns).
      const linksColumns = new Set(
        (db.prepare('PRAGMA table_info(links)').all() as Array<{ name: string }>).map((col) => col.name),
      );
      const selection = linksColumns.has('rank')
        ? 'SELECT chunk_id, slide_id, score, rank FROM links'
        : 'SELECT chunk_id, slide_id, score FROM links';
      const rows = db
        .prepare(`${selection} WHERE chunk_id IN (${placeholders})`)
        .all(...chunkIds) as Array<{ chunk_id: string; slide_id: string; score: number; rank?: number }>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.slide_id).toBe('S1');
      }
      const best = rows.reduce((a, b) => (b.score > a.score ? b : a));
      expect(Math.abs(best.score - 1.0)).toBeLessThan(1e-6);
      if (linksColumns.has('rank')) {
        expect(best.rank).toBe(1);
      }
    } finally {
      store.close();
    }
  });
});
