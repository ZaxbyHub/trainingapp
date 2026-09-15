// store/links.ts — runtime doc-chunk -> training-slide link maintenance
// (D4/#80).
//
// The IngestPipeline calls recomputeLinksForDocs inside its writeDocument
// transaction, so links can never outlive (or lag) the chunks they reference;
// a future pack lifecycle (#70) composes the same operations through
// recomputeLinksForDocs / removeLinksForPack / pruneOrphanLinks — this module
// is the single runtime call surface for link maintenance.
//
// The cosine/topK kernel and slide-path parser MIRROR
// packtool/links/compute-links.ts (the desktop cannot import the packtool
// package; repo precedent: chunk-id hashing parity between
// packtool/build/chunk.ts and ingest/pipeline.ts). Parity is pinned by
// identical golden test vectors in desktop/src/__tests__/d4-links-store.test.ts
// mirroring packtool/storyline/__tests__/links-ac4-topk.test.ts — keep both
// in sync.
//
// All functions run inside the CALLER's transaction (same contract as the
// pipeline's stmt() helpers) — none of them manages transactions.

/** Cosine floor: a row exists only for score > threshold. Default 0.5. */
export const DEFAULT_LINKS_COSINE_THRESHOLD = 0.5;
/** Maximum rows per chunk. Default 3. */
export const LINKS_TOP_K = 3;

/**
 * Training slide doc paths are written by packtool/storyline/extract.ts as
 * `slide-${String(index + 1).padStart(3, '0')}-${slideId}.json` under docs/
 * (padStart is a no-op past 999 slides, hence \d+). MIRROR of
 * packtool/links/compute-links.ts's slideIdFromDocPath.
 */
const SLIDE_DOC_PATH_PATTERN = /^docs\/slide-\d+-(.+)\.json$/;

export function slideIdFromDocPath(docPath: string): string | null {
  const match = SLIDE_DOC_PATH_PATTERN.exec(docPath);
  return match === null ? null : (match[1] ?? null);
}

/** Structural subset of a better-sqlite3 Database this module needs. */
export interface LinksDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
}

export interface SlideVector {
  slideId: string;
  vector: number[];
}

export interface RecomputeLinksOptions {
  threshold?: number;
  topK?: number;
  /** ISO timestamp source; overridable for deterministic tests. */
  now?: () => string;
}

/**
 * Decode a stored embedding: sqlite-vec returns vec0 values as float32 LE
 * blobs while the ingest pipeline serializes JSON arrays — accept both,
 * refuse anything else (fail loud on corrupt rows).
 */
function decodeVector(value: unknown): number[] {
  if (value instanceof Uint8Array) {
    if (value.byteLength % 4 !== 0) {
      throw new Error('stored embedding blob is not a float32 vector');
    }
    const floats = new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
    return Array.from(floats);
  }
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'number')) {
      throw new Error('stored embedding JSON is not a number array');
    }
    return parsed as number[];
  }
  throw new Error(`stored embedding has unsupported type ${typeof value}`);
}

function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Load every training slide's id + embedding. Doc paths that do not parse as
 * slide docs are skipped (a training pack could carry auxiliary documents;
 * only parseable slides are deep-link targets). Malformed embedding values
 * throw — corruption must be loud, not silently unlinked.
 */
export function loadSlideVectors(db: LinksDb): SlideVector[] {
  const rows = db
    .prepare(
      "SELECT d.path AS path, e.embedding AS embedding FROM chunks c JOIN docs d ON d.id = c.doc_id JOIN embeddings e ON e.chunk_id = c.id WHERE d.source_class = 'training'",
    )
    .all() as Array<{ path: string; embedding: unknown }>;
  const slides: SlideVector[] = [];
  for (const row of rows) {
    const slideId = slideIdFromDocPath(row.path);
    if (slideId === null) continue;
    slides.push({ slideId, vector: decodeVector(row.embedding) });
  }
  return slides;
}

/**
 * Refresh the links of the given docs' chunks: existing links are deleted,
 * then recomputed against the store's active training slides — inside the
 * CALLER's transaction. Idempotent (delete-then-insert under the
 * (chunk_id, slide_id) primary key). A no-op write when the store holds no
 * training slides (rows deleted only). Returns the rows written.
 */
