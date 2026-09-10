// b7-hybrid-retrieval.test.ts — FROZEN ACCEPTANCE SPEC (issue #65 trace, AC1 / check C1).
//
// This file is a frozen acceptance spec authored by the issue-tracer v3 CHECK
// AUTHOR. It pins the hybrid retrieval pipeline the implementer must provide at
// desktop/main/backend/retrieval/hybrid.ts. It must FAIL at the base revision
// (module does not exist) and the implementer makes it pass WITHOUT editing it.
//
// FROZEN PRODUCTION CONTRACT (module desktop/main/backend/retrieval/hybrid.ts):
//
//   export interface RetrievedChunk {
//     chunkId: string;  // chunks.id
//     text: string;     // chunks.text
//     source: string;   // docs.path of the owning document
//     score: number;    // fused RRF*recency score, or the reranker score when one ran
//   }
//   export interface RerankerSurface {
//     score(query: string, candidates: string[]): Promise<number[]>;
//   }
//   export interface HybridRetrievalOptions {
//     store: StoreHandle;              // structural handle from store/sqlite-store.ts
//     embedder: EmbeddingSurface;      // ingest/embedder.ts
//     topK?: number;                   // final slice; default 10
//     candidateMultiplier?: number;    // per-leg/rerank window K = topK*multiplier; default 3
//     rrfK?: number;                   // RRF k; default 60
//     reranker?: RerankerSurface | null;
//     relevanceFloor?: number;         // drops reranked rows with score < floor (== floor kept)
//     recency?: (chunk: RetrievedChunk) => number;  // default recencyWeight (always 1)
//   }
//   export function rrfFuse(vectorLeg: string[], ftsLeg: string[], rrfK: number): Map<string, number>
//   export async function hybridRetrieve(query: string, options: HybridRetrievalOptions): Promise<RetrievedChunk[]>
//   export function recencyWeight(chunk: unknown): number
//   export interface RetrievalSurface {
//     search(query: string, nResults?: number): Promise<Array<{ text: string; source: string; similarity: number }>>;
//   }
//   export function createRetrievalSurface(options: {
//     store: StoreHandle; embedder: EmbeddingSurface; reranker?: RerankerSurface | null;
//     config?: { topK?: number; candidateMultiplier?: number; rerank?: boolean; rrfK?: number; relevanceFloor?: number };
//   }): RetrievalSurface
//
// FROZEN SEMANTICS pinned by the assertions below:
//   - vector leg: options.embedder.embed([query]) (called exactly once, with the
//     query text), then the vec0 KNN form
//       SELECT chunk_id, distance FROM embeddings WHERE embedding MATCH ? AND k = ?
//         ORDER BY distance
//     with the query vector JSON-stringified, truncated to legK.
//   - FTS5 leg: chunks_fts MATCH <raw query> ordered by bm25, truncated to legK.
//   - legK = topK * candidateMultiplier (both default: 10 * 3).
//   - fusion: score(chunk) = sum over legs of 1/(rrfK + rank + 1), rank 0-based
//     per leg, deduped by chunk id; the fused score is MULTIPLIED by
//     recencyWeight(chunk) (inert while the hook returns 1).
//   - rrfK default 60 (asserted end-to-end via exact arithmetic).
//   - results ordered by score descending.
//   - when a reranker is provided: the rerank window is the first legK fused
//     candidates IN FUSED ORDER; reranker.score(query, windowTexts) is awaited
//     once; its scores REPLACE the RRF scores; candidates outside the window are
//     dropped; rows with reranker score < relevanceFloor are dropped (== floor
//     kept); the final topK slice is taken.
//   - when NO reranker is provided: the relevanceFloor is NOT applied (it gates
//     reranker-scale scores only; RRF scores live on a ~0.03 scale and gating
//     them would empty every hash/CI store-backed response); all fused
//     candidates compete for the final topK slice.
//   - an empty store returns [] (and never calls the reranker).
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoreHandle } from '../../main/backend/store/sqlite-store.js';
import type { EmbeddingSurface } from '../../main/backend/ingest/embedder.js';
import { openStore } from '../../main/backend/store/sqlite-store.js';
import { HashEmbedder } from '../../main/backend/ingest/embedder.js';
import {
  createRetrievalSurface,
  hybridRetrieve,
  recencyWeight,
  rrfFuse,
  type RerankerSurface,
  type RetrievedChunk,
} from '../../main/backend/retrieval/hybrid.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIMS = 8;
/** RRF k default frozen by AC1/AC2 (retrieval.rrfK = 60). */
const RRF_K = 60;

