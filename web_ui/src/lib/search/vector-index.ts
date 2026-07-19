/**
 * HNSW Vector Index using EdgeVec (Rust/WASM) with IndexedDB persistence.
 * Provides efficient approximate k-NN search for 768-dimensional embeddings
 * (snowflake-arctic-embed-m-v1.5; was 384-dim bge-small-en-v1.5 pre-R9).
 * Designed for offline-first browser usage on 12th-gen i5 / 16GB RAM.
 */

import type { EmbeddingEntry, EmbeddingVector } from '../../types/embedding';
import type { SearchResult, VectorIndexConfig, VectorSearchOptions } from '../../types/search';
import initWasm, { EdgeVec, EdgeVecConfig } from 'edgevec';
import { getStorageDbNames } from '../storage/profile';

/**
 * F1: the per-store IndexedDB names now derive from the stable localStorage
 * profile prefix (see ../storage/profile) instead of a per-session
 * sessionStorage UUID, so the vector index persists across browser restarts and
 * is shared across tabs.
 */
const DB_NAMES = getStorageDbNames();
const DB_NAME = DB_NAMES.vectorMapping;
const INDEX_NAME = DB_NAMES.vector;

/**
 * Vector index content version. Bump when the persisted idMapping schema OR the
 * embedding space changes. On mismatch with a persisted version we treat the
 * stored index as incompatible and force a re-index (F1/F7 metadata + F9 CLS
 * pooling both change the schema/space from v1).
 *
 * NOTE: this is the *content* version stored as a key alongside the mapping —
 * it is distinct from the IndexedDB open-schema version (the `1` passed to
 * indexedDB.open below), which does not change here.
 */
// Issue #37 R9: bumped 2 → 3 for the snowflake-arctic-embed-m-v1.5 swap (768-
// dim embedding space, incompatible with the prior bge-small 384-dim vectors).
// A persisted corpus from version 2 is discarded and the re-index flag set so
// the UI prompts the user to re-add documents (no production users per issue §4).
export const VECTOR_INDEX_VERSION = 3;
/** localStorage flag set when a version mismatch invalidates the stored corpus,
 *  so the UI can show a one-time "re-add your documents" notice. */
const REINDEX_FLAG_KEY = 'rag-reindex-required';

/**
 * Default configuration for the vector index.
 */
