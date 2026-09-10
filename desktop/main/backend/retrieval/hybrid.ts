// retrieval/hybrid.ts — the B7 hybrid retrieval pipeline (issue #65).
//
// Pipeline: query embedding (injected EmbeddingSurface) -> vec0 KNN top-legK
// UNION chunks_fts FTS5 top-legK -> Reciprocal Rank Fusion (score +=
// 1/(rrfK + rank + 1), dedup by chunk id — same formula as the browser fusion
// web_ui/src/lib/search/rrf-fusion.ts and the Python reference utils.py
// rrf_fuse) -> recencyWeight(chunk) multiplier -> optional worker cross-encoder
// rerank over the fused window (reranker scores REPLACE the fused scores;
// window-out candidates are dropped; the calibrated relevanceFloor applies to
// reranker scores ONLY) -> topK slice.
//
// recencyWeight is the documented C4 extension point (issue #71): it returns
// exactly 1 for every input while Knowledge Pack recency/version precedence is
// unbuilt; C4 replaces the implementation without touching this pipeline.
//
// better-sqlite3 is synchronous, so the store legs run on the calling thread;
// the reranker (ONNX inference) runs in a dedicated worker thread
// (retrieval/reranker.ts + rerank-worker.ts) — never on the main/event-loop
// thread (the web_ui defect this design must not reproduce,
// web_ui/src/lib/search/reranker.ts:187-233).
import type { StoreHandle } from '../store/sqlite-store.js';
import type { EmbeddingSurface } from '../ingest/embedder.js';

/** One retrieved chunk with its final score (fused RRF*recency, or reranker). */
export interface RetrievedChunk {
  chunkId: string;
  text: string;
  source: string;
  score: number;
}

/** Cross-encoder scoring surface (implemented by the worker-backed reranker). */
export interface RerankerSurface {
  score(query: string, candidates: string[]): Promise<number[]>;
}

export interface HybridRetrievalOptions {
  store: StoreHandle;
  embedder: EmbeddingSurface;
  /** Final slice; default 10 (the browser balanced preset). */
  topK?: number;
  /** Per-leg fetch and rerank window K = topK * candidateMultiplier; default 3. */
  candidateMultiplier?: number;
  /** RRF constant; default 60. */
  rrfK?: number;
  reranker?: RerankerSurface | null;
  /** Floor on RERANKER scores only; rows with score < floor are dropped (== floor kept). */
  relevanceFloor?: number;
  /** Recency multiplier per fused chunk; default recencyWeight (inert until C4/#71). */
  recency?: (chunk: RetrievedChunk) => number;
}

export interface RetrievalSurface {
  search(
    query: string,
    nResults?: number,
  ): Promise<Array<{ text: string; source: string; similarity: number }>>;
}

/** Reciprocal Rank Fusion over ranked chunk-id legs; dedup by chunk id. */
export function rrfFuse(vectorLeg: string[], ftsLeg: string[], rrfK: number): Map<string, number> {
  const fused = new Map<string, number>();
  for (const [rank, chunkId] of vectorLeg.entries()) {
    fused.set(chunkId, (fused.get(chunkId) ?? 0) + 1 / (rrfK + rank + 1));
  }
  for (const [rank, chunkId] of ftsLeg.entries()) {
    fused.set(chunkId, (fused.get(chunkId) ?? 0) + 1 / (rrfK + rank + 1));
  }
  return fused;
}

/**
 * C4 (issue #71) extension point: recency/version weighting of fused chunks.
 * Inert by contract until Knowledge Pack precedence lands — exactly 1 for
 * every input, asserted by C6.
 */
export function recencyWeight(_chunk: unknown): number {
  return 1;
}

/**
 * FTS5 MATCH does not accept raw user syntax safely (quotes, `*`, `AND`/`OR`/
 * `NOT`/`NEAR`, `^`, `:` are all operators). Wrap each remaining term in double
 * quotes (a quoted single term is observably identical to the bare term) and
 * drop operator/bare-quote/star tokens outright. A query reduced to nothing
 * yields an empty FTS leg instead of a thrown syntax error.
 */