export function recomputeLinksForDocs(
  db: LinksDb,
  docIds: readonly string[],
  options: RecomputeLinksOptions = {},
): number {
  if (docIds.length === 0) return 0;
  const threshold = options.threshold ?? DEFAULT_LINKS_COSINE_THRESHOLD;
  const topK = options.topK ?? LINKS_TOP_K;
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
    throw new Error(`links threshold must be a finite number in [-1, 1], got ${String(options.threshold)}`);
  }
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error(`links topK must be a positive integer, got ${String(options.topK)}`);
  }
  const computedAt = (options.now ?? (() => new Date().toISOString()))();

  const slides = loadSlideVectors(db);
  let written = 0;
  const insertLink = db.prepare(
    'INSERT INTO links (chunk_id, slide_id, pack_id, score, rank, computed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const docId of docIds) {
    const docRow = db.prepare('SELECT source_class, pack_id FROM docs WHERE id = ?').get(docId) as
      | { source_class: string; pack_id: string | null }
      | undefined;
    if (docRow === undefined) continue;
    // Slides do not link to themselves; their chunks are the link TARGETS.
    if (docRow.source_class === 'training') continue;
    const chunkRows = db
      .prepare(
        'SELECT c.id AS chunk_id, e.embedding AS embedding FROM chunks c JOIN embeddings e ON e.chunk_id = c.id WHERE c.doc_id = ?',
      )
      .all(docId) as Array<{ chunk_id: string; embedding: unknown }>;
    if (chunkRows.length === 0) continue;
    db.prepare('DELETE FROM links WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)').run(docId);
    if (slides.length === 0) continue;
    for (const chunkRow of chunkRows) {
      const vector = decodeVector(chunkRow.embedding);
      const scored: Array<{ slideId: string; score: number }> = [];
      for (const slide of slides) {
        const score = cosineSimilarity(vector, slide.vector);
        // Strict floor-then-filter convention (rag-orchestrator MIN_* pattern):
        // a pair at exactly the threshold does not link.
        if (score === null || !(score > threshold)) continue;
        scored.push({ slideId: slide.slideId, score });
      }
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.slideId < b.slideId ? -1 : a.slideId > b.slideId ? 1 : 0;
      });
      const kept = scored.slice(0, topK);
      for (let i = 0; i < kept.length; i += 1) {
        const entry = kept[i];
        if (entry === undefined) continue;
        insertLink.run(
          chunkRow.chunk_id,
          entry.slideId,
          docRow.pack_id,
          entry.score,
          i + 1,
          computedAt,
        );
        written += 1;
      }
    }
  }
  return written;
}

/**
 * Delete links rows whose chunk no longer exists (the supersede-removal
 * helper a future pack lifecycle #70 calls after removing a pack's chunks).
 * Returns the number of orphaned rows removed.
 */
export function pruneOrphanLinks(db: LinksDb): number {
  const result = db
    .prepare('DELETE FROM links WHERE chunk_id NOT IN (SELECT id FROM chunks)')
    .run();
  return Number(result.changes);
}

/**
 * Delete every link row owned by a pack (the supersede helper that runs
 * BEFORE/ALONGSIDE removing the pack's chunks). Returns rows removed.
 */
export function removeLinksForPack(db: LinksDb, packId: string): number {
  const result = db.prepare('DELETE FROM links WHERE pack_id = ?').run(packId);
  return Number(result.changes);
}

/** One read-side links row (D6/#82 learn assembly). */
export interface LinkRow {
  chunk_id: string;
  slide_id: string;
  pack_id: string | null;
  score: number;
  rank: number;
}

/**
 * D6 (issue #82): read-side accessor — the links rows for the cited chunk
 * ids. Callers pass ids from retrieval; rows come back unordered (the learn
 * kernel re-ranks). Complements the write-side recomputators above: this is
 * the ask-time read path the Learn panel consumes.
 */
export function queryLinksForChunks(db: LinksDb, chunkIds: string[]): LinkRow[] {
  if (chunkIds.length === 0) return [];
  const placeholders = chunkIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT chunk_id, slide_id, pack_id, score, rank FROM links WHERE chunk_id IN (${placeholders})`,
    )
    .all(...chunkIds) as LinkRow[];
}
