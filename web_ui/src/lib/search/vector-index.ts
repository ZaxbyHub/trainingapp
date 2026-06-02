/**
 * HNSW Vector Index using EdgeVec (Rust/WASM) with IndexedDB persistence.
 * Provides efficient approximate k-NN search for 384-dimensional embeddings.
 * Designed for offline-first browser usage on 12th-gen i5 / 16GB RAM.
 */

import type { EmbeddingEntry, EmbeddingVector } from '../../types/embedding';
import type { SearchResult, VectorIndexConfig, VectorSearchOptions } from '../../types/search';
import initWasm, { EdgeVec, EdgeVecConfig } from 'edgevec';

/**
 * Default configuration for the vector index.
 */
const DEFAULT_CONFIG: VectorIndexConfig = {
  dimension: 384,
  metric: 'cosine',
  maxElements: 100000,
  efConstruction: 200,
  M: 16,
};

/**
 * Singleton HNSW vector index for browser-local similarity search.
 * Uses EdgeVec (Rust/WASM) for high-performance vector operations
 * with native IndexedDB persistence for offline-first capability.
 */
export class VectorIndex {
  private static instance: VectorIndex | null = null;

  private index: EdgeVec | null = null;
  private config: VectorIndexConfig;
  private ready: boolean = false;
  private initPromise: Promise<void> | null = null;
  private idMapping: Map<number, { docId: string; chunkIndex: number }> = new Map();
  private disposed: boolean = false;

  /**
   * Get the singleton instance, creating it if necessary.
   */
  static getInstance(): VectorIndex {
    if (VectorIndex.instance === null) {
      VectorIndex.instance = new VectorIndex();
    }
    return VectorIndex.instance;
  }

