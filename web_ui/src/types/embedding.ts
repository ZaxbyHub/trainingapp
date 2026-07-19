/**
 * Embedding types for vector storage and retrieval.
 * Uses snowflake-arctic-embed-m-v1.5 model (768-dimensional embeddings, Issue #37 R9).
 */

/**
 * A 768-dimensional embedding vector from snowflake-arctic-embed-m-v1.5.
 */
export type EmbeddingVector = Float32Array;

/**
 * An embedding entry associating a vector with its source document chunk.
 */
export interface EmbeddingEntry {
  docId: string;
  chunkIndex: number;
  vector: EmbeddingVector;
  /** Chunk text, so the vector index can return real text on search (F1). */
  text?: string;
  /** Source filename, threaded into citation metadata (F7). */
  source?: string;
  /** Page number, threaded into citation metadata (F7). */
  page?: number;
}

/**
 * Result of encoding a single text snippet.
 */
export interface EmbeddingResult {
  vector: EmbeddingVector;
  text: string;
  dimensions: number;
}

/**
 * Metadata about the embedding model.
 */
export interface EmbeddingModelInfo {
  name: string;
  dimensions: number;
  cached: boolean;
}

/**
 * Progress callback for batch operations.
 */
export type EmbeddingProgressCallback = (done: number, total: number) => void;

/**
 * Error types for embedding operations.
 */
export interface EmbeddingError {
  stage: 'init' | 'encode' | 'batch';
  message: string;
  cause?: unknown;
}
