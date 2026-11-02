/**
 * Resolution-based Keyword Index using FlexSearch with IndexedDB persistence.
 * Provides high-performance browser keyword search using FlexSearch's built-in
 * resolution-based scoring algorithm (not BM25). No stop-word filtering or
 * stemming is configured.
 * Designed for offline-first browser usage on 12th-gen i5 / 16GB RAM.
 */

import { Index } from 'flexsearch';
import type { SearchResult } from '../../types/search';
import type { DocumentChunk } from '../../types/document';
import { getStorageDbNames } from '../storage/profile';
import { withStoreLock } from '../storage/cross-tab';
import { createStoreChannel } from '../storage/cross-tab-channel';

/**
 * F1: the per-store IndexedDB names now derive from the stable localStorage
 * profile prefix (see ../storage/profile) instead of a per-session
 * sessionStorage UUID, so the keyword index persists across browser restarts
 * and is shared across tabs.
 */
const DB_NAMES = getStorageDbNames();
const DB_NAME = DB_NAMES.keyword;
const DB_VERSION = 1;
const STORE_NAME = 'keyword-index';

/**
 * Change announcements (#270): successful saves notify other tabs so they can
 * reload instead of serving (and later re-saving) stale in-memory blobs.
 * Merge correctness never depends on delivery - every save re-reads the
 * persisted baseline under the store lock.
 */
const changeChannel = createStoreChannel(`${DB_NAME}-changes`);

function postChange(): void {
  changeChannel.postChange();
}

interface IndexEntry {
  id: string;
  docId: string;
  chunkIndex: number;
  text: string;
  source?: string;
  page?: number;
  packId?: string; packVersion?: string;
}

interface StoredData {
  entries: IndexEntry[];
  documentChunks: Map<string, Set<string>>;
}

/**
 * Singleton resolution-based keyword index using FlexSearch.
 * Uses FlexSearch Index mode with resolution-based scoring for
 * high-quality keyword search with IndexedDB persistence.
 */
export class KeywordIndex {
  private static instance: KeywordIndex | null = null;

  private index: InstanceType<typeof Index> | null = null;
  private ready: boolean = false;
  private initPromise: Promise<void> | null = null;
  private disposed: boolean = false;

  // In-memory mapping from FlexSearch document ID to chunk metadata
  private idMapping: Map<string, { docId: string; chunkIndex: number; text: string; source?: string; page?: number; packId?: string; packVersion?: string }> = new Map();
  // Reverse mapping: docId -> Set of chunk indices
  private docIdToChunks: Map<string, Set<string>> = new Map();
  /**
   * #270: this tab's own mutations since the last successful save - `put`
   * for docIds whose chunks were (re-)added, `remove` for docIds removed.
   * save() merges from the FRESHLY READ persisted baseline, so entries
   * another tab wrote since our last load are merged, never wiped by a
   * whole-blob replace.
   */
  private pendingOps: Map<string, 'put' | 'remove'> = new Map();

  /**
   * Get the singleton instance, creating it if necessary.
   */
  static getInstance(): KeywordIndex {
    if (KeywordIndex.instance === null) {
      KeywordIndex.instance = new KeywordIndex();
    }
    return KeywordIndex.instance;
  }

  /**
   * Private constructor for singleton pattern.
   */
  private constructor() {
    // FlexSearch Index configuration done in initialize()
  }