  /**
   * Private constructor for singleton pattern.
   */
  private constructor(config: Partial<VectorIndexConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Initialize the EdgeVec index and load persisted data.
   *
   * @returns Promise that resolves when initialization is complete
   * @throws Error if EdgeVec initialization fails
   */
  async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

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
      // Initialize EdgeVec WASM module - MUST be called before using EdgeVec
      await initWasm();

      // Create EdgeVec index with EdgeVecConfig instance
      const config = new EdgeVecConfig(this.config.dimension);
      config.metric = this.config.metric;
      config.ef_construction = this.config.efConstruction;
      config.m = this.config.M;
      config.ef_search = 50;
      this.index = new EdgeVec(config);
      config.free();

      // Try to load persisted index from IndexedDB using native EdgeVec.load
      const loaded = await this.load();
      if (loaded) {
        console.info(`[VectorIndex] Loaded ${this.size()} vectors from IndexedDB`);
      }

      this.ready = true;
    } catch (error) {
      this.index = null;
      this.ready = false;
      this.initPromise = null;
      throw new Error(
        `Failed to initialize VectorIndex: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Check if the index is ready for operations.
   */
  isReady(): boolean {
    return this.ready && this.index !== null && !this.disposed;
  }

  /**
   * Add a single vector to the index.
   *
   * @param vector - The embedding vector to add
   * @param docId - Document ID this vector belongs to
   * @param chunkIndex - Chunk index within the document
   */
  async addVector(vector: EmbeddingVector, docId: string, chunkIndex: number): Promise<void> {
    if (!this.isReady()) {
      throw new Error('VectorIndex not initialized. Call initialize() first.');
    }

    if (!vector || vector.length !== this.config.dimension) {
      throw new Error(
        `Invalid vector dimension: expected ${this.config.dimension}, got ${vector?.length ?? 0}`
      );
    }

    try {
      // Check if index can accept more vectors
      if (!this.index!.canInsert()) {
        throw new Error('Index is full, cannot insert more vectors');
      }

      // Insert vector to EdgeVec index - returns internal ID
      // EdgeVec.insert expects Float32Array, pass directly without conversion
      const internalId = this.index!.insert(vector as Float32Array);

      // Store mapping from internal ID to document metadata
      this.idMapping.set(internalId, { docId, chunkIndex });
    } catch (error) {
      throw new Error(
        `Failed to add vector: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Add multiple vectors in batch with progress tracking.
   *
   * @param entries - Array of embedding entries to add
   */
  async addBatch(entries: EmbeddingEntry[]): Promise<void> {
    if (!this.isReady()) {
      throw new Error('VectorIndex not initialized. Call initialize() first.');
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    const total = entries.length;

    try {
      // Convert entries to Float32Array vectors for batch insert
      const vectors: Float32Array[] = [];
      const entryIndices: number[] = [];
      for (let i = 0; i < total; i++) {
        const entry = entries[i];
        if (!entry.vector || entry.vector.length !== this.config.dimension) {
          console.warn(`[VectorIndex] Skipping entry ${i} with invalid vector dimension`);
          continue;
        }
        vectors.push(entry.vector as Float32Array);
        entryIndices.push(i);
      }

      // Check if index can accept the full batch (FIX #4)
      const currentCount = this.index!.liveCount();
      if (currentCount + vectors.length > this.config.maxElements) {
        throw new Error(
          `Index is full: ${currentCount} live + ${vectors.length} new > ${this.config.maxElements} maxElements`
        );
      }

      // Use EdgeVec's native batch insert with progress callback (synchronous)
      const result = this.index!.insertBatchWithProgress(vectors, (done: number, _total: number) => {
        // Log progress every 1000 items
        if (done > 0 && done % 1000 === 0) {
          console.info(`[VectorIndex] Indexed ${done}/${vectors.length} vectors`);
        }
      });

      // Map inserted vectors to their IDs using returned BigUint64Array
      for (let j = 0; j < result.inserted; j++) {
        const internalId = Number(result.ids[j]);
        const entryIndex = entryIndices[j];
        const entry = entries[entryIndex];
        this.idMapping.set(internalId, {
          docId: entry.docId!,
          chunkIndex: entry.chunkIndex,
        });
      }
      console.info(`[VectorIndex] Batch indexed ${result.inserted} vectors`);
      result.free();
    } catch (error) {
      throw new Error(
        `Batch add failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Search for k nearest neighbors.
   *
   * @param queryVector - The query vector
   * @param options - Search options (k defaults to 10)
   * @returns Array of search results sorted by score descending
   */
  async search(queryVector: EmbeddingVector, options?: VectorSearchOptions): Promise<SearchResult[]> {
    if (!this.isReady()) {
      throw new Error('VectorIndex not initialized. Call initialize() first.');
    }

    if (!queryVector || queryVector.length !== this.config.dimension) {
      throw new Error(
        `Invalid query vector dimension: expected ${this.config.dimension}, got ${queryVector?.length ?? 0}`
      );
    }

    const k = options?.k ?? 10;

    try {
      // Perform HNSW search - EdgeVec.search takes only query and k
      // Pass Float32Array directly without conversion
      const results = this.index!.search(queryVector as Float32Array, k) as Array<{ id: number; score: number }>;

      // Map results to SearchResult format
      return results.map((result) => {
        const metadata = this.idMapping.get(result.id);
        return {
          docId: metadata?.docId ?? 'unknown',
          chunkIndex: metadata?.chunkIndex ?? 0,
          score: result.score,
        };
      });
    } catch (error) {
      throw new Error(
        `Search failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Remove all vectors associated with a document.
   *
   * @param docId - Document ID to remove
   */
  async removeByDocId(docId: string): Promise<void> {
    if (!this.isReady()) {
      throw new Error('VectorIndex not initialized. Call initialize() first.');
    }

    try {
      // Find all internal IDs associated with this document
      const toRemove: number[] = [];
      for (const [internalId, metadata] of this.idMapping) {
        if (metadata.docId === docId) {
          toRemove.push(internalId);
        }
      }

      // Soft-delete from EdgeVec index using softDelete
      for (const internalId of toRemove) {
        this.index!.softDelete(internalId);
        this.idMapping.delete(internalId);
      }

      console.info(`[VectorIndex] Removed ${toRemove.length} vectors for docId: ${docId}`);
    } catch (error) {
      throw new Error(
        `Remove failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Persist the index to IndexedDB using EdgeVec's native save.
   */
  async save(): Promise<void> {
    if (!this.isReady()) {
      throw new Error('VectorIndex not initialized. Call initialize() first.');
    }

    try {
      // Use EdgeVec's native save with custom index name
      await this.index!.save('doc-qa-index');

      // Persist idMapping alongside the EdgeVec index (FIX #2)
      await this.saveMapping();

      console.info(`[VectorIndex] Saved ${this.size()} vectors to IndexedDB`);
    } catch (error) {
      throw new Error(
        `Save failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Persist idMapping to IndexedDB as JSON blob.
   */
  private async saveMapping(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('doc-qa-indexes', 1);
      request.onerror = () => reject(new Error('Failed to open IndexedDB for mapping save'));

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('mappings')) {
          db.createObjectStore('mappings', { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('mappings', 'readwrite');
        const store = tx.objectStore('mappings');

        const mappingArray = Array.from(this.idMapping.entries()).map(([id, meta]) => ({
          id,
          docId: meta.docId,
          chunkIndex: meta.chunkIndex,
        }));

        store.put({ key: 'idMapping', data: mappingArray });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(new Error('Failed to save idMapping'));
        };
      };
    });
  }

  /**
   * Load idMapping from IndexedDB.
   */
  private async loadMapping(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('doc-qa-indexes', 1);

      request.onerror = () => {
        // IndexedDB might not exist yet, which is fine
        this.idMapping.clear();
        resolve();
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('mappings')) {
          db.createObjectStore('mappings', { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('mappings')) {
          db.close();
          this.idMapping.clear();
          resolve();
          return;
        }

        const tx = db.transaction('mappings', 'readonly');
        const store = tx.objectStore('mappings');
        const getRequest = store.get('idMapping');

        getRequest.onsuccess = () => {
          const result = getRequest.result;
          if (result && result.data) {
            this.idMapping.clear();
            for (const item of result.data) {
              this.idMapping.set(item.id, { docId: item.docId, chunkIndex: item.chunkIndex });
            }
          } else {
            this.idMapping.clear();
          }
          db.close();
          resolve();
        };

        getRequest.onerror = () => {
          db.close();
          this.idMapping.clear();
          resolve();
        };
      };
    });
  }

  /**
   * Load the index from IndexedDB using EdgeVec's native load.
   *
   * @returns true if a saved index was loaded, false if no saved index exists
   */
  async load(): Promise<boolean> {
    if (this.index === null) {
      throw new Error('VectorIndex not initialized');
    }

    let loadedIndex = null;

    try {
      // Use EdgeVec's native static load method (FIX #1)
      loadedIndex = await EdgeVec.load('doc-qa-index');

      if (!loadedIndex) {
        console.info('[VectorIndex] No saved index found in IndexedDB');
        return false;
      }

      // Load mapping FIRST — if this fails, we dispose loadedIndex and keep old index intact
      await this.loadMapping();

      // Only assign index after mapping loads successfully
      if (this.index) {
        if (typeof this.index[Symbol.dispose] === 'function') {
          this.index[Symbol.dispose]();
        } else if (typeof this.index.free === 'function') {
          this.index.free();
        }
      }
      this.index = loadedIndex;

      console.info(`[VectorIndex] Loaded ${this.size()} vectors from IndexedDB`);
      return true;
    } catch (error) {
      console.error('[VectorIndex] Load failed:', error);
      // Dispose loadedIndex to avoid WASM memory leak
      if (loadedIndex) {
        if (typeof loadedIndex[Symbol.dispose] === 'function') {
          loadedIndex[Symbol.dispose]();
        } else if (typeof loadedIndex.free === 'function') {
          loadedIndex.free();
        }
      }
      // Return false on load failure - index remains empty but usable
      return false;
    }
  }

  /**
   * Get the number of vectors in the index.
   */
  size(): number {
    return this.index?.liveCount() ?? this.idMapping.size;
  }

  /**
   * Dispose of the index and release WASM resources.
   */
  dispose(): void {
    this.disposed = true;

    if (this.index !== null) {
      // Free WASM resources using Symbol.dispose or free()
      if (typeof this.index[Symbol.dispose] === 'function') {
        this.index[Symbol.dispose]();
      } else if (typeof this.index.free === 'function') {
        this.index.free();
      }
      this.index = null;
    }

    this.idMapping.clear();
    this.ready = false;
    this.initPromise = null;

    VectorIndex.instance = null;
  }
}

/**
 * Convenience function to get the VectorIndex instance.
 */
export function getVectorIndex(): VectorIndex {
  return VectorIndex.getInstance();
}