/** Repo-root discovery via the established contracts marker (b4/b5/b6 convention). */
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

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface SeedDoc {
  docId: string;
  path: string;
  chunks: Array<{ chunkId: string; text: string }>;
}

/** Hand-seed docs/chunks/embeddings/chunks_fts exactly like the B5 interop writer. */
async function seedStore(store: StoreHandle, docs: SeedDoc[], embedder: EmbeddingSurface): Promise<void> {
  const insertDoc = store.db.prepare(
    'INSERT INTO docs (id, source_class, path, sha256, title, published_at, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertChunk = store.db.prepare(
    'INSERT INTO chunks (id, doc_id, chunk_index, text, content_hash) VALUES (?, ?, ?, ?, ?)',
  );
  const insertFts = store.db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)');
  const insertEmbedding = store.db.prepare('INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)');
  const allTexts = docs.flatMap((doc) => doc.chunks.map((chunk) => chunk.text));
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const doc of docs) {
      insertDoc.run(doc.docId, 'test', doc.path, sha256Hex(doc.chunks.map((c) => c.text).join('\n')), doc.docId, null, null);
      doc.chunks.forEach((chunk, index) => {
        insertChunk.run(chunk.chunkId, doc.docId, index, chunk.text, sha256Hex(chunk.text));
        insertFts.run(chunk.chunkId, chunk.text);
      });
    }
    store.db.exec('COMMIT');
  } catch (err) {
    try {
      store.db.exec('ROLLBACK');
    } catch {
      /* closed by caller */
    }
    throw err;
  }
  // Embeddings outside the transaction (vec0 rows cannot join a BEGIN in some
  // sqlite-vec builds; the interop writer inserts them plainly too).
  const embedded = await embedder.embed(allTexts);
  docs.flatMap((doc) => doc.chunks).forEach((chunk, index) => {
    insertEmbedding.run(chunk.chunkId, JSON.stringify(embedded[index]));
  });
}

interface Fixture {
  store: StoreHandle;
  embedder: HashEmbedder;
  texts: Record<string, string>;
  paths: Record<string, string>;
  dbPath: string;
}

/** Two docs x two chunks. chunk c1 owns the unique FTS token "b7zebra". */
async function makeFixture(prefix: string): Promise<Fixture> {
  const dir = makeTempDir(prefix);
  const docOne = path.join(dir, 'docs', 'b7doc-one.md');
  const docTwo = path.join(dir, 'docs', 'b7doc-two.md');
  fs.mkdirSync(path.dirname(docOne), { recursive: true });
  const texts: Record<string, string> = {
    c1: 'b7zebra marker one',
    c2: 'beta gamma two',
    c3: 'delta epsilon three',
    c4: 'zeta eta four',
  };
  const embedder = new HashEmbedder({ dims: DIMS });
  const dbPath = path.join(dir, 'store.sqlite');
  const store = openStore({ dbPath, dims: DIMS, repoRoot: REPO_ROOT });
  await seedStore(
    store,
    [
      { docId: 'd1', path: docOne, chunks: [{ chunkId: 'c1', text: texts.c1 }, { chunkId: 'c2', text: texts.c2 }] },
      { docId: 'd2', path: docTwo, chunks: [{ chunkId: 'c3', text: texts.c3 }, { chunkId: 'c4', text: texts.c4 }] },
    ],
    embedder,
  );
  return { store, embedder, texts, paths: { c1: docOne, c2: docOne, c3: docTwo, c4: docTwo }, dbPath };
}

/** The vector leg the test derives independently (interop-pinned vec0 KNN form). */
function knnLeg(store: StoreHandle, queryVector: number[], k: number): string[] {
  const rows = store.db
    .prepare('SELECT chunk_id, distance FROM embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance')
    .all(JSON.stringify(queryVector), k) as Array<{ chunk_id: string; distance: number }>;
  return rows.map((row) => row.chunk_id);
}

/** The FTS5 leg the test derives independently (single plain token => unambiguous). */
function ftsLeg(store: StoreHandle, query: string): string[] {
  const rows = store.db
    .prepare('SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts)')
    .all(query) as Array<{ chunk_id: string }>;
  return rows.map((row) => row.chunk_id);
}

/** Reference RRF scores for a two-leg fixture, using the frozen formula. */
function expectedScores(vectorLeg: string[], ftsResult: string[]): Map<string, number> {
  const scores = new Map<string, number>();
  vectorLeg.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  ftsResult.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  return scores;
}

