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
    { score: number; docId: string; chunkIndex: number; text?: string }
  > = {};

  for (const results of resultsList) {
    for (let rank = 0; rank < results.length; rank++) {
      const doc = results[rank];
      const key = `${doc.docId}:${doc.chunkIndex}`;

      // First occurrence wins for the text field (highest rank = lowest rank number)
      if (!rrfScores[key]) {
        rrfScores[key] = {
          score: 0,
          docId: doc.docId,
          chunkIndex: doc.chunkIndex,
          text: doc.text,
        };
      }

      // RRF contribution: 1 / (k + rank + 1)
      // +1 because rank is 0-indexed
      rrfScores[key].score += 1.0 / (k + rank + 1);
    }
  }

  // Sort by RRF score descending
  const fused = Object.values(rrfScores).sort((a, b) => b.score - a.score);

  return fused.map((item) => ({
    docId: item.docId,
    chunkIndex: item.chunkIndex,
    score: item.score,
    text: item.text,
  }));
}