const DEFAULT_CONFIG: VectorIndexConfig = {
  dimension: 768,
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
  private idMapping: Map<number, { docId: string; chunkIndex: number; text?: string; source?: string; page?: number }> = new Map();
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
      // ef_search controls HNSW search quality (higher = better recall, slower).
      // Issue #37 R2: raised from 50 to 128 to support the candidate-multiplier
      // over-fetch path. quality preset fetches up to topK×mult = 64 candidates;
      // ef_search should be ≥ 2× the fetch k to avoid HNSW pruning out the
      // chunks the reranker is meant to consider. edgevec 0.6's search(query,k)
      // takes no per-call ef, so this is set once at construction.
      config.ef_search = 128;
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
   * @param meta - Optional chunk text/source/page so search() can return real
   *   text and citation metadata (F1/F7). Omitted by older callers.
   */
  async addVector(
    vector: EmbeddingVector,
    docId: string,
    chunkIndex: number,
    meta?: { text?: string; source?: string; page?: number }
  ): Promise<void> {
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

      // Store mapping from internal ID to document metadata + chunk text (F1/F7)
      this.idMapping.set(internalId, {
        docId,
        chunkIndex,
        text: meta?.text,
        source: meta?.source,
        page: meta?.page,
      });
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
          text: entry.text,      // F1: real chunk text so search() returns it
          source: entry.source,  // F7: filename for citations
          page: entry.page,      // F7: page number for citations
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

      // Map results to SearchResult format. F11: skip entries whose internal id
      // has no resolvable metadata (orphaned ids from a non-atomic save or a
      // mapping desync) instead of fabricating `docId:'unknown'` results, which
      // silently polluted RAG retrieval with placeholder chunks.
      const mapped: SearchResult[] = [];
      for (const result of results) {
        const metadata = this.idMapping.get(result.id);
        if (!metadata) {
          console.warn(`[VectorIndex] Skipping search result with unmapped internal id ${result.id}`);
          continue;
        }
        mapped.push({
          docId: metadata.docId,
          chunkIndex: metadata.chunkIndex,
          score: result.score,
          text: metadata.text,     // F1: real chunk text
          source: metadata.source, // F7: filename
          page: metadata.page,     // F7: page number
        });
      }
      return mapped;
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
      // F11: persist idMapping BEFORE the EdgeVec snapshot. The two writes span
      // different databases/transactions so they cannot be made fully atomic,
      // but writing the mapping first means a crash between the two leaves the
      // PREVIOUS consistent state (old snapshot + old mapping) rather than a
      // new snapshot whose internal IDs have no resolvable metadata. A mapping
      // without its snapshot is harmless (loads as empty); a snapshot without
      // its mapping yields orphaned internal IDs that previously produced
      // fabricated `docId:'unknown'` search results.
      await this.saveMapping();
      await this.index!.save(INDEX_NAME);

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
      const request = indexedDB.open(DB_NAME, 1);
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
          text: meta.text,
          source: meta.source,
          page: meta.page,
        }));

        store.put({ key: 'idMapping', data: mappingArray });
        store.put({ key: 'version', version: VECTOR_INDEX_VERSION });
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
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, 1);

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
              this.idMapping.set(item.id, {
                docId: item.docId,
                chunkIndex: item.chunkIndex,
                text: item.text,
                source: item.source,
                page: item.page,
              });
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
   * Read the persisted content version from IndexedDB WITHOUT loading the
   * native EdgeVec blob. Return contract:
   *  - `null`  → there is nothing to check: either IndexedDB is unavailable
   *              (some test contexts) OR the database did not exist before this
   *              call (a brand-new install with no prior corpus). The caller
   *              skips the version check and proceeds with the normal load path.
   *  - `0`     → a mappings store ALREADY EXISTED (pre-upgrade DB) but has no
   *              version key. This is the signature of a pre-v2 index (v1,
   *              mean-pooled) — treated as incompatible and forced through the
   *              re-index path (F9).
   *  - number  → the persisted version (compare to VECTOR_INDEX_VERSION).
   *
   * The fresh-install distinction is critical: opening a non-existent DB fires
   * `onupgradeneeded` with `oldVersion === 0`, which would otherwise create the
   * store as a read side-effect and then (finding no version row) look
   * indistinguishable from a pre-v2 upgrade — producing a spurious re-index
   * notice for every new user (PRR-001).
   */
  private async readPersistedVersion(): Promise<number | null> {
    // In environments without IndexedDB, return null so the caller proceeds.
    if (typeof indexedDB === 'undefined') {
      return null;
    }
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, 1);
      // Track whether the DB (and thus the mappings store) existed BEFORE this
      // open call. A brand-new DB fires onupgradeneeded with oldVersion 0.
      let createdFresh = false;

      request.onerror = () => resolve(null);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        createdFresh = event.oldVersion === 0;
        const db = request.result;
        if (!db.objectStoreNames.contains('mappings')) {
          db.createObjectStore('mappings', { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        // Fresh install (DB did not exist before): nothing to re-index.
        if (createdFresh) {
          db.close();
          resolve(null);
          return;
        }
        if (!db.objectStoreNames.contains('mappings')) {
          db.close();
          // Pre-existing DB but no mappings object store → pre-v2 shape.
          resolve(0);
          return;
        }
        const tx = db.transaction('mappings', 'readonly');
        const store = tx.objectStore('mappings');
        const getReq = store.get('version');
        getReq.onsuccess = () => {
          db.close();
          const v = getReq.result?.version;
          // No version row → pre-v2 (v1) index. Resolve 0 so the mismatch check
          // forces a re-index rather than loading incompatible mean-pooled vectors.
          resolve(typeof v === 'number' ? v : 0);
        };
        getReq.onerror = () => {
          db.close();
          resolve(0);
        };
      };
    });
  }

  /**
   * Mark the stored corpus as needing re-indexing (version mismatch). Sets a
   * localStorage flag the UI reads once and clears on notice dismissal.
   */
  private flagReindexRequired(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(REINDEX_FLAG_KEY, '1');
      }
    } catch {
      /* private mode / storage disabled — non-fatal */
    }
  }

  /**
   * Load the index from IndexedDB using EdgeVec's native load.
   *
   * The persisted content version is checked BEFORE the native EdgeVec blob is
   * loaded: on mismatch we skip the load entirely (avoiding a stale v1 HNSW
   * graph whose internal IDs would not match a v2 mapping), flag a re-index,
   * and return false so the index is treated as empty. This is the F9 re-index
   * path — triggered by the CLS-pooling change, which moves the embedding
   * space and makes existing vectors incompatible.
   *
   * @returns true if a saved index was loaded, false if no saved index exists
   */
  async load(): Promise<boolean> {
    if (this.index === null) {
      throw new Error('VectorIndex not initialized');
    }

    // F9: check the persisted content version BEFORE loading the native blob.
    // `null` means IndexedDB is unavailable (e.g. a test context) — proceed with
    // the normal load path. Any non-null value that isn't VECTOR_INDEX_VERSION —
    // including 0 (a pre-v2/v1 store with no version key, i.e. mean-pooled
    // vectors from a previous build) — is incompatible and MUST be discarded so
    // a CLS-pooling client never loads mean-pooled vectors.
    const persistedVersion = await this.readPersistedVersion();
    if (persistedVersion !== null && persistedVersion !== VECTOR_INDEX_VERSION) {
      console.warn(
        `[VectorIndex] Stored index version ${persistedVersion === 0 ? '1 (pre-versioned)' : persistedVersion} ` +
        `is incompatible with current version ${VECTOR_INDEX_VERSION} (embedding space changed). ` +
        `Discarding stored index — re-add documents to rebuild the search index.`
      );
      this.idMapping.clear();
      this.flagReindexRequired();
      return false;
    }

    let loadedIndex = null;

    try {
      // Use EdgeVec's native static load method (FIX #1)
      loadedIndex = await EdgeVec.load(INDEX_NAME);

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
      // F17: a "not found" rejection is the expected fresh-boot case (no saved
      // index yet). The edgevec stub now rejects on miss (matching the real
      // backend), so log it at info level rather than error — a fresh boot with
      // no prior index must not produce an ERR_CORRUPTION console error. Any
      // other failure (genuine deserialization/corruption) still logs as error.
      const message = error instanceof Error ? error.message : String(error);
      // m3: match case-insensitively so a future backend message variant
      // ("Not Found" / "NOT FOUND") still routes to the benign fresh-boot path.
      if (/not found/i.test(message)) {
        console.info('[VectorIndex] No saved index found (fresh boot).');
      } else {
        console.error('[VectorIndex] Load failed:', error);
      }
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
