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
import { withStoreLock } from '../storage/cross-tab';
import { createStoreChannel } from '../storage/cross-tab-channel';
import { REINDEX_FLAG_KEY } from '../storage/persisted-keys';

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
 * Change announcements (#270): successful saves notify other tabs, and this
 * store SUBSCRIBES too — a remote save refreshes this tab's live
 * mapping/snapshot state from the persisted corpus whenever this tab has no
 * unsaved local ops (a refresh would otherwise wipe the metadata those ops
 * live in; the next save merges them anyway). Merge correctness never
 * depends on delivery - every merge-save re-reads the persisted baseline
 * under the store lock.
 */
const changeChannel = createStoreChannel(`${DB_NAME}-changes`);

function postChange(): void {
  changeChannel.postChange();
}

/** Free an EdgeVec instance via Symbol.dispose or free() (PRR-012). */
function disposeEdgeVec(instance: EdgeVec): void {
  if (typeof instance[Symbol.dispose] === 'function') {
    instance[Symbol.dispose]();
  } else if (typeof instance.free === 'function') {
    instance.free();
  }
}

/** Mapping-row metadata shape shared by the merge helpers below. */
interface VectorMappingMeta {
  docId: string;
  chunkIndex: number;
  text?: string;
  source?: string;
  page?: number;
  packId?: string;
  packVersion?: string;
}

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
  private idMapping: Map<number, VectorMappingMeta> = new Map();
  private disposed: boolean = false;
  /** Unsubscribe for the remote-change refresh (PRR-004); nulled on dispose. */
  private channelUnsub: (() => void) | null = null;
  /**
   * #270: this tab's own mutations since the last successful save - `put`
   * for docIds whose vectors were (re-)added, `remove` for docIds removed.
   * save() merges from the freshly read persisted baseline instead of
   * replacing the whole snapshot blob from in-memory state.
   */
  private pendingOps: Map<string, 'put' | 'remove'> = new Map();
  /**
   * U1 (#275): per-docId op sequence — a monotone counter is bumped at every
   * `pendingOps.set` site, so the save path can tell a re-set op (the same
   * docId put AGAIN after the snapshot was taken, e.g. a same-doc re-put
   * landing inside the merge window) from an untouched snapshot op, where
   * value comparison cannot (a re-put writes the same 'put' string).
   */
  private pendingOpsSeq: Map<string, number> = new Map();
  /** U1: monotone source for pendingOpsSeq values. */
  private pendingOpsCounter = 0;

  /** U1: bump the per-doc op sequence (called beside every pendingOps.set). */
  private bumpOpSeq(docId: string): void {
    this.pendingOpsCounter += 1;
    this.pendingOpsSeq.set(docId, this.pendingOpsCounter);
  }
  /**
   * Raw vectors for entries not yet persisted (cleared after each successful
   * save). The snapshot-rebuild merge needs the raw floats to re-insert them
   * into the freshly loaded baseline instance; EdgeVec exposes no vector
   * export. Disclosed memory cost: about 3KB per unsaved 768-dim vector.
   */
  private vectorsById: Map<number, Float32Array> = new Map();
  /** Remote-refresh serialization state (PRR-004): see KeywordIndex's twin. */
  private refreshRunning = false;
  private refreshQueued = false;

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
  /**
   * Build a fresh EdgeVec instance with this index's configuration. Shared by
   * doInitialize and the merge-save baseline loader (PC-10: a missing or
   * version-mismatched snapshot merges into a freshly constructed index, not
   * a failed save).
   */
  private async createEdgeVec(): Promise<EdgeVec> {
    // Initialize EdgeVec WASM module - MUST be called before using EdgeVec
    await initWasm();

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
    const index = new EdgeVec(config);
    config.free();
    return index;
  }

  private async doInitialize(): Promise<void> {
    try {
      this.index = await this.createEdgeVec();

      // Try to load persisted index from IndexedDB using native EdgeVec.load
      const loaded = await this.load();
      if (loaded) {
        console.info(`[VectorIndex] Loaded ${this.size()} vectors from IndexedDB`);
      }

      this.ready = true;
      // PRR-004: refresh the live state on other tabs' saves — only when
      // this tab has no unsaved local ops (a refresh replaces the mapping
      // their metadata lives in; the next save merges them anyway).
      this.channelUnsub = changeChannel.onRemoteChange(() => {
        if (this.disposed || this.pendingOps.size > 0) return;
        this.scheduleRefresh();
      });
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
    meta?: { text?: string; source?: string; page?: number; packId?: string; packVersion?: string }
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
        ...(meta?.packId !== undefined ? { packId: meta.packId } : {}),
        ...(meta?.packVersion !== undefined ? { packVersion: meta.packVersion } : {}),
      });
      this.vectorsById.set(internalId, vector as Float32Array);
      this.pendingOps.set(docId, 'put');
      this.bumpOpSeq(docId);
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
          ...(entry.packId !== undefined ? { packId: entry.packId } : {}),
          ...(entry.packVersion !== undefined ? { packVersion: entry.packVersion } : {}),
        });
        // #270: retain the raw float vector until the next successful save;
        // the snapshot-rebuild merge re-inserts unsaved vectors into the
        // freshly loaded baseline instance.
        this.vectorsById.set(internalId, vectors[j]);
        this.pendingOps.set(entry.docId!, 'put');
        this.bumpOpSeq(entry.docId!);
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
          ...(metadata.packId !== undefined ? { packId: metadata.packId } : {}),
          ...(metadata.packVersion !== undefined ? { packVersion: metadata.packVersion } : {}),
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

    // Record the removal BEFORE any early return: this tab may not hold the
    // docId locally while another tab's saved entries still contain it.
    this.pendingOps.set(docId, 'remove');
    this.bumpOpSeq(docId);
    try {
      // Find all internal IDs associated with this document
      const toRemove: number[] = [];
      for (const [internalId, metadata] of this.idMapping) {
        if (metadata.docId === docId) {
          toRemove.push(internalId);
        }
      }

      // Soft-delete from EdgeVec index using softDelete. PR #285 review
      // (PRR-006): a live-map id can transiently resolve to a vector only in
      // the disposed pre-swap instance (a put that landed inside a save's
      // merge window), and EdgeVec's softDelete REJECTS unknown ids
      // (edgevec.d.ts: "Returns an error if the vector ID doesn't exist").
      // Tolerate per id - warn and drop the stale entry - so one
      // unresolvable id cannot abort the whole purge (the pack paths swallow
      // purge failures via .catch(() => undefined), which would leave silent
      // reload-persistent ghost entries) and later ids in the loop still get
      // removed.
      for (const internalId of toRemove) {
        try {
          this.index!.softDelete(internalId);
        } catch (softDeleteError) {
          console.warn(
            `[VectorIndex] softDelete of internal id ${internalId} failed during remove of ${docId}; dropping the stale mapping entry.`,
            softDeleteError
          );
        }
        this.idMapping.delete(internalId);
        // PRR-011: a removed id can never re-enter idMapping, so its
        // retained raw vector can never be re-inserted — release it or the
        // map grows without bound across delete/re-embed cycles.
        this.vectorsById.delete(internalId);
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

    if (this.pendingOps.size === 0) {
      // Nothing of ours to persist; the baseline (possibly another tab's
      // newer state) stays untouched.
      return;
    }

    try {
      await withStoreLock(`${DB_NAME}-save`, async () => {
        // #270 snapshot-rebuild merge. EdgeVec exposes no vector export, so a
        // merge loads the FRESH persisted baseline as a second instance and
        // re-inserts this tab's unsaved raw vectors into it. Steps:
        //  1. version-aware baseline load (missing snapshot or version
        //     mismatch => a freshly constructed empty instance + empty
        //     mapping - PC-10; a mapping row without a snapshot cannot be
        //     retained, AC3's every-id-resolves invariant);
        //  2. baseline entries of replaced/removed docIds are dropped AND
        //     their vectors soft-deleted so they cannot crowd the search
        //     k-window (PC-12, the existing removeByDocId invariant);
        //  3. put docIds' in-memory entries are carried over when the
        //     baseline holds the same internal id AND docId (saved by this
        //     tab), else re-inserted from the retained raw vector with a
        //     REMAPPED id (per-tab internal id spaces can collide - PC-2);
        //  4. mapping+version written BEFORE the snapshot (the F11 order),
        //     and the live instance swaps only after BOTH writes succeed;
        //  5. only the ops/vectors snapshotted at save start are cleared,
        //     so mutations during the async merge survive (PC-2).
        const snapshot = new Map(this.pendingOps);
        const dropDocIds = new Set(snapshot.keys());
        // U1: per-doc op sequences AT SNAPSHOT TIME. A docId whose live
        // sequence is HIGHER at the overlay/clear points re-set its op after
        // the snapshot (a same-doc re-put landing inside the merge window).
        const snapshotSeq = new Map(this.pendingOpsSeq);

        const persistedVersion = await this.readPersistedVersion();
        let temp: EdgeVec;
        let baselineMappingEntries: Array<[number, VectorMappingMeta]> = [];
        if (persistedVersion === VECTOR_INDEX_VERSION) {
          let snapshotLoaded = false;
          try {
            temp = await EdgeVec.load(INDEX_NAME);
            snapshotLoaded = true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/not found/i.test(message)) {
              // First-ever ingest (or snapshot lost): a mapping row without a
              // snapshot is not retained - baseline is a fresh empty index.
              temp = await this.createEdgeVec();
            } else {
              // Load failed: temp was never assigned — nothing leaks.
              throw error;
            }
          }
          if (snapshotLoaded) {
            try {
              baselineMappingEntries = await this.readMappingEntries();
            } catch (readError) {
              // PRR-012: the snapshot instance exists on this path — a
              // rejected mapping read must not leak it.
              disposeEdgeVec(temp);
              throw readError;
            }
          } else {
            baselineMappingEntries = [];
          }
        } else {
          // Version mismatch or absent: consistent with load()'s discard
          // discipline - merge into an empty baseline.
          temp = await this.createEdgeVec();
          baselineMappingEntries = [] as Array<[number, VectorMappingMeta]>;
        }

        // IR-12 (op-aware keep/drop): a baseline entry of a snapshot docId
        // survives ONLY when its internal id STILL RESOLVES in this.idMapping
        // to the same docId (removeByDocId deletes those entries, so a remove
        // op keeps nothing) AND its (docId, chunkIndex) is not superseded by
        // an entry with a RETAINED raw vector (a new put of the same chunk
        // replaces it; the stale vector soft-deletes so it cannot crowd the
        // search k-window, PC-12). Everything else — removed docs, superseded
        // chunks — soft-deletes. A surviving baseline entry keeps its vector
        // LIVE (never soft-deleted), which is what keeps boot-loaded chunks
        // resolvable across an incremental re-put (IR-1).
        // IR-1: supersession is per (docId, chunkIndex). A baseline chunk of a
        // put docId whose chunkIndex the in-memory state re-supplies is
        // REPLACED (soft-deleted, new vector inserted); a baseline chunk whose
        // chunkIndex is absent from the in-memory state is carried forward
        // LIVE (its vector must never be soft-deleted, or the carried mapping
        // id would dangle) — this is what makes a same-tab incremental re-put
        // correct for boot-loaded entries that carry no retained raw vector.
        const superseded = new Set<string>();
        for (const [docId, op] of snapshot) {
          if (op !== 'put') continue;
          for (const [internalId, meta] of this.idMapping) {
            if (meta.docId !== docId) continue;
            // Only entries with a RETAINED raw vector are new puts of this
            // save; boot-loaded copies of the same chunks (no retained
            // vector) must not mark their own chunkIndexes superseded.
            if (this.vectorsById.has(internalId)) {
              superseded.add(`${docId}:${meta.chunkIndex}`);
            }
          }
        }

        const newMapping = new Map<number, VectorMappingMeta>();
        for (const [id, meta] of baselineMappingEntries) {
          if (!dropDocIds.has(meta.docId)) {
            newMapping.set(id, meta);
            continue;
          }
          const inMemory = this.idMapping.get(id);
          if (
            inMemory &&
            inMemory.docId === meta.docId &&
            !superseded.has(`${meta.docId}:${inMemory.chunkIndex}`)
          ) {
            // Still-owned, non-superseded saved chunk: keep live.
            newMapping.set(id, meta);
          } else {
            // Removed doc, or superseded chunk: soft-delete so the stale
            // vector cannot crowd the search k-window (PC-12).
            try {
              temp.softDelete(id);
            } catch (sdError) {
              // PRR-012: a mid-merge throw must not leak the baseline copy.
              disposeEdgeVec(temp);
              throw sdError;
            }
          }
        }

        const insertedOriginalIds: number[] = [];
        const toInsert: Array<{ vector: Float32Array; meta: VectorMappingMeta }> = [];
        for (const [docId, op] of snapshot) {
          if (op !== 'put') continue;
          for (const [internalId, meta] of this.idMapping) {
            if (meta.docId !== docId) continue;
            const carried = newMapping.get(internalId);
            if (carried !== undefined && carried.docId === meta.docId) {
              // OUR OWN entry already carried from the baseline (same id AND
              // docId): its vector is live in temp — nothing to insert.
              continue;
            }
            // PRR-002: any OTHER occupant of this id (a different doc's
            // baseline entry — the aligned-counter two-tab collision) must
            // NOT suppress our insert: fall through and re-insert with a
            // REMAPPED id, per the contract comment above this function.
            if (this.vectorsById.has(internalId) && this.vectorsById.get(internalId) !== undefined) {
              toInsert.push({ vector: this.vectorsById.get(internalId) as Float32Array, meta });
              insertedOriginalIds.push(internalId);
            } else {
              // No raw vector and no baseline carrier (defensive): skip rather
              // than write a mapping entry whose vector cannot resolve (AC3).
              console.warn(
                `[VectorIndex] Skipping mapping entry without a resolvable vector for docId ${meta.docId}`
             );
            }
          }
        }

        if (toInsert.length > 0) {
          let result: ReturnType<EdgeVec['insertBatchWithProgress']>;
          try {
            result = temp.insertBatchWithProgress(
              toInsert.map((e) => e.vector),
              () => {
                /* progress not surfaced through the merge path */
              }
            );
          } catch (insertError) {
            // PRR-012: a mid-merge throw must not leak the baseline copy.
            disposeEdgeVec(temp);
            throw insertError;
          }
          for (let j = 0; j < result.inserted; j++) {
            newMapping.set(Number(result.ids[j]), toInsert[j].meta);
          }
          result.free();
        }

        // F11 order preserved: mapping+version FIRST, then the snapshot. If
        // the snapshot write fails after the mapping row landed, restore the
        // in-memory mapping so the live instance stays consistent with the
        // still-persisted previous snapshot (IR-5).
        //
        // U1 (#275): COPY-FIRST persisted row. `persistedMapping` is an
        // immutable copy of exactly what this save writes, taken BEFORE the
        // swap (post-swap, `newMapping` IS the live map; an overlay applied
        // to it before the write would be persisted WITHOUT its vector — the
        // mapping-without-vector failure mode). The overlay below writes the
        // LIVE map only. `saveMapping()`'s default argument is `this.idMapping`,
        // so the write below passes the copy explicitly.
        const persistedMapping = new Map(newMapping);
        const previousMapping = this.idMapping;
        this.idMapping = newMapping;
        // U1: overlay — swap and reconcile in ONE synchronous block (no await
        // between them, so no put can interleave between overlay and swap).
        // Every entry of the PRE-swap live map that is not already carried in
        // the new map is a mutation registered after this save's merge loop
        // read it (a blind delta):
        //   - `!newMapping.has(id)` — not carried/inserted this save;
        //   - `this.vectorsById.has(id)` — this exact entry has an un-persisted
        //     raw vector, the marker of a not-yet-persisted put (boot-loaded
        //     and superseded entries have none, so stale entries are
        //     structurally excluded and cannot be resurrected);
        //   - the doc still has a live op, re-set after the snapshot (U1 seq:
        //     the docId is new since the snapshot, or its sequence moved) —
        //     covers new-doc puts, remove→put re-puts (whose `toInsert`
        //     discovery skipped the post-snapshot re-put), and put→put
        //     re-puts that land during the merge.
        // The overlay writes ONLY the live map; `persistedMapping` stays
        // snapshot-consistent — no mapping entry is persisted without its
        // vector in this save's snapshot (no dangling ids).
        for (const [id, meta] of previousMapping) {
          if (
            !newMapping.has(id) &&
            // Excludes ids ALREADY inserted this save under remapped ids: a
            // mid-window re-put of a snapshot doc is consumed by the
            // discovery loop (its vector lands in the merged snapshot under
            // a NEW id), so overlaying the original live id here would leave
            // a live-mapping entry whose vector only exists in the disposed
            // pre-swap instance (and a later removeByDocId softDelete on
            // that id throws). The live map must only hold ids that resolve
            // in the live index.
            !insertedOriginalIds.includes(id) &&
            this.vectorsById.has(id) &&
            this.pendingOps.has(meta.docId) &&
            (!snapshot.has(meta.docId) ||
              (this.pendingOpsSeq.get(meta.docId) ?? 0) > (snapshotSeq.get(meta.docId) ?? 0))
          ) {
            newMapping.set(id, meta);
          }
        }
        try {
          await this.saveMapping(persistedMapping);
          await temp.save(INDEX_NAME);
        } catch (writeError) {
          // IR-18: a failed merge-save must not leak the WASM baseline
          // instance (the live index keeps its own instance).
          //
          // U1 rollback: entries that registered into the live map during the
          // two write awaits must survive the restore. Capture the map that
          // was live DURING the awaits BEFORE restoring (post-swap that
          // reference is `newMapping`; the explicit capture names the intent
          // and keeps the loop honest), restore, then re-apply the SAME
          // overlay predicate with the absence test against the RESTORED
          // destination (`!previousMapping.has(id)`), retaining the raw-vector
          // and sequence guards.
          const liveDuringWrites = this.idMapping;
          this.idMapping = previousMapping;
          for (const [id, meta] of liveDuringWrites) {
            if (
              !previousMapping.has(id) &&
              this.vectorsById.has(id) &&
              this.pendingOps.has(meta.docId) &&
              (!snapshot.has(meta.docId) ||
                (this.pendingOpsSeq.get(meta.docId) ?? 0) > (snapshotSeq.get(meta.docId) ?? 0))
            ) {
              previousMapping.set(id, meta);
            }
          }
          // PRR-007: the MERGED mapping row may already be committed on disk
          // (F11 writes mapping before snapshot) — rewrite it to the
          // SNAPSHOT-PAIRED BASELINE (the row read before this save, which is
          // exactly what the still-persisted snapshot represents) so the
          // persisted pair never stays ahead of the snapshot. The in-memory
          // restore above keeps this tab's live truth, which includes the
          // not-yet-persisted inserts; those re-enter through the next save.
          try {
            await this.saveMapping(new Map(baselineMappingEntries));
          } catch {
            // Best-effort: if this also fails, the mapping write itself was
            // the original failure and the row never advanced.
          }
          disposeEdgeVec(temp);
          throw writeError;
        }

        // Swap only after both writes succeeded; dispose the old live
        // instance (same disposal pattern as load()).
        if (this.index) {
          if (typeof this.index[Symbol.dispose] === 'function') {
            this.index[Symbol.dispose]();
          } else if (typeof this.index.free === 'function') {
            this.index.free();
          }
        }
        this.index = temp;

        // Clear only the snapshotted ops/vectors; mutations made during the
        // async merge survive for the next save. U1: the clear is now
        // SEQUENCE-CONDITIONAL — a snapshot docId whose op was re-set during
        // the window (its live sequence moved past the snapshot's) survives
        // for the next save, which re-inserts its post-snapshot vectors
        // (e.g. the same-doc re-put of an existing snapshot doc).
        for (const docId of snapshot.keys()) {
          if ((this.pendingOpsSeq.get(docId) ?? 0) === (snapshotSeq.get(docId) ?? 0)) {
            this.pendingOps.delete(docId);
            // PR #285 review (PRR-014): the op is gone, so its sequence
            // entry is dead weight — prune it or the seq map grows by one
            // entry per docId ever touched, for the instance's lifetime.
            this.pendingOpsSeq.delete(docId);
          }
        }
        for (const internalId of insertedOriginalIds) {
          this.vectorsById.delete(internalId);
        }
        console.info(
          `[VectorIndex] Saved ${newMapping.size} vectors to IndexedDB (merged ${snapshot.size} local ops)`
        );
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
   * Read the persisted mapping rows WITHOUT mutating the in-memory mapping
   * (the merge baseline read; load() keeps its own repopulating path).
   */
  private async readMappingEntries(): Promise<Array<[number, VectorMappingMeta]>> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      // PRR-003: an I/O error is NOT "there is no mapping" — resolving []
      // here made the merge treat an unreadable baseline as an empty corpus
      // and overwrite the persisted state with only this tab's pending ops.
      request.onerror = () =>
        reject(new Error(`Failed to open IndexedDB to read the persisted mapping: ${request.error}`));
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
          resolve([]);
          return;
        }
        const tx = db.transaction('mappings', 'readonly');
        const store = tx.objectStore('mappings');
        const getRequest = store.get('idMapping');
        getRequest.onsuccess = () => {
          const result = getRequest.result;
          db.close();
          if (!result || !Array.isArray(result.data)) {
            resolve([]);
            return;
          }
          const entries: Array<[number, VectorMappingMeta]> = [];
          for (const item of result.data) {
            entries.push([
              item.id,
              {
                docId: item.docId,
                chunkIndex: item.chunkIndex,
                text: item.text,
                source: item.source,
                page: item.page,
                ...(item.packId !== undefined ? { packId: item.packId } : {}),
                ...(item.packVersion !== undefined ? { packVersion: item.packVersion } : {}),
              },
            ]);
          }
          resolve(entries);
        };
        getRequest.onerror = () => {
          db.close();
          reject(new Error(`Failed to read the persisted mapping: ${getRequest.error}`));
        };
      };
    });
  }

  /**
   * Persist idMapping to IndexedDB as JSON blob.
   */
  private async saveMapping(
    mapping: ReadonlyMap<number, VectorMappingMeta> = this.idMapping
  ): Promise<void> {
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

        const mappingArray = Array.from(mapping.entries()).map(([id, meta]) => ({
          id,
          docId: meta.docId,
          chunkIndex: meta.chunkIndex,
          text: meta.text,
          source: meta.source,
          page: meta.page,
          ...(meta.packId !== undefined ? { packId: meta.packId } : {}),
          ...(meta.packVersion !== undefined ? { packVersion: meta.packVersion } : {}),
        }));

        store.put({ key: 'idMapping', data: mappingArray });
        store.put({ key: 'version', version: VECTOR_INDEX_VERSION });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        // C16: preserve the raw error identity (e.g. QuotaExceededError) as
        // cause, and never leave the save promise pending on abort.
        tx.onabort = () => {
          db.close();
          reject(new Error('Failed to save idMapping (aborted)', { cause: tx.error ?? undefined }));
        };
        tx.onerror = () => {
          db.close();
          reject(new Error('Failed to save idMapping', { cause: tx.error }));
        };
      };
    });
  }

  /**
   * Load idMapping from IndexedDB.
   */
  private async loadMapping(): Promise<boolean> {
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, 1);

      request.onerror = () => {
        // PRR-004: never wipe live state (unsaved local ops' metadata lives
        // only here) on a read failure during a refresh.
        if (this.pendingOps.size > 0) {
          resolve(false);
          return;
        }
        // IndexedDB might not exist yet, which is fine
        this.idMapping.clear();
        resolve(true);
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
          if (this.pendingOps.size > 0) {
            resolve(false);
            return;
          }
          this.idMapping.clear();
          resolve(true);
          return;
        }

        const tx = db.transaction('mappings', 'readonly');
        const store = tx.objectStore('mappings');
        const getRequest = store.get('idMapping');

        getRequest.onsuccess = () => {
          const result = getRequest.result;
          // PRR-004: single sync apply — guard immediately before the only
          // mutation, so an unsaved local op interleaved during the awaits
          // cannot be wiped (no await between this check and the writes).
          if (this.pendingOps.size > 0) {
            db.close();
            resolve(false);
            return;
          }
          if (result && result.data) {
            this.idMapping.clear();
            for (const item of result.data) {
              this.idMapping.set(item.id, {
                docId: item.docId,
                chunkIndex: item.chunkIndex,
                text: item.text,
                source: item.source,
                page: item.page,
                ...(item.packId !== undefined ? { packId: item.packId } : {}),
                ...(item.packVersion !== undefined ? { packVersion: item.packVersion } : {}),
              });
            }
          } else {
            this.idMapping.clear();
          }
          db.close();
          resolve(true);
        };

        getRequest.onerror = () => {
          db.close();
          if (this.pendingOps.size > 0) {
            resolve(false);
            return;
          }
          this.idMapping.clear();
          resolve(true);
        };
      };
    });
  }

  /**
   * Read the persisted content version from IndexedDB WITHOUT loading the
   * native EdgeVec blob. Return contract:
   *  - `null`  → there is nothing to check: IndexedDB is unavailable, or the
   *    store is fresh-empty (no version row AND no idMapping row — U6)
   *              (some test contexts) OR the database did not exist before this
   *              call (a brand-new install with no prior corpus). The caller
   *              skips the version check and proceeds with the normal load path.
   *  - `0`     → a mappings store ALREADY EXISTED (pre-upgrade DB) but has no
   *              version key. This is the signature of a pre-v2 index (v1,
   *              mean-pooled) — treated as incompatible and forced through the
   *              re-index path (F9).
   *  - number  → the persisted version (compare to VECTOR_INDEX_VERSION).
   *  - rejects → an IndexedDB I/O error (open/get failed): the save-merge
   *              fails closed on it; load() converts it to "not loaded"
   *              (never to a version decision).
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
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      // Track whether the DB (and thus the mappings store) existed BEFORE this
      // open call. A brand-new DB fires onupgradeneeded with oldVersion 0.
      let createdFresh = false;

      // PRR-003: an I/O error is NOT "there is nothing to check" — the
      // save-merge must fail closed on it rather than merge into what it
      // believes is a fresh empty corpus.
      request.onerror = () =>
        reject(new Error(`Failed to open IndexedDB to read the persisted index version: ${request.error}`));

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
          const v = getReq.result?.version;
          if (typeof v === 'number') {
            db.close();
            resolve(v);
            return;
          }
          // U6 (#268): a MISSING version row is ambiguous — a fresh empty
          // store (nothing ever stored) or a genuine pre-v2 (v1) corpus
          // (idMapping rows exist). Disambiguate by consulting the idMapping
          // row itself: present → pre-v2 corpus (resolve 0 → the mismatch
          // check forces the re-index, exactly as before); absent → fresh
          // empty store (resolve null → load()'s null branch loads without
          // warning or flag, so a fresh install no longer claims the corpus
          // was discarded).
          const mapReq = store.get('idMapping');
          mapReq.onsuccess = () => {
            db.close();
            resolve(mapReq.result ? 0 : null);
          };
          mapReq.onerror = () => {
            db.close();
            reject(new Error(`Failed to read the persisted idMapping row: ${mapReq.error}`));
          };
        };
        getReq.onerror = () => {
          db.close();
          reject(new Error(`Failed to read the persisted index version: ${getReq.error}`));
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
  /** Serialized remote refresh (PRR-004). */
  private scheduleRefresh(): void {
    if (this.refreshRunning) {
      this.refreshQueued = true;
      return;
    }
    this.refreshRunning = true;
    void this.load()
      .catch((error: unknown) => console.warn('[VectorIndex] remote refresh failed:', error))
      .finally(() => {
        this.refreshRunning = false;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          if (!this.disposed && this.pendingOps.size === 0) this.scheduleRefresh();
        }
      });
  }

  async load(): Promise<boolean> {
    if (this.index === null) {
      throw new Error('VectorIndex not initialized');
    }

    // F9: check the persisted content version BEFORE loading the native blob.
    // `null` means nothing is stored to check (no IndexedDB, or a fresh-empty
    // store per U6) — proceed with
    // the normal load path. Any non-null value that isn't VECTOR_INDEX_VERSION —
    // including 0 (a pre-v2/v1 store with no version key, i.e. mean-pooled
    // vectors from a previous build) — is incompatible and MUST be discarded so
    // a CLS-pooling client never loads mean-pooled vectors.
    let persistedVersion: number | null;
    try {
      persistedVersion = await this.readPersistedVersion();
    } catch (error) {
      // A transient read failure must never fabricate a version decision:
      // log and treat the load as "no saved index" (the same outcome the
      // previous resolve-on-error behavior produced), never as a mismatch.
      console.error('[VectorIndex] Failed to read the persisted version; not loading:', error);
      return false;
    }
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
      const mappingApplied = await this.loadMapping();
      if (!mappingApplied) {
        // PRR-004: unsaved local ops arrived during the refresh read — abort
        // the swap so their metadata is not wiped; the next save merges.
        disposeEdgeVec(loadedIndex);
        return false;
      }

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
   * Whether the loaded mapping holds any entry for a document id (#270 AC6
   * vector-side health probe). Mapping rows only survive a successful
   * snapshot load, so a wiped/lost vector store answers false at boot and the
   * pack health pass clears the embedded flag.
   */
  hasDocEntries(docId: string): boolean {
    for (const meta of this.idMapping.values()) {
      if (meta.docId === docId) return true;
    }
    return false;
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
    this.channelUnsub?.();
    this.channelUnsub = null;

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
