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
