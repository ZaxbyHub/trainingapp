/**
 * Embedding service using Transformers.js with ONNX runtime.
 *
 * OFFLINE-FIRST (Phase 1): the model is loaded exclusively from locally packaged
 * assets under `web_ui/public/models/embeddings/` — never from the HuggingFace CDN.
 * This is required for the fully self-contained, air-gapped / STIG-scannable archive.
 * See PACKAGING.md and scripts/prepare-models.mjs for how the weights are bundled.
 *
 * Uses Snowflake/snowflake-arctic-embed-m-v1.5 model (768-dim, q8 ~110MB),
 * loaded from `${EMBEDDING_MODELS_BASE}/snowflake-arctic-embed-m-v1.5/`.
 * Issue #37 R9 swapped from bge-small-en-v1.5 (384-dim, fp32 ~130MB).
 */

import type {
  EmbeddingVector,
  EmbeddingResult,
  EmbeddingModelInfo,
  EmbeddingProgressCallback,
} from '../../types/embedding';
import { EMBEDDING_MODEL_PATH } from '../models/model-manifest';
import { configureOfflineEnv } from '../models/offline-env';

// Model configuration.
// Issue #37 R9: swapped bge-small-en-v1.5 (384-dim) → snowflake-arctic-embed-
// m-v1.5 (768-dim, +3.5 nDCG@10 on MTEB-v1). `MODEL_NAME` keeps the canonical
// id for display/telemetry; `MODEL_PATH` is the path resolved against
// `env.localModelPath` (= /models), i.e. `embeddings/snowflake-arctic-embed-m-v1.5`.
const MODEL_NAME = 'Snowflake/snowflake-arctic-embed-m-v1.5';
const MODEL_PATH = EMBEDDING_MODEL_PATH;
const EMBEDDING_DIMENSIONS = 768;

/**
 * Internal type for correlating Worker request/reply pairs.
 * Each pending encode/encodeBatch call gets a unique id whose
 * resolve/reject pair is stored here until the Worker replies.
 */
interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

/**
 * Issue #37 R8: the actual embedding work runs in a Web Worker
 * (embedding.worker.ts) so the transformers.js pipeline and its WASM
 * forward passes never block the main thread.  This module-level variable
 * holds the one Worker instance, created once during doInitialize() and
 * terminated during dispose(). */
let worker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();

/**
 * Singleton embedding service for browser-local embeddings.
 * Handles model loading, caching, and text encoding.
 */
export class EmbeddingService {
  private static instance: EmbeddingService | null = null;

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
   * Configure Transformers.js for OFFLINE, locally-packaged usage.
   *
   * Delegates to the shared `configureOfflineEnv()` so every Transformers.js
   * consumer writes identical settings to the shared global `env` — see
   * offline-env.ts for why this must be centralized.
   */
  private configureEnv(): void {
    configureOfflineEnv();
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
   * Internal initialization logic — Issue #37 R8.
   *
   * Creates a Web Worker (embedding.worker.ts) and delegates the
   * transformers.js pipeline creation to it so WASM forward passes
   * never block the main thread.
   */
  private async doInitialize(): Promise<void> {
    if (worker) { this.ready = true; return; }

    try {
      configureOfflineEnv();
      await this._initWithWorker();

      if (this.disposed) {
        throw new Error('EmbeddingService was disposed during initialization');
      }
      this.ready = true;
    } catch (error) {
      const w = worker as Worker | null;
      if (w) {
        w.terminate();
        worker = null;
      }
      pendingRequests.clear();
      this.initPromise = null;
      throw new Error(
        `Failed to initialize embedding model: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Initialize via the embedding Worker (off-main-thread pipeline).
   * Sends an `init` message; the Worker replies with `ready` containing
   * the model dimensions, or `error` on failure.
   */
  private async _initWithWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        worker = new Worker(
          new URL('./embedding.worker.ts', import.meta.url),
          { type: 'module' }
        );

        worker.onmessage = (event: MessageEvent) => {
          const msg = event.data;
          if (msg.kind === 'ready') {
            this.modelInfo.dimensions = msg.dimensions;
            this.modelInfo.cached = true;
            resolve();
          } else if (msg.kind === 'error' && msg.id === -1) {
            reject(new Error(msg.message));
          } else if (msg.kind === 'encode-result' || msg.kind === 'encodeBatch-result' || msg.kind === 'error') {
            const pending = pendingRequests.get(msg.id);
            if (pending) {
              pendingRequests.delete(msg.id);
              if (msg.kind === 'error') {
                pending.reject(new Error(msg.message));
              } else {
                pending.resolve(msg);
              }
            }
          }
        };

        worker.onerror = (err: ErrorEvent) => {
          reject(new Error(`Embedding Worker failed: ${err.message}`));
        };

        worker.postMessage({
          kind: 'init',
          modelPath: MODEL_PATH,
          dimensions: EMBEDDING_DIMENSIONS,
        });
      } catch (err) {
        reject(new Error(
          `Failed to create embedding Worker: ${err instanceof Error ? err.message : String(err)}`
        ));
      }
    });
  }

  /**
   * Check if the model is ready for encoding.
   */
  isReady(): boolean {
    return this.ready && worker !== null;
  }

  /**
   * Get model metadata.
   */
  getModelInfo(): EmbeddingModelInfo {
    return { ...this.modelInfo };
  }

  /**
   * Post a message to the worker and await the reply.
   * Each request gets a unique correlation id stored in
   * pendingRequests until the worker replies.
   */
  private _postAndWait(msg: Record<string, unknown>): Promise<unknown> {
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      worker!.postMessage({ id, ...msg });
    });
  }

  /**
   * Encode a single text into an embedding vector.
   *
   * @param text - Text to encode
   * @returns Promise resolving to 768-dimensional Float32Array
   * @throws Error if service is not initialized or encoding fails
   */
  async encode(text: string): Promise<EmbeddingVector> {
    if (!this.isReady()) {
      throw new Error('EmbeddingService not initialized. Call initialize() first.');
    }

    if (!text || text.trim().length === 0) {
      throw new Error('Cannot encode empty text');
    }

    const result = await this._postAndWait({ kind: 'encode', text }) as {
      kind: 'encode-result';
      id: number;
      vector: Float32Array;
    };

    if (result.vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${result.vector.length}`
      );
    }
    return result.vector;
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
    _onProgress?: EmbeddingProgressCallback
  ): Promise<EmbeddingVector[]> {
    if (!this.isReady()) {
      throw new Error('EmbeddingService not initialized. Call initialize() first.');
    }

    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    for (let i = 0; i < texts.length; i++) {
      if (typeof texts[i] !== 'string') {
        throw new Error(`Text at index ${i} is not a string`);
      }
    }

    const result = await this._postAndWait({
      kind: 'encodeBatch',
      texts,
    }) as {
      kind: 'encodeBatch-result';
      id: number;
      vectors: Float32Array[];
    };

    return result.vectors;
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
    if (worker) {
      worker.terminate();
      worker = null;
    }
    pendingRequests.clear();
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
