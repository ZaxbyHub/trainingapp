/**
 * Resolution-based Keyword Index using FlexSearch with IndexedDB persistence.
 * Provides high-performance browser keyword search using FlexSearch's built-in
 * resolution-based scoring algorithm (not BM25). No stop-word filtering or
 * stemming is configured.
 * Designed for offline-first browser usage on 12th-gen i5 / 16GB RAM.
 */

import { Index } from 'flexsearch';
import { normalizeForSearch } from './normalize';
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
 * Change announcements (#270): successful saves notify other tabs, and this
 * store SUBSCRIBES too — a remote save rebuilds this tab's live serving
 * state (FlexSearch/idMapping/docIdToChunks) from the persisted corpus
 * whenever this tab has no unsaved local ops (a rebuild would otherwise wipe
 * the metadata those ops live in; the next save merges them anyway).
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
   * U2 (#275): per-docId op sequence — a monotone counter bumped at every
   * `pendingOps.set` site, so the post-save clear can tell a re-set op (the
   * same docId put again while the async merge was in flight, where value
   * comparison cannot — a re-put writes the same 'put' string) from an
   * untouched snapshot op and keep the re-set op pending for the next save.
   */
  private pendingOpsSeq: Map<string, number> = new Map();
  /** U2: monotone source for pendingOpsSeq values. */
  private pendingOpsCounter = 0;

  /** U2: bump the per-doc op sequence (called beside every pendingOps.set). */
  private bumpOpSeq(docId: string): void {
    this.pendingOpsCounter += 1;
    this.pendingOpsSeq.set(docId, this.pendingOpsCounter);
  }
  /** Remote-refresh serialization state (PRR-004): exactly one load runs at a
   * time; a burst queues ONE trailing run instead of racing concurrent loads
   * (whichever finished last would win the swap — a stale overwrite). */
  private refreshRunning = false;
  private refreshQueued = false;
  /** Unsubscribe for the remote-change refresh (PRR-004); nulled on dispose. */
  private channelUnsub: (() => void) | null = null;

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
  /** Fresh FlexSearch index with the canonical config (shared by init and
   * the PRR-004 refresh rebuild — a refresh must never leave stale chunks
   * searchable in the old index). */
  private createFlexIndex(): InstanceType<typeof Index> {
    // Using tokenize: "full" for better phrase matching. `worker: false` is a
    // valid runtime option (keeps the index serializable for IndexedDB) but is
    // not in the v0.8 IndexOptions type — cast to preserve behavior.
    return new Index({
      tokenize: 'full',
      worker: false,
      resolution: 9,
    } as ConstructorParameters<typeof Index>[0]);
  }

  /** Fold a full entry set into the LIVE serving state (PRR-004). */
  private rebuildFromEntries(entries: IndexEntry[]): void {
    const index = this.createFlexIndex();
    this.idMapping.clear();
    this.docIdToChunks.clear();
    for (const entry of entries) {
      this.idMapping.set(entry.id, {
        docId: entry.docId,
        chunkIndex: entry.chunkIndex,
        text: entry.text,
        source: entry.source,
        page: entry.page,
        ...(entry.packId !== undefined ? { packId: entry.packId } : {}),
        ...(entry.packVersion !== undefined ? { packVersion: entry.packVersion } : {}),
      });
      let ids = this.docIdToChunks.get(entry.docId);
      if (ids === undefined) {
        ids = new Set<string>();
        this.docIdToChunks.set(entry.docId, ids);
      }
      ids.add(entry.id);
      index.add(entry.id, normalizeForSearch(entry.text));
    }
    this.index = index;
  }

  /** Serialized remote refresh (PRR-004). */
  private scheduleRefresh(): void {
    if (this.refreshRunning) {
      this.refreshQueued = true;
      return;
    }
    this.refreshRunning = true;
    void this.load()
      .catch((error: unknown) => console.warn('[KeywordIndex] remote refresh failed:', error))
      .finally(() => {
        this.refreshRunning = false;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          if (!this.disposed && this.pendingOps.size === 0) this.scheduleRefresh();
        }
      });
  }

  private async doInitialize(): Promise<void> {
    try {
      this.index = this.createFlexIndex();

      // Try to load persisted index from IndexedDB
      const loaded = await this.load();
      if (loaded) {
        console.info(`[KeywordIndex] Loaded ${this.size()} entries from IndexedDB`);
      }

      this.ready = true;
      // PRR-004: rebuild the live serving state on other tabs' saves — only
      // when this tab has no unsaved local ops (a rebuild replaces the
      // mapping their metadata lives in; the next save merges them anyway).
      this.channelUnsub = changeChannel.onRemoteChange(() => {
        if (this.disposed || this.pendingOps.size > 0) return;
        this.scheduleRefresh();
      });
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
    this.index!.add(id, normalizeForSearch(text));

    this.pendingOps.set(docId, 'put');
    this.bumpOpSeq(docId);
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
      const results = this.index!.search(normalizeForSearch(query), { limit, suggest: true }) as Array<string | number>;

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
    this.bumpOpSeq(docId);

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
        // U2: per-doc op sequences at snapshot time (see the clear below).
        const snapshotSeq = new Map(this.pendingOpsSeq);
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
        // the async merge was in flight survive for the next save. U2: the
        // clear is SEQUENCE-CONDITIONAL — a snapshot docId whose op was
        // re-set during the merge (its live sequence moved past the
        // snapshot's) stays pending, and the stillPending rebuild below then
        // serves its CURRENT in-memory entries as designed.
        for (const docId of snapshot.keys()) {
          if ((this.pendingOpsSeq.get(docId) ?? 0) === (snapshotSeq.get(docId) ?? 0)) {
            this.pendingOps.delete(docId);
            // PR #285 review (PRR-014): prune the dead sequence entry (see
            // the vector-index twin).
            this.pendingOpsSeq.delete(docId);
          }
        }
        // PRR-004 (handoff 4(a), the saving-tab asymmetry): the merge result
        // is now the persisted truth and this tab's own announcement is
        // self-filtered — fold `merged` into the LIVE serving state here, or
        // the tab that saves last keeps serving its pre-merge view (missing
        // baseline entries it never loaded; a peer's earlier announcement was
        // skipped while local ops were pending). Ops that arrived while the
        // merge ran are still pending: serve their CURRENT in-memory entries
        // instead of their (possibly stale) baseline copies.
        const stillPending = new Set(this.pendingOps.keys());
        const pendingEntries: IndexEntry[] = [];
        for (const [id, meta] of this.idMapping) {
          if (!stillPending.has(meta.docId)) continue;
          pendingEntries.push({
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
        this.rebuildFromEntries([
          ...merged.filter((e) => !stillPending.has(e.docId)),
          ...pendingEntries,
        ]);
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

      // PRR-004: a refresh must not wipe metadata of unsaved local ops that
      // arrived while loadFromIDB was awaiting — skip; the next save merges.
      if (this.pendingOps.size > 0) {
        console.info('[KeywordIndex] load/refresh skipped: unsaved local ops present');
        return false;
      }
      // Rebuild the live serving state from the persisted entries (fresh
      // FlexSearch index + both mappings) — no stale chunk can survive.
      this.rebuildFromEntries(data.entries);

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
    this.channelUnsub?.();
    this.channelUnsub = null;
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
