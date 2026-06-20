/**
 * Embedding service using Transformers.js with ONNX runtime.
 * Provides browser-local embedding generation with OPFS/IndexedDB caching.
 * Uses BAAI/bge-small-en-v1.5 model (384-dim, ~130MB).
 */

import { pipeline, env, type Pipeline } from '@huggingface/transformers';
import type {
  EmbeddingVector,
  EmbeddingResult,
  EmbeddingModelInfo,
  EmbeddingProgressCallback,
} from '../../types/embedding';

// Model configuration
const MODEL_NAME = 'BAAI/bge-small-en-v1.5';
const EMBEDDING_DIMENSIONS = 384;

/**
 * Singleton embedding service for browser-local embeddings.
 * Handles model loading, caching, and text encoding.
 */
export class EmbeddingService {
  private static instance: EmbeddingService | null = null;

  private featureExtractor: Pipeline | null = null;
  private modelInfo: EmbeddingModelInfo;
  private ready: boolean = false;
  private initPromise: Promise<void> | null = null;
  private disposed: boolean = false;

  /**
   * Get the singleton instance, creating it if necessary.
   */
  static getInstance(): EmbeddingService {
    if (EmbeddingService.instance === null) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  /**
   * Private constructor for singleton pattern.
   */
  private constructor() {
    this.modelInfo = {
      name: MODEL_NAME,
      dimensions: EMBEDDING_DIMENSIONS,
      cached: false,
    };
    this.configureEnv();
  }

  /**
   * Configure Transformers.js environment for optimal browser usage.
   */
  private configureEnv(): void {
    // Use browser cache for model files (OPFS with IndexedDB fallback)
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // Enable persistent caching via OPFS/IndexedDB
    env.allowBrowserBlobStorage = true;

    // Enable ONNX runtime with adaptive thread count
    env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency
      ? Math.min(navigator.hardwareConcurrency, 4)
      : 2;
  }

  /**
   * Initialize the embedding model.
   * Loads the model from cache or downloads if needed.
   * Subsequent calls return the same promise.
   *
   * @returns Promise that resolves when model is loaded
   * @throws Error if model loading fails
   */
  async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

    // Return existing promise if initialization is in progress
    if (this.initPromise !== null) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  /**
   * Internal initialization logic.
   */
  private async doInitialize(): Promise<void> {
    try {
      // Create feature extraction pipeline
      // Using 'feature-extraction' task for embeddings
      this.featureExtractor = await pipeline(
        'feature-extraction',
        MODEL_NAME,
        {
          // ONNX runtime configuration
          dtype: 'fp32',
          device: 'wasm',
        }
      );

      // Verify model is cached by attempting a test encoding
      // Bypass isReady() check since we know featureExtractor is just created
      const testResult = await this.featureExtractor!('init', {
        pooling: 'mean',
        normalize: true,
      }) as { data: Float32Array; dims: number[] };
      if (testResult.data.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Model returned wrong embedding dimension: expected ${EMBEDDING_DIMENSIONS}, got ${testResult.data.length}`
        );
      }

      this.modelInfo.cached = true;
      // Check disposed flag to prevent race condition with dispose()
      if (this.disposed) {
        throw new Error('EmbeddingService was disposed during initialization');
      }
      this.ready = true;
    } catch (error) {
      // Release partially-initialized pipeline if it was created
      if (this.featureExtractor !== null) {
        await this.featureExtractor.dispose();
        this.featureExtractor = null;
      }
      this.initPromise = null;
      throw new Error(
        `Failed to initialize embedding model: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Check if the model is ready for encoding.
   */
  isReady(): boolean {
    return this.ready && this.featureExtractor !== null;
  }

  /**
   * Get model metadata.
   */
  getModelInfo(): EmbeddingModelInfo {
    return { ...this.modelInfo };
  }

  /**
   * Encode a single text into an embedding vector.
   *
   * @param text - Text to encode
   * @returns Promise resolving to 384-dimensional Float32Array
   * @throws Error if service is not initialized or encoding fails
   */
  async encode(text: string): Promise<EmbeddingVector> {
    if (!this.isReady()) {
      throw new Error('EmbeddingService not initialized. Call initialize() first.');
    }

    if (!text || text.trim().length === 0) {
      throw new Error('Cannot encode empty text');
    }

    try {
      const result = await this.featureExtractor!(text, {
        pooling: 'mean',
        normalize: true,
      }) as {
        data: Float32Array;
        dims: number[];
      };

      // Extract the embedding vector
      const embedding = new Float32Array(result.data);

      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${embedding.length}`
        );
      }

      return embedding;
    } catch (error) {
      throw new Error(
        `Failed to encode text: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Encode multiple texts with progress tracking.
   * Processes in batches for memory efficiency.
   *
   * @param texts - Array of texts to encode
   * @param onProgress - Optional callback for progress updates
   * @returns Promise resolving to array of embedding vectors
   * @throws Error if service is not initialized or any encoding fails
   */
  async encodeBatch(
    texts: string[],
    onProgress?: EmbeddingProgressCallback
  ): Promise<EmbeddingVector[]> {
    if (!this.isReady()) {
      throw new Error('EmbeddingService not initialized. Call initialize() first.');
    }

    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    // Validate texts
    for (let i = 0; i < texts.length; i++) {
      if (typeof texts[i] !== 'string') {
        throw new Error(`Text at index ${i} is not a string`);
      }
    }

    const results: EmbeddingVector[] = [];
    const total = texts.length;
    let processed = 0;

    try {
      // Process in smaller batches to manage memory on 16GB RAM systems
      const batchSize = 8;

      for (let i = 0; i < total; i += batchSize) {
        const batch = texts.slice(i, Math.min(i + batchSize, total));

        // Use native batch inference via featureExtractor directly
        const batchResults = await this.featureExtractor!(batch, {
          pooling: 'mean',
          normalize: true,
        }) as { data: Float32Array; dims: number[] };

        // batchResults.data is flat with all embeddings concatenated
        // Split into individual embedding vectors
        const embeddingLength = EMBEDDING_DIMENSIONS;
        for (let j = 0; j < batch.length; j++) {
          const start = j * embeddingLength;
          const end = start + embeddingLength;
          results.push(new Float32Array(batchResults.data.slice(start, end)));
        }

        processed += batch.length;

        // Report progress
        if (onProgress) {
          onProgress(processed, total);
        }
      }

      return results;
    } catch (error) {
      throw new Error(
        `Batch encoding failed at ${processed}/${total}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Encode a text and return full result metadata.
   *
   * @param text - Text to encode
   * @returns Promise resolving to EmbeddingResult
   */
  async encodeWithMetadata(text: string): Promise<EmbeddingResult> {
    const vector = await this.encode(text);
    return {
      vector,
      text,
      dimensions: EMBEDDING_DIMENSIONS,
    };
  }

  /**
   * Dispose of the service and release resources.
   * Call when done using the embedding service.
   */
  dispose(): void {
    this.disposed = true;
    if (this.featureExtractor !== null) {
      // Release ONNX/WASM session memory (~130MB)
      this.featureExtractor.dispose();
      this.featureExtractor = null;
    }
    this.ready = false;
    this.initPromise = null;
    this.modelInfo.cached = false;
    EmbeddingService.instance = null;
  }
}

/**
 * Convenience function to get the embedding service instance.
 */
export function getEmbeddingService(): EmbeddingService {
  return EmbeddingService.getInstance();
}