/** Counting embedder wrapper: pins "query embedding via the injected surface". */
function countingEmbedder(inner: HashEmbedder): { embedder: EmbeddingSurface; calls: string[][] } {
  const calls: string[][] = [];
  const embedder: EmbeddingSurface = {
    modelId: inner.modelId,
    embed: async (texts) => {
      calls.push([...texts]);
      return inner.embed(texts);
    },
  };
  return { embedder, calls };
}

describe('b7 C1 (AC1): rrfFuse — exact RRF arithmetic and dedup by chunk id', () => {
  it('fuses two ranked legs with score 1/(rrfK + rank + 1), 0-based ranks, one entry per chunk', () => {
    const fused = rrfFuse(['a', 'b', 'c'], ['b', 'a', 'd'], 60);
    expect(fused.size).toBe(4);
    // Exact doubles: the test computes the SAME expressions the pipeline must.
    expect(fused.get('a')).toBe(1 / (60 + 0 + 1) + 1 / (60 + 1 + 1));
    expect(fused.get('b')).toBe(1 / (60 + 1 + 1) + 1 / (60 + 0 + 1));
    expect(fused.get('c')).toBe(1 / (60 + 2 + 1));
    expect(fused.get('d')).toBe(1 / (60 + 2 + 1));
    // Dedup: a chunk present in BOTH legs contributes from both legs but appears once.
    expect(fused.get('a')).toBeGreaterThan(fused.get('c'));
  });

  it('empty legs fuse to an empty map', () => {
    expect(rrfFuse([], [], 60).size).toBe(0);
  });

  it('rrfK is a real parameter (k=1 changes every score)', () => {
    const fused = rrfFuse(['x'], [], 1);
    expect(fused.get('x')).toBe(1 / (1 + 0 + 1));
  });
});

