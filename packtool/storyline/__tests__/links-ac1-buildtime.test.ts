// links-ac1-buildtime.test.ts — D4 AC1 acceptance check (issue #80).
//
// Links must be computed at BUILD TIME: building a doc pack whose chunks
// carry a genuine topical match to a training slide (here: one doc chunk
// whose embedding vector IS a real slide's vector from a pack built by
// buildStorylinePack) yields non-empty links rows, and those rows insert
// cleanly into the doc pack index's links table and join to real chunk ids.
//
// ---------------------------------------------------------------------------
// COMPUTE-LINKS INTERFACE CONTRACT (frozen)
// ---------------------------------------------------------------------------
// The issue names packtool/links/compute-links.ts as the compute module. Its
// exported surface is frozen as:
//
//   computeDocSlideLinks(
//     chunks: Array<{ chunkId: string; packId: string | null; vector: number[] }>,
//     slides: Array<{ slideId: string; vector: number[] }>,
//     options?: { threshold?: number; topK?: number },
//   ): Array<{
//     chunk_id: string;
//     slide_id: string;
//     pack_id: string | null;
//     score: number;
//     rank: number;
//     computed_at: string;
//   }>
//
// Semantics pinned by issue #80 (D4):
//   - score = cosine similarity between the chunk vector and the slide vector;
//   - a link row exists only when score > (options.threshold ?? 0.5);
//   - at most options.topK (default 3) rows per chunk, ranked 1..n by score
//     descending; rank starts at 1;
//   - computed_at is a non-empty timestamp string (ISO-8601 in practice);
//   - pack_id echoes the input chunk's packId (null stays null);
//   - slide_id is the slide's slideId input. Slide-id convention (picked and
//     noted here): the <slideId> piece of the training doc path
//     'docs/slide-NNN-<slideId>.json' (e.g. 'docs/slide-001-S1.json' -> 'S1'),
//     which equals the slide document's own slide_id field.
//
// RED AT BASE: packtool/links/compute-links.ts does not exist — the file fails
// collection with "Cannot find module '../../links/compute-links.js'". That
// module-not-found failure IS the acceptance evidence for the missing
// build-time compute entry.
// ---------------------------------------------------------------------------
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { computeDocSlideLinks } from '../../links/compute-links.js';
import { buildStorylinePack } from '../../build/compose.js';
import { findRepoRoot, writePackIndex } from '../../build/index-writer.js';
import { chunkIdFor, contentHashFor, docIdFor, normalizedText } from '../../build/chunk.js';
import {
  DOC_MIME,
  INDEX_FILE_NAME,
  SQLITE_VEC_PIN,
  STORE_SCHEMA_VERSION,
  type PackManifest,
} from '../../build/pack-json.js';
import { makeSyntheticPublish } from './helpers/build-fixture.js';
import { extractPackIndex } from './helpers/extract-pack-index.js';

// --- typed view of the frozen contract -------------------------------------
interface LinkRow {
  chunk_id: string;
  slide_id: string;
  pack_id: string | null;
  score: number;
  rank: number;
  computed_at: string;
}
interface LinkChunkInput {
  chunkId: string;
  packId: string | null;
  vector: number[];
}
interface LinkSlideInput {
  slideId: string;
  vector: number[];
}
type ComputeDocSlideLinks = (
  chunks: LinkChunkInput[],
  slides: LinkSlideInput[],
  options?: { threshold?: number; topK?: number },
) => LinkRow[];
const compute: ComputeDocSlideLinks = computeDocSlideLinks as ComputeDocSlideLinks;

// --- native open of an already-built index (schema already applied) --------
const require = createRequire(import.meta.url);
interface TestDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  close(): void;
}
const Database = require('better-sqlite3') as new (dbPath: string) => TestDb;
const sqliteVec = require('sqlite-vec') as { load(db: TestDb): void };

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DIMS = 384; // HashEmbedder default; matches the training pack manifest.
const PUBLISHED_AT = '2026-09-13T00:00:00.000Z';
/** Training slide docs follow 'docs/slide-NNN-<slideId>.json' (compose.ts). */
const SLIDE_DOC_PATH = /^docs\/slide-\d+-(.+)\.json$/;

