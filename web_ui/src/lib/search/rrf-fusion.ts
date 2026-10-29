import type { SearchResult } from '../../types/search';

/**
 * Reciprocal Rank Fusion (RRF) - fuses multiple ranked result lists.
 *
 * Faithful port of the Python algorithm from utils.py.
 * Uses docId:chunkIndex as the unique key for deduplication.
 *
 * @param resultsList - Array of SearchResult arrays from different rankers
 * @param k - RRF constant (default: 60). Higher values make all rankers contribute more equally.
 * @returns Fused and sorted SearchResult array
 */
export function rrfFuse(resultsList: SearchResult[][], k: number = 60): SearchResult[] {
  const rrfScores: Record<
    string,
    { score: number; docId: string; chunkIndex: number; text?: string; source?: string; page?: number }
  > = {};

  for (const results of resultsList) {
    for (let rank = 0; rank < results.length; rank++) {
      const doc = results[rank];
      const key = `${doc.docId}:${doc.chunkIndex}`;

      // Ensure an entry exists for this chunk key.
      if (!rrfScores[key]) {
        rrfScores[key] = {
          score: 0,
          docId: doc.docId,
          chunkIndex: doc.chunkIndex,
        };
      }
      const entry = rrfScores[key];

      // Merge metadata order-agnostically: first NON-EMPTY value wins for each
      // field. This makes fusion robust regardless of which input list is first
      // (defense in depth for F1 — a chunk found only by vector search carries
      // its text once VectorIndex stores it; a chunk found by both takes text
      // from whichever list actually has it).
      if (entry.text === undefined && doc.text !== undefined) entry.text = doc.text;
      if (entry.source === undefined && doc.source !== undefined) entry.source = doc.source;
      if (entry.page === undefined && doc.page !== undefined) entry.page = doc.page;

      // RRF contribution: 1 / (k + rank + 1)
      // +1 because rank is 0-indexed
      entry.score += 1.0 / (k + rank + 1);
    }
  }

  // Sort by RRF score descending
  const fused = Object.values(rrfScores).sort((a, b) => b.score - a.score);

  return fused.map((item) => ({
    docId: item.docId,
    chunkIndex: item.chunkIndex,
    score: item.score,
    text: item.text,
    source: item.source,
    page: item.page,
  }));
}

// ---------------------------------------------------------------------------
// Near-duplicate suppression (#35-B2, batch-153-35-rag-quality)
// ---------------------------------------------------------------------------

/**
 * Default minimum ordered seam run (in words) that marks an adjacent
 * overlap twin. Construction carries at most `chunkOverlap` (100) words of
 * overlap and the long-sentence split path carries floor(overlap/2) = 50;
 * a >=20-word exact ordered seam run is overlap by shape, not coincidence.
 */
export const DEFAULT_MIN_OVERLAP_WORDS = 20;

/** Construction caps the carried overlap at `chunkOverlap` (100 words). */
const MAX_SEAM_WORDS = 100;

function contentWords(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Longest L such that the trailing L words of `a` equal the leading L words
 * of `b` element-wise (ordered seam run). Bounded by MAX_SEAM_WORDS.
 */
function seamRunLength(a: string[], b: string[]): number {
  const max = Math.min(MAX_SEAM_WORDS, a.length, b.length);
  for (let len = max; len > 0; len--) {
    let matched = true;
    for (let i = 0; i < len; i++) {
      if (a[a.length - len + i] !== b[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return len;
  }
  return 0;
}

/**
 * Suppress near-duplicate candidates after RRF fusion (#35-B2): the chunker
 * deliberately emits overlapping adjacent chunks (different
 * `${docId}:${chunkIndex}` keys), so exact-key fusion alone lets an overlap
 * twin occupy a second topK slot and consume context budget twice.
 *
 * Predicate (keep-first, order-preserving — the higher-ranked candidate is
 * kept):
 *   - Adjacency arm: SAME docId AND adjacent chunkIndex (|diff| == 1) are
 *     near-duplicates iff the LONGEST ORDERED suffix-of-one ===
 *     prefix-of-the-other word run (element-wise equality, both directions —
 *     document order is not fusion order) is >= `minOverlapWords`.
 *   - Exact-duplicate arm: whitespace/lowercase-normalized full-text
 *     equality collapses a pair regardless of docId (re-uploaded documents).
 *   - Missing/empty text: never a duplicate. Reordered word bags and
 *     mid-chunk similarity: not duplicates (ordered seam-run requirement).
 *
 * Known disclosed residual: adjacent chunks sharing a >=minOverlapWords
 * exact ordered EDGE run of repeated boilerplate (page headers/footers) are
 * textually indistinguishable from overlap twins at this boundary and are
 * deduped; the kept (higher-ranked) chunk's distinct content survives.
 */
export function dedupeNearDuplicates(
  results: SearchResult[],
  options?: { minOverlapWords?: number }
): SearchResult[] {
  const minOverlap = options?.minOverlapWords ?? DEFAULT_MIN_OVERLAP_WORDS;
  const kept: SearchResult[] = [];
  const keptWords: string[][] = [];
  const seenExact = new Set<string>();

  for (const result of results) {
    const text = result.text ?? '';
    if (!text.trim()) {
      // No-text entries pass through untouched and match nothing.
      kept.push(result);
      keptWords.push([]);
      continue;
    }

    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (seenExact.has(normalized)) continue;

    const words = contentWords(text);
    let duplicate = false;
    for (let i = 0; i < kept.length; i++) {
      const candidate = kept[i];
      if (candidate.docId !== result.docId) continue;
      if (Math.abs((candidate.chunkIndex ?? 0) - (result.chunkIndex ?? 0)) !== 1) continue;
      const candidateWords = keptWords[i]!;
      if (candidateWords.length === 0 || words.length === 0) continue;
      if (
        seamRunLength(candidateWords, words) >= minOverlap ||
        seamRunLength(words, candidateWords) >= minOverlap
      ) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;

    seenExact.add(normalized);
    kept.push(result);
    keptWords.push(words);
  }

  return kept;
}
