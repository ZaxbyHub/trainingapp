/**
 * Search types for vector index and hybrid retrieval.
 * Used with HNSW vector index (EdgeVec) and embedding search.
 */

/**
 * A search result from vector similarity search.
 */
export interface SearchResult {
  /** Document ID this result belongs to */
  docId: string;
  /** Chunk index within the document */
  chunkIndex: number;
  /** Similarity score (higher = more similar) */
  score: number;
  /** Optional text content of the chunk */
  text?: string;
  /** Source filename for citation rendering (F7). */
  source?: string;
  /** Page number within the source document, when known (F7). */
  page?: number;
}

/**
 * Configuration for the HNSW vector index.
 */
export interface VectorIndexConfig {
  /** Dimensionality of embedding vectors (384 for bge-small-en-v1.5) */
  dimension: number;
  /** Distance metric for similarity search */
  metric: 'cosine' | 'l2';
  /** Maximum number of vectors the index can hold */
  maxElements: number;
  /** HNSW efConstruction parameter (higher = better quality, slower build) */
  efConstruction: number;
  /** HNSW M parameter (number of bi-directional links per layer) */
  M: number;
}

/**
 * Options for vector search operations.
 *
 * Note (Issue #37 R2): edgevec 0.6.0's `search(query, k)` API takes NO per-call
 * efSearch parameter — the HNSW `ef_search` is fixed at index construction
 * (see vector-index.ts doInitialize). The previous `efSearch` field here was a
 * dead declaration (never read by VectorIndex.search) and has been removed.
 */
export interface VectorSearchOptions {
  /** Number of nearest neighbors to return (default: 10) */
  k?: number;
}