  /**
   * Initialize the FlexSearch index.
   *
   * @returns Promise that resolves when initialization is complete
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
      // Create FlexSearch Index with resolution-based ranking
      // Using tokenize: "full" for better phrase matching. `worker: false` is a
      // valid runtime option (keeps the index serializable for IndexedDB) but is
      // not in the v0.8 IndexOptions type — cast to preserve behavior.
      this.index = new Index({
        tokenize: 'full',
        worker: false,
        resolution: 9,
      } as ConstructorParameters<typeof Index>[0]);

      // Try to load persisted index from IndexedDB
      const loaded = await this.load();
      if (loaded) {
        console.info(`[KeywordIndex] Loaded ${this.size()} entries from IndexedDB`);
      }

      this.ready = true;
    } catch (error) {
      this.index = null;
      this.ready = false;
      this.initPromise = null;
      throw new Error(
        `Failed to initialize KeywordIndex: ${error instanceof Error ? error.message : String(error)}`,
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
   * Add a single document chunk to the index.
   *
   * @param docId - Document ID this chunk belongs to
   * @param chunkIndex - Chunk index within the document
   * @param text - Text content to index
   * @param meta - Optional filename/page for citation rendering (F7)
   */
  addDocument(
    docId: string,
    chunkIndex: number,
    text: string,
    meta?: { source?: string; page?: number; packId?: string; packVersion?: string }
  ): void {
    if (!this.isReady()) {
      throw new Error('KeywordIndex not initialized. Call initialize() first.');
    }

    if (!text || typeof text !== 'string') {
      throw new Error('Text must be a non-empty string');
    }

    const id = this.makeChunkId(docId, chunkIndex);

    // Store metadata for retrieval
    this.idMapping.set(id, {
      docId,
      chunkIndex,
      text,
      source: meta?.source,
      page: meta?.page,
      ...(meta?.packId !== undefined ? { packId: meta.packId } : {}),
      ...(meta?.packVersion !== undefined ? { packVersion: meta.packVersion } : {}),
    });

    // Update reverse mapping
    if (!this.docIdToChunks.has(docId)) {
      this.docIdToChunks.set(docId, new Set());
    }
    this.docIdToChunks.get(docId)!.add(id);

    // Add to FlexSearch index
    this.index!.add(id, text);

    this.pendingOps.set(docId, 'put');
  }

  /**
   * Add multiple document chunks in batch.
   *
   * @param chunks - Array of DocumentChunk to add
   */
  addDocuments(chunks: DocumentChunk[]): void {
    if (!this.isReady()) {
      throw new Error('KeywordIndex not initialized. Call initialize() first.');
    }

    if (!Array.isArray(chunks) || chunks.length === 0) {
      return;
    }

    for (const chunk of chunks) {
      if (!chunk.docId) {
        throw new Error(`Document chunk missing docId at index ${chunk.chunkIndex}`);
      }
      this.addDocument(chunk.docId, chunk.chunkIndex, chunk.text, {
        source: chunk.source,
        page: chunk.page,
        packId: chunk.packId,
        packVersion: chunk.packVersion,
      });
    }

    console.info(`[KeywordIndex] Batch indexed ${chunks.length} chunks`);
  }

  /**
   * Search for chunks matching the query.
   *
   * @param query - Search query string
   * @param options - Search options (limit defaults to 10)
   * @returns Array of SearchResult sorted by score descending
   */
  search(query: string, options?: { limit?: number }): SearchResult[] {
    if (!this.isReady()) {
      throw new Error('KeywordIndex not initialized. Call initialize() first.');
    }

    if (!query || typeof query !== 'string') {
      return [];
    }

    const limit = options?.limit ?? 10;

    try {
      // Search FlexSearch index - returns array of document IDs. With the
      // non-worker Index config above, search() returns synchronously; cast the
      // union return (which also includes Promise/Resolver under worker mode)
      // to the synchronous array shape actually produced here.
      const results = this.index!.search(query, { limit, suggest: true }) as Array<string | number>;

      // F11: skip entries whose FlexSearch id has no resolvable metadata
      // instead of fabricating `docId:'unknown'` results (mirrors VectorIndex).
      const mapped: SearchResult[] = [];
      let rank = 0;
      for (const id of results) {
        const meta = this.idMapping.get(String(id));
        if (!meta) {
          console.warn(`[KeywordIndex] Skipping search result with unmapped id ${id}`);
          continue;
        }
        mapped.push({
          docId: meta.docId,
          chunkIndex: meta.chunkIndex,
          score: 1 / (rank + 1), // Position-based scoring: higher rank = higher score
          text: meta.text,
          source: meta.source, // F7: filename for citations
          page: meta.page,     // F7: page number for citations
          ...(meta.packId !== undefined ? { packId: meta.packId } : {}),
          ...(meta.packVersion !== undefined ? { packVersion: meta.packVersion } : {}),
        });
        rank++;
      }
      return mapped;
    } catch (error) {
      console.error('[KeywordIndex] Search failed:', error);
      return [];
    }
  }