describe('b7 C1 (AC1): hybridRetrieve — store-backed pipeline over vec0 + chunks_fts', () => {
  itReal(
    'fuses both legs with exact default-rrfK arithmetic, dedups, orders by score, fills text and source',
    async () => {
      const fx = await makeFixture('b7-c1-pipeline-');
      try {
        const { embedder, calls } = countingEmbedder(fx.embedder);
        const query = 'b7zebra';
        // Reference legs (independently derived from the seeded store). The
        // REFERENCE embed uses the raw embedder so the counting wrapper sees
        // ONLY the pipeline's own call (CHECK_WRONG amendment, issue #65 trace:
        // the frozen original counted the reference embed too, making the
        // exactly-once assertion unsatisfiable by any implementation).
        const queryVector = (await fx.embedder.embed([query]))[0];
        const vectorLeg = knnLeg(fx.store, queryVector, 4);
        const ftsResult = ftsLeg(fx.store, query);
        expect(ftsResult).toEqual(['c1']); // only c1 carries the token
        const expected = expectedScores(vectorLeg, ftsResult);

        const rows = await hybridRetrieve(query, { store: fx.store, embedder, topK: 4, candidateMultiplier: 1 });

        // The injected embedder embedded the query exactly once, with the query text.
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual([query]);

        // Same chunk set as the reference fusion, each exactly once (dedup).
        expect(rows.map((row) => row.chunkId).sort()).toEqual([...expected.keys()].sort());

        // Exact fused scores with the DEFAULT rrfK=60 (no rrfK option passed).
        for (const row of rows) {
          expect(row.score).toBe(expected.get(row.chunkId));
        }
        // The both-legs chunk c1 keeps BOTH contributions (rank-0 FTS hit + its vector rank).
        const c1 = rows.find((row) => row.chunkId === 'c1');
        expect(c1).toBeDefined();
        const c1VectorRank = vectorLeg.indexOf('c1');
        expect(c1?.score).toBe(1 / (RRF_K + c1VectorRank + 1) + 1 / (RRF_K + 0 + 1));

        // Descending order, populated text/source straight from the store.
        for (let i = 1; i < rows.length; i += 1) {
          expect(rows[i - 1].score).toBeGreaterThanOrEqual(rows[i].score);
        }
        for (const row of rows) {
          expect(row.text).toBe(fx.texts[row.chunkId]);
          expect(row.source).toBe(fx.paths[row.chunkId]);
        }
      } finally {
        fx.store.close();
      }
    },
  );

  itReal('a query with no FTS hit still returns the vector leg (UNION semantics)', async () => {
    const fx = await makeFixture('b7-c1-union-');
    try {
      const query = 'qqqxyzzy'; // matches no chunk text => empty FTS leg
      expect(ftsLeg(fx.store, query)).toEqual([]);
      const queryVector = (await fx.embedder.embed([query]))[0];
      const vectorLeg = knnLeg(fx.store, queryVector, 4);
      const expected = expectedScores(vectorLeg, []);
      const rows = await hybridRetrieve(query, { store: fx.store, embedder: fx.embedder, topK: 4, candidateMultiplier: 1 });
      expect(rows.map((row) => row.chunkId).sort()).toEqual([...expected.keys()].sort());
      for (const row of rows) expect(row.score).toBe(expected.get(row.chunkId));
    } finally {
      fx.store.close();
    }
  });

  itReal('an empty store returns [] and never calls the reranker', async () => {
    const dir = makeTempDir('b7-c1-empty-');
    const store = openStore({ dbPath: path.join(dir, 'store.sqlite'), dims: DIMS, repoRoot: REPO_ROOT });
    let rerankerCalls = 0;
    const reranker: RerankerSurface = {
      score: async () => {
        rerankerCalls += 1;
        return [];
      },
    };
    try {
      const rows = await hybridRetrieve('anything', { store, embedder: new HashEmbedder({ dims: DIMS }), reranker });
      expect(rows).toEqual([]);
      expect(rerankerCalls).toBe(0);
    } finally {
      store.close();
    }
  });

  itReal('the recency hook is consulted once per fused chunk and multiplies the fused score', async () => {
    const fx = await makeFixture('b7-c1-recency-');
    try {
      const queryVector = (await fx.embedder.embed(['b7zebra']))[0];
      const expected = expectedScores(knnLeg(fx.store, queryVector, 4), ftsLeg(fx.store, 'b7zebra'));
      const seen: RetrievedChunk[] = [];
      const rows = await hybridRetrieve('b7zebra', {
        store: fx.store,
        embedder: fx.embedder,
        topK: 4,
        candidateMultiplier: 1,
        recency: (chunk) => {
          seen.push(chunk);
          return 0.5;
        },
      });
      expect(seen).toHaveLength(4); // once per fused chunk, with populated rows
      for (const chunk of seen) {
        expect(typeof chunk.chunkId).toBe('string');
        expect(chunk.text).toBe(fx.texts[chunk.chunkId]);
      }
      // 0.5 is a power of two: the halved fused score is EXACT.
      for (const row of rows) expect(row.score).toBe((expected.get(row.chunkId) ?? 0) * 0.5);
      for (let i = 1; i < rows.length; i += 1) expect(rows[i - 1].score).toBeGreaterThanOrEqual(rows[i].score);
    } finally {
      fx.store.close();
    }
  });

  itReal(
    'the reranker receives the fused candidate window in fused order; its scores replace RRF scores; the floor drops below-floor rows; the topK slice applies',
    async () => {
      const fx = await makeFixture('b7-c1-rerank-');
      try {
        const query = 'b7zebra';
        const queryVector = (await fx.embedder.embed([query]))[0];
        const expected = expectedScores(knnLeg(fx.store, queryVector, 4), ftsLeg(fx.store, query));
        const fusedOrder = [...expected.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

        const calls: Array<{ query: string; candidates: string[] }> = [];
        const scoreTable = [0.9, 0.05, 0.8, 0.02];
        const reranker: RerankerSurface = {
          score: async (q, candidates) => {
            calls.push({ query: q, candidates: [...candidates] });
            return candidates.map((_, i) => scoreTable[i]);
          },
        };

        // topK=2, candidateMultiplier=2 => legK=4 => the rerank window is ALL 4 fused chunks.
        const rows = await hybridRetrieve(query, {
          store: fx.store,
          embedder: fx.embedder,
          topK: 2,
          candidateMultiplier: 2,
          reranker,
          relevanceFloor: 0.5,
        });

        // The reranker got the fused candidate set once, in fused order, with the raw texts.
        expect(calls).toHaveLength(1);
        expect(calls[0].query).toBe(query);
        expect(calls[0].candidates).toEqual(fusedOrder.map((id) => fx.texts[id]));

        // Floor 0.5 drops the 0.05 and 0.02 rows; survivors ordered by RERANKER score; sliced to topK=2.
        expect(rows).toHaveLength(2);
        expect(rows[0].chunkId).toBe(fusedOrder[0]);
        expect(rows[0].score).toBe(0.9);
        expect(rows[1].chunkId).toBe(fusedOrder[2]);
        expect(rows[1].score).toBe(0.8);

        // Boundary: a reranker score EXACTLY equal to the floor is kept.
        const boundary = await hybridRetrieve(query, {
          store: fx.store,
          embedder: fx.embedder,
          topK: 2,
          candidateMultiplier: 2,
          reranker: { score: async () => [0.9, 0.05, 0.8, 0.02] },
          relevanceFloor: 0.9,
        });
        expect(boundary).toHaveLength(1);
        expect(boundary[0].chunkId).toBe(fusedOrder[0]);
        expect(boundary[0].score).toBe(0.9);
      } finally {
        fx.store.close();
      }
    },
  );

  itReal('candidates beyond the legK fused window are dropped when a reranker runs', async () => {
    const fx = await makeFixture('b7-c1-window-');
    try {
      const query = 'b7zebra';
      const queryVector = (await fx.embedder.embed([query]))[0];
      const expected = expectedScores(knnLeg(fx.store, queryVector, 4), ftsLeg(fx.store, query));
      const fusedOrder = [...expected.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      const seen: string[] = [];
      const rows = await hybridRetrieve(query, {
        store: fx.store,
        embedder: fx.embedder,
        topK: 2,
        candidateMultiplier: 1, // legK=2: only the top-2 fused chunks reach the reranker
        reranker: {
          score: async (_q, candidates) => {
            seen.push(...candidates);
            return candidates.map((_, i) => (i === 0 ? 0.3 : 0.4));
          },
        },
      });
      expect(seen).toEqual([fx.texts[fusedOrder[0]], fx.texts[fusedOrder[1]]]);
      // Only window chunks can appear, ordered by reranker score (0.4 before 0.3).
      expect(rows).toHaveLength(2);
      expect(rows[0].chunkId).toBe(fusedOrder[1]);
      expect(rows[0].score).toBe(0.4);
      expect(rows[1].chunkId).toBe(fusedOrder[0]);
      expect(rows[1].score).toBe(0.3);
    } finally {
      fx.store.close();
    }
  });

  itReal('without a reranker the relevance floor is NOT applied to RRF-scale scores', async () => {
    const fx = await makeFixture('b7-c1-nofloor-');
    try {
      // A floor of 1.0 on RRF scores (~0.016-0.033) would drop EVERYTHING; the
      // floor gates reranker scores only (frozen semantics; see file header).
      const rows = await hybridRetrieve('b7zebra', {
        store: fx.store,
        embedder: fx.embedder,
        topK: 4,
        candidateMultiplier: 1,
        relevanceFloor: 1.0,
      });
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row.score).toBeLessThan(1.0);
    } finally {
      fx.store.close();
    }
  });
});

describe('b7 C1 (AC1): createRetrievalSurface — wire shape adapter', () => {
  itReal('maps RetrievedChunk rows onto the frozen /search row shape with similarity = score', async () => {
    const fx = await makeFixture('b7-c1-surface-');
    try {
      const surface = createRetrievalSurface({ store: fx.store, embedder: fx.embedder });
      const rows = await surface.search('b7zebra', 5);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.length).toBeLessThanOrEqual(5);
      const queryVector = (await fx.embedder.embed(['b7zebra']))[0];
      const expected = expectedScores(knnLeg(fx.store, queryVector, 4), ftsLeg(fx.store, 'b7zebra'));
      // Every returned row identifies a seeded chunk: text, source and
      // similarity are store-backed, and similarity mirrors the fused score.
      const textToChunk = new Map(Object.entries(fx.texts).map(([id, text]) => [text, id]));
      const sources = new Set(Object.values(fx.paths));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(textToChunk.has(row.text)).toBe(true);
        expect(sources.has(row.source)).toBe(true);
        expect(row.similarity).toBe(expected.get(textToChunk.get(row.text) as string));
      }
    } finally {
      fx.store.close();
    }
  });

  itReal('the default recency hook is the exported recencyWeight (inert)', async () => {
    const fx = await makeFixture('b7-c1-defrecency-');
    try {
      const rows = await hybridRetrieve('b7zebra', { store: fx.store, embedder: fx.embedder, topK: 4, candidateMultiplier: 1 });
      expect(recencyWeight({})).toBe(1);
      for (const row of rows) expect(row.score).toBeGreaterThan(0);
    } finally {
      fx.store.close();
    }
  });
});
