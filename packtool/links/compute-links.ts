// links/compute-links.ts — doc-chunk -> training-slide link math (D4/#80).
//
// PURE module: no sqlite, no fs — the same kernel is exercised by the
// `packtool links` CLI verb (build-machine pre-linking, the step #73's
// build-docs will call as a library) and is mirrored by the runtime
// maintenance surface in desktop/main/backend/store/links.ts (the desktop
// cannot import this package; parity is pinned by identical golden test
// vectors in packtool/storyline/__tests__/links-ac4-topk.test.ts and
// desktop/src/__tests__/d4-links-store.test.ts — keep both in sync).
//
// Semantics (frozen acceptance contract, trace 80-recompute-doc-slide-links):
//   score = cosine similarity; a row exists only when
//   score > (options.threshold ?? 0.5); at most options.topK (default 3)
//   rows per chunk ranked 1..n score-descending (ties break by slide_id so
//   identical inputs always produce identical rows); computed_at is a
//   non-empty ISO-8601 UTC timestamp; pack_id echoes the input chunk's.

export const DEFAULT_LINKS_COSINE_THRESHOLD = 0.5;
export const LINKS_TOP_K = 3;

/**
 * Training slide doc paths are written by packtool/storyline/extract.ts:133
 * as `slide-${String(index + 1).padStart(3, '0')}-${slideId}.json` under
 * docs/ (padStart is a no-op past 999 slides, hence \d+). Everything between
 * the digits' hyphen and the trailing .json is the Storyline slide id.
 */
const SLIDE_DOC_PATH_PATTERN = /^docs\/slide-\d+-(.+)\.json$/;

/** Extract the Storyline slide id from a training doc's pack-relative path. */
export function slideIdFromDocPath(docPath: string): string | null {
  const match = SLIDE_DOC_PATH_PATTERN.exec(docPath);
  return match === null ? null : (match[1] ?? null);
}

export interface LinkChunk {
  chunkId: string;
  /** Owning doc pack id, or null for unpackaged (runtime-ingested) docs. */
  packId: string | null;
  vector: number[];
}

export interface LinkSlide {
  slideId: string;
  vector: number[];
}

export interface LinkRow {
  chunk_id: string;
  slide_id: string;
  pack_id: string | null;
  score: number;
  rank: number;
  computed_at: string;
}

export interface ComputeLinksOptions {
  /** Cosine floor; a row exists only for score > threshold. Default 0.5. */
  threshold?: number;
  /** Maximum rows per chunk. Default 3. */
  topK?: number;
  /** ISO timestamp source; overridable for deterministic tests. */
  now?: () => string;
}

/**
 * Cosine similarity with a zero-norm guard: a zero vector has no direction,
 * so any pairing involving it is excluded (returns null) rather than
 * producing a NaN score.
 */
export function cosineSimilarity(a: number[], b: number[]): number | null {
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
 * Compute doc-chunk -> training-slide links: for each chunk, the top-K
 * slides above the cosine threshold, ranked by descending score.
 */
export function computeDocSlideLinks(
  chunks: readonly LinkChunk[],
  slides: readonly LinkSlide[],
  options: ComputeLinksOptions = {},
): LinkRow[] {
  const threshold = options.threshold ?? DEFAULT_LINKS_COSINE_THRESHOLD;
  const topK = options.topK ?? LINKS_TOP_K;
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
    throw new Error(`links threshold must be a finite number in [-1, 1], got ${String(options.threshold)}`);
  }
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error(`links topK must be a positive integer, got ${String(options.topK)}`);
  }
  const computedAt = (options.now ?? defaultNow)();
  if (computedAt === '') throw new Error('links computed_at must be a non-empty timestamp');

  const rows: LinkRow[] = [];
  for (const chunk of chunks) {
    const scored: Array<{ slideId: string; score: number }> = [];
    for (const slide of slides) {
      const score = cosineSimilarity(chunk.vector, slide.vector);
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
      rows.push({
        chunk_id: chunk.chunkId,
        slide_id: entry.slideId,
        pack_id: chunk.packId,
        score: entry.score,
        rank: i + 1,
        computed_at: computedAt,
      });
    }
  }
  return rows;
}

function defaultNow(): string {
  return new Date().toISOString();
}