  /**
   * Remove all chunks associated with a document.
   *
   * @param docId - Document ID to remove
   */
  removeByDocId(docId: string): void {
    if (!this.isReady()) {
      throw new Error('KeywordIndex not initialized. Call initialize() first.');
    }

    // Record the removal BEFORE the early return: this tab may not hold the
    // docId locally while another tab's saved entries still contain it.
    this.pendingOps.set(docId, 'remove');

    const chunkIds = this.docIdToChunks.get(docId);
    if (!chunkIds || chunkIds.size === 0) {
      return;
    }

    for (const id of chunkIds) {
      // Remove from FlexSearch index
      this.index!.remove(id);
      // Remove from mapping
      this.idMapping.delete(id);
    }

    // Remove document from reverse mapping
    this.docIdToChunks.delete(docId);

    console.info(`[KeywordIndex] Removed ${chunkIds.size} chunks for docId: ${docId}`);
  }

  /**
   * D7 (issue #83): direct chunk lookup by predicate — the pinned-slide
   * resolver needs the indexed chunk for a specific slide id (matched on the
   * `slide-<n>-<slideId>.json` source filename), which full-text search cannot
   * answer. Additive read-only accessor over `idMapping`; preserves insertion
   * order and stops at `limit` (default 10).
   *
   * The returned `score` is a PLACEHOLDER (always 1) present only so results
   * satisfy the SearchResult shape — never consume it as a relevance signal;
   * results are NOT ranked. Iteration is O(index size) per call.
   */
  findChunks(
    predicate: (meta: { docId: string; chunkIndex: number; text: string; source?: string; page?: number; packId?: string; packVersion?: string }) => boolean,
    limit = 10
  ): SearchResult[] {
    const results: SearchResult[] = [];
    for (const meta of this.idMapping.values()) {
      if (!predicate(meta)) continue;
      results.push({
        docId: meta.docId,
        chunkIndex: meta.chunkIndex,
        score: 1,
        text: meta.text,
        source: meta.source,
        page: meta.page,
        ...(meta.packId !== undefined ? { packId: meta.packId } : {}),
        ...(meta.packVersion !== undefined ? { packVersion: meta.packVersion } : {}),
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  /**
   * Persist the index to IndexedDB.
   */
  async save(): Promise<void> {
    if (!this.isReady()) {
      throw new Error('KeywordIndex not initialized. Call initialize() first.');
    }

    if (this.pendingOps.size === 0) {
      // Nothing of ours to persist; the baseline (possibly another tab's
      // newer state) stays untouched.
      return;
    }

    try {
      await withStoreLock(`${DB_NAME}-save`, async () => {
        // #270: snapshot the log, then merge from a FRESHLY READ persisted
        // baseline. A whole-blob replace from this tab's in-memory state
        // would wipe entries another tab saved since our last load; the
        // merge keeps them. A local put REPLACES the baseline doc's entries
        // (drop the docId from the baseline, then apply ours).
        const snapshot = new Map(this.pendingOps);
        const baseline = await this.loadFromIDB();
        const merged: IndexEntry[] = (baseline?.entries ?? []).filter(
          (e) => !snapshot.has(e.docId)
        );
        for (const [docId, op] of snapshot) {
          if (op !== 'put') continue;
          for (const [id, meta] of this.idMapping) {
            if (meta.docId !== docId) continue;
            merged.push({
              id,
              docId: meta.docId,
              chunkIndex: meta.chunkIndex,
              text: meta.text,
              source: meta.source,
              page: meta.page,
              ...(meta.packId !== undefined ? { packId: meta.packId } : {}),
              ...(meta.packVersion !== undefined ? { packVersion: meta.packVersion } : {}),
            });
          }
        }
        // documentChunks is DERIVED from the merged entries (PC-11): entries
        // carry the text/citation payload the chunk-id map alone cannot
        // rebuild.
        const documentChunks = new Map<string, Set<string>>();
        for (const e of merged) {
          let ids = documentChunks.get(e.docId);
          if (!ids) {
            ids = new Set<string>();
            documentChunks.set(e.docId, ids);
          }
          ids.add(e.id);
        }
        await this.persistToIDB({ entries: merged, documentChunks });
        // Clear only the ops snapshotted at save start; mutations made while
        // the async merge was in flight survive for the next save.
        for (const docId of snapshot.keys()) {
          this.pendingOps.delete(docId);
        }
        console.info(`[KeywordIndex] Saved ${merged.length} entries to IndexedDB`);
      });
      postChange();
    } catch (error) {
      throw new Error(
        `Save failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Persist data to IndexedDB using raw API.
   */
  private async persistToIDB(data: StoredData): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error}`));
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        // Convert Map to serializable object
        const docIdToChunksObj: Record<string, string[]> = {};
        for (const [docId, ids] of data.documentChunks) {
          docIdToChunksObj[docId] = Array.from(ids);
        }

        store.put({ key: 'data', entries: data.entries, documentChunks: docIdToChunksObj });

        tx.oncomplete = () => {
          db.close();
          resolve();
        };

        // C16: preserve the raw error identity (e.g. QuotaExceededError) as
        // cause, and never leave the save promise pending on abort.
        tx.onabort = () => {
          db.close();
          reject(new Error('Transaction aborted', { cause: tx.error ?? undefined }));
        };

        tx.onerror = () => {
          db.close();
          reject(new Error(`Transaction failed: ${tx.error}`, { cause: tx.error }));
        };
      };
    });
  }

  /**
   * Load the index from IndexedDB.
   *
   * @returns true if saved data was loaded, false otherwise
   */
  async load(): Promise<boolean> {
    if (this.index === null) {
      throw new Error('KeywordIndex not initialized');
    }

    try {
      const data = await this.loadFromIDB();

      if (!data) {
        console.info('[KeywordIndex] No saved index found in IndexedDB');
        return false;
      }

      // Clear existing mappings before repopulating to avoid corruption
      this.idMapping.clear();
      for (const entry of data.entries) {
        this.idMapping.set(entry.id, {
          docId: entry.docId,
          chunkIndex: entry.chunkIndex,
          text: entry.text,
          source: entry.source,
          page: entry.page,
          ...(entry.packId !== undefined ? { packId: entry.packId } : {}),
          ...(entry.packVersion !== undefined ? { packVersion: entry.packVersion } : {}),
        });
      }

      // Restore docIdToChunks reverse mapping
      this.docIdToChunks.clear();
      for (const [docId, ids] of Object.entries(data.documentChunks)) {
        this.docIdToChunks.set(docId, new Set(ids as string[]));
      }

      // Re-add all entries to FlexSearch index
      for (const entry of data.entries) {
        this.index!.add(entry.id, entry.text);
      }

      console.info(`[KeywordIndex] Loaded ${this.size()} entries from IndexedDB`);
      return true;
    } catch (error) {
      console.error('[KeywordIndex] Load failed:', error);
      return false;
    }
  }

  /**
   * Load data from IndexedDB.
   */
  private async loadFromIDB(): Promise<StoredData | null> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error}`));
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.close();
          resolve(null);
          return;
        }

        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const getRequest = store.get('data');

        getRequest.onsuccess = () => {
          const result = getRequest.result;
          db.close();

          if (!result) {
            resolve(null);
            return;
          }

          // Convert serializable object back to Map
          const documentChunks = new Map<string, Set<string>>();
          for (const [docId, ids] of Object.entries(result.documentChunks as Record<string, string[]>)) {
            documentChunks.set(docId, new Set(ids));
          }

          resolve({
            entries: result.entries,
            documentChunks,
          });
        };

        getRequest.onerror = () => {
          db.close();
          reject(new Error(`Failed to load data: ${getRequest.error}`));
        };
      };
    });
  }

  /**
   * Get the number of indexed documents.
   */
  size(): number {
    return this.idMapping.size;
  }

  /**
   * Dispose of the index and release resources.
   */
  dispose(): void {
    this.disposed = true;
    this.index = null;
    this.idMapping.clear();
    this.docIdToChunks.clear();
    this.ready = false;
    this.initPromise = null;
    KeywordIndex.instance = null;
  }

  /**
   * Generate a unique chunk ID for FlexSearch document identification.
   */
  private makeChunkId(docId: string, chunkIndex: number): string {
    return `${docId}:${chunkIndex}`;
  }
}

/**
 * Convenience function to get the KeywordIndex instance.
 */
export function getKeywordIndex(): KeywordIndex {
  return KeywordIndex.getInstance();
}