export function sanitizeFtsQuery(query: string): string | null {
  const operators = new Set(['and', 'or', 'not', 'near']);
  const terms: string[] = [];
  for (const raw of query.split(/\s+/)) {
    if (raw.length === 0) continue;
    const lowered = raw.toLowerCase();
    if (operators.has(lowered)) continue;
    if (/["*():^&]/.test(raw)) continue;
    terms.push(`"${raw}"`);
  }
  if (terms.length === 0) return null;
  return terms.join(' ');
}

interface ChunkRow {
  id: string;
  text: string;
  path: string;
}

function loadChunkRows(store: StoreHandle, chunkIds: string[]): Map<string, ChunkRow> {
  const rows = new Map<string, ChunkRow>();
  if (chunkIds.length === 0) return rows;
  const placeholders = chunkIds.map(() => '?').join(', ');
  const found = store.db
    .prepare(
      `SELECT c.id AS id, c.text AS text, d.path AS path
       FROM chunks c JOIN docs d ON c.doc_id = d.id
       WHERE c.id IN (${placeholders})`,
    )
    .all(...chunkIds) as Array<{ id: string; text: string; path: string }>;
  for (const row of found) {
    rows.set(row.id, row);
  }
  return rows;
}

/**
 * The hybrid pipeline. Empty store -> [] (the reranker is never called). The
 * relevanceFloor gates reranker-scale sigmoid scores only; when no reranker
 * runs, RRF-scale fused scores compete for the topK slice untouched.
 */
export async function hybridRetrieve(
  query: string,
  options: HybridRetrievalOptions,
): Promise<RetrievedChunk[]> {
  const topK = options.topK ?? 10;
  const candidateMultiplier = options.candidateMultiplier ?? 3;
  const rrfK = options.rrfK ?? 60;
  const legK = topK * candidateMultiplier;
  const recency = options.recency ?? recencyWeight;
  // Defense-in-depth cap (PRR-010, PR #102 review): the HTTP layer bounds
  // /search and /ask queries, but EngineSurface callers bypass it — keep any
  // single query from amplifying into a multi-megabyte embed/FTS5 expression.
  const boundedQuery = query.length > 8000 ? query.slice(0, 8000) : query;

  // Vector leg: embed the query exactly once, then the interop-pinned vec0
  // KNN form (contracts/tests/store-interop are the canonical query shape).
  const [queryVector] = await options.embedder.embed([boundedQuery]);
  const vectorRows = options.store.db
    .prepare(
      'SELECT chunk_id, distance FROM embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance',
    )
    .all(JSON.stringify(queryVector), legK) as Array<{ chunk_id: string; distance: number }>;
  const vectorLeg = vectorRows.map((row) => row.chunk_id).slice(0, legK);

  // FTS5 leg: sanitized user query, best match first (rank is negated bm25).
  const ftsMatch = sanitizeFtsQuery(boundedQuery);
  const ftsLeg = (
    ftsMatch === null
      ? []
      : (options.store.db
          .prepare('SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?')
          .all(ftsMatch, legK) as Array<{ chunk_id: string }>)
  ).map((row) => row.chunk_id);

  const fused = rrfFuse(vectorLeg, ftsLeg, rrfK);
  if (fused.size === 0) return [];
  const rows = loadChunkRows(options.store, [...fused.keys()]);

  // Fused score * recency, ordered descending.
  let ordered: RetrievedChunk[] = [...fused.entries()]
    .map(([chunkId, score]) => {
      const row = rows.get(chunkId);
      const chunk: RetrievedChunk = {
        chunkId,
        text: row?.text ?? '',
        source: row?.path ?? '',
        score,
      };
      return { ...chunk, score: score * recency(chunk) };
    })
    .sort((a, b) => b.score - a.score);

  if (options.reranker) {
    // The reranker re-scores the fused window (first legK candidates, in fused
    // order) with calibrated relevance; window-out candidates are dropped.
    const window = ordered.slice(0, legK);
    const scores = await options.reranker.score(
      boundedQuery,
      window.map((chunk) => chunk.text),
    );
    const floor = options.relevanceFloor;
    ordered = window
      .map((chunk, index) => {
        const raw = scores[index];
        const score = typeof raw === 'number' ? raw : Number(raw);
        // NaN poisoning path: the q8 model could emit NaN, typeof 'number'
        // passes it, and a NaN sort comparator breaks ordering (V8 treats it
        // as 0). Map any non-finite score to the lowest useful score instead
        // (PRR-005, PR #102 review).
        return { ...chunk, score: Number.isFinite(score) ? score : 0 };
      })
      .filter((chunk) => (floor === undefined ? true : chunk.score >= floor))
      .sort((a, b) => b.score - a.score);
  }

  return ordered.slice(0, topK);
}

/**
 * Adapter from the pipeline to the frozen /search wire shape
 * (contracts/api.openapi.yaml SearchResult: {text, source, similarity}).
 * similarity carries the final score verbatim (fused RRF*recency when no
 * reranker ran, the cross-encoder sigmoid otherwise).
 */
export function createRetrievalSurface(options: {
  store: StoreHandle;
  embedder: EmbeddingSurface;
  reranker?: RerankerSurface | null;
  config?: {
    topK?: number;
    candidateMultiplier?: number;
    rerank?: boolean;
    rrfK?: number;
    relevanceFloor?: number;
  };
}): RetrievalSurface {
  const config = options.config ?? {};
  const effectiveReranker =
    config.rerank === false ? null : (options.reranker ?? null);
  let rerankerWarned = false;
  // Latched for the surface's lifetime: after the first reranker failure every
  // later query stays on fused ordering. A per-call retry would re-walk the
  // broken worker on each query while only the log line latched (PRR-004,
  // PR #102 review).
  let reranker = effectiveReranker;
  return {
    async search(query, nResults) {
      const topK = config.topK ?? 10;
      if (reranker !== null) {
        // Production isolation: a broken reranker worker must never 500
        // /search — that query degrades to fused, floor-free ordering (the
        // same semantics as rerank disabled) after a single warning, and the
        // latch keeps later queries on the degraded path.
        try {
          return await runSearch(query, nResults, topK, reranker, config, options);
        } catch (err) {
          if (!rerankerWarned) {
            rerankerWarned = true;
            console.error(
              `[trainingapp-backend] reranker failed once (degrading to fused ordering): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          reranker = null;
        }
      }
      return runSearch(query, nResults, topK, reranker, config, options);
    },
  };
}

async function runSearch(
  query: string,
  nResults: number | undefined,
  topK: number,
  reranker: RerankerSurface | null,
  config: { candidateMultiplier?: number; rerank?: boolean; rrfK?: number; relevanceFloor?: number },
  options: { store: StoreHandle; embedder: EmbeddingSurface },
): Promise<Array<{ text: string; source: string; similarity: number }>> {
  const chunks = await hybridRetrieve(query, {
    store: options.store,
    embedder: options.embedder,
    topK,
    candidateMultiplier: config.candidateMultiplier,
    rrfK: config.rrfK,
    reranker,
    // The floor is meaningful only when a reranker will run (hybridRetrieve
    // enforces the same rule internally; passing it unconditionally is safe).
    relevanceFloor: config.relevanceFloor,
  });
  return chunks.slice(0, nResults ?? topK).map((chunk) => ({
    text: chunk.text,
    source: chunk.source,
    similarity: chunk.score,
  }));
}
