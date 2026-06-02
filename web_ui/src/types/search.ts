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
 */
export interface VectorSearchOptions {
  /** Number of nearest neighbors to return (default: 10) */
  k?: number;
  /** HNSW efSearch parameter (higher = better recall, slower search) */
  efSearch?: number;
}