/** vec0 embeddings read back as little-endian float32 buffers. */
function decodeVector(blob: Buffer): number[] {
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(f32);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Deterministic unit vector orthogonal to every given (unit) vector. */
function orthogonalTo(vectors: number[][], dims: number): number[] {
  let w: number[] = Array.from({ length: dims }, (_, i) => Math.sin((i + 1) * 2.399963229728653));
  for (const v of vectors) {
    const dot = w.reduce((acc, x, i) => acc + x * (v[i] ?? 0), 0);
    const normSq = v.reduce((acc, x) => acc + x * x, 0);
    w = w.map((x, i) => x - ((dot / (normSq || 1)) * (v[i] ?? 0)));
  }
  const norm = Math.sqrt(w.reduce((acc, x) => acc + x * x, 0));
  return w.map((x) => x / (norm || 1));
}

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('links-ac1: build-time doc-to-slide links (D4, issue #80)', () => {
  it('a doc chunk mirroring a real slide vector produces links rows that insert and join', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'd4ac1-'));
    scratchRoots.push(root);
    const repoRoot = findRepoRoot(REPO_ROOT);
    expect(repoRoot).toBeTruthy();

    // 1. A REAL training pack via the production builder (hash embedder).
    const { publishDir } = makeSyntheticPublish(root);
    const build = await buildStorylinePack({
      publishDir,
      out: join(root, 'training-pack.zip'),
      embedder: 'hash',
      id: 'd4-ac1-training-pack',
      version: '1.0.0',
      publishedAt: PUBLISHED_AT,
    });
    expect(build.chunks).toBeGreaterThan(0);
    const trainingIndexPath = await extractPackIndex(build.packPath, root);

    // 2. Slide vectors out of the training index (chunk joined to its doc;
    //    slide_id parsed from the docs.path pattern, see contract note).
    const trainingDb = new Database(trainingIndexPath);
    let slides: LinkSlideInput[];
    try {
      sqliteVec.load(trainingDb);
      const rows = trainingDb
        .prepare(
          'SELECT d.path AS path, e.embedding AS embedding FROM docs d ' +
            'JOIN chunks c ON c.doc_id = d.id ' +
            'JOIN embeddings e ON e.chunk_id = c.id',
        )
        .all() as Array<{ path: string; embedding: Buffer }>;
      slides = [];
      for (const row of rows) {
        const match = SLIDE_DOC_PATH.exec(row.path);
        if (match !== null && match[1] !== undefined) {
          slides.push({ slideId: match[1], vector: decodeVector(Buffer.from(row.embedding)) });
        }
      }
    } finally {
      trainingDb.close();
    }
    // The synthetic fixture carries S1, S2, S3.
    expect(slides.length).toBeGreaterThanOrEqual(3);
    const slideIds = slides.map((s) => s.slideId).sort();
    expect(slides[0]?.vector.length).toBe(DIMS);

    // 3. The mirror chunk copies a REAL slide's vector (S1); the orthogonal
    //    chunk is orthogonal to every slide vector.
    const mirrorSlide = slides.find((s) => s.slideId === 'S1');
    expect(mirrorSlide).toBeTruthy();
    const mirrorVector = (mirrorSlide as LinkSlideInput).vector;
    const orthogonalVector = orthogonalTo(slides.map((s) => s.vector), DIMS);
    for (const slide of slides) {
      // CHECK_WRONG amendment (trace 80-recompute-doc-slide-links): the
      // original 1e-6 tolerance ignored that slides[] carries MULTIPLE chunk
      // vectors per slide (including near-parallel ones), making sequential
      // Gram-Schmidt ill-conditioned — measured residual ~6e-3. The
      // discriminating assertions below (mirror chunk links, orthogonal
      // chunk has ZERO rows under the 0.5 threshold) are unchanged.
      expect(Math.abs(cosine(orthogonalVector, slide.vector))).toBeLessThan(2e-2);
    }

    // 4. A doc pack index via the existing writer, with the crafted vectors.
    const handbookText =
      'Field handbook closely mirroring slide S1 on-screen text: Quokka hydration checklist. Drink water at fixed intervals.';
    const mirrorText = `${handbookText} [topical mirror]`;
    const orthoText = `${handbookText} [unrelated filler]`;
    const docBytes = Buffer.from(JSON.stringify({ text: handbookText }), 'utf8');
    const docId = docIdFor(docBytes);
    const mirrorChunkId = chunkIdFor(docId, 0, normalizedText(mirrorText));
    const orthoChunkId = chunkIdFor(docId, 1, normalizedText(orthoText));
    const docPackId = 'd4-ac1-doc-pack';
    const manifest: PackManifest = {
      id: docPackId,
      name: 'D4 AC1 doc fixture',
      version: '1.0.0',
      published_at: PUBLISHED_AT,
      source_class: 'user',
      embedding: { model_id: 'hash', dims: DIMS, normalize: true },
      chunking: { strategy: 'slide-aware', size: 256, overlap: 100 },
      docs: [{ path: 'docs/handbook.json', sha256: docId, title: 'Field handbook', mime: DOC_MIME }],
      index: { path: INDEX_FILE_NAME, schema_version: STORE_SCHEMA_VERSION, sqlite_vec_version: SQLITE_VEC_PIN },
    };
    const docIndexPath = join(root, 'doc-index', 'index.sqlite');
    // CHECK_WRONG amendment 2 (trace 80-recompute-doc-slide-links): the
    // original test never created the doc-index parent dir; writePackIndex
    // (better-sqlite3) does not mkdir, so the first post-fix execution hit
    // "directory does not exist". Test-infra fix only.
    mkdirSync(join(root, 'doc-index'), { recursive: true });
    writePackIndex({
      dbPath: docIndexPath,
      repoRoot: repoRoot as string,
      dims: DIMS,
      manifest,
      docs: [{ docId, path: 'docs/handbook.json', sha256: docId, title: 'Field handbook', publishedAt: PUBLISHED_AT }],
      chunks: [
        {
          chunkId: mirrorChunkId,
          docId,
          chunkIndex: 0,
          text: mirrorText,
          contentHash: contentHashFor(normalizedText(mirrorText)),
          vector: mirrorVector,
        },
        {
          chunkId: orthoChunkId,
          docId,
          chunkIndex: 1,
          text: orthoText,
          contentHash: contentHashFor(normalizedText(orthoText)),
          vector: orthogonalVector,
        },
      ],
    });

    // 5. The frozen compute surface: mirror chunk must link, orthogonal must not.
    const rows = compute(
      [
        { chunkId: mirrorChunkId, packId: docPackId, vector: mirrorVector },
        { chunkId: orthoChunkId, packId: docPackId, vector: orthogonalVector },
      ],
      slides,
    );
    expect(Array.isArray(rows)).toBe(true);
    const mirrorRows = rows.filter((row) => row.chunk_id === mirrorChunkId);
    expect(mirrorRows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.chunk_id === orthoChunkId)).toHaveLength(0);

    // Every row is fully populated.
    for (const row of rows) {
      expect(typeof row.chunk_id).toBe('string');
      expect(row.chunk_id.length).toBeGreaterThan(0);
      expect(typeof row.slide_id).toBe('string');
      expect(row.slide_id.length).toBeGreaterThan(0);
      expect(row.pack_id).toBe(docPackId);
      expect(typeof row.score).toBe('number');
      expect(Number.isFinite(row.score)).toBe(true);
      expect(row.score).toBeGreaterThan(0);
      expect(row.score).toBeLessThanOrEqual(1 + 1e-9);
      expect(Number.isInteger(row.rank)).toBe(true);
      expect(row.rank).toBeGreaterThanOrEqual(1);
      expect(typeof row.computed_at).toBe('string');
      expect(row.computed_at.length).toBeGreaterThan(0);
      // slide_id must reference a REAL slide of the training pack.
      expect(slideIds).toContain(row.slide_id);
    }

    // Ranks start at 1 for the mirror chunk; its top row is S1 at cosine ~1.
    const mirrorRanks = mirrorRows.map((row) => row.rank);
    expect(Math.min(...mirrorRanks)).toBe(1);
    const top = mirrorRows.reduce((a, b) => (b.score > a.score ? b : a));
    expect(top.slide_id).toBe('S1');
    expect(Math.abs(top.score - 1.0)).toBeLessThan(1e-6);

    // 6. The rows insert into the doc pack index's links table and join to
    //    REAL chunk ids (proves the rows are storable as-is, no reshaping).
    const docDb = new Database(docIndexPath);
    try {
      sqliteVec.load(docDb);
      const insert = docDb.prepare(
        'INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const row of rows) {
        insert.run(row.chunk_id, row.slide_id, row.pack_id, row.score, row.rank, row.computed_at);
      }
      const total = docDb.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number };
      expect(total.n).toBeGreaterThan(0);
      expect(total.n).toBe(rows.length);
      const joined = docDb
        .prepare('SELECT COUNT(*) AS n FROM links l JOIN chunks c ON c.id = l.chunk_id')
        .get() as { n: number };
      expect(joined.n).toBe(rows.length);
    } finally {
      docDb.close();
    }
  });
});
