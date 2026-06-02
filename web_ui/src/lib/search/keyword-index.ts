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

const DB_NAME = 'doc-qa-keywords';
const DB_VERSION = 1;
const STORE_NAME = 'keyword-index';

interface IndexEntry {
  id: string;
  docId: string;
  chunkIndex: number;
  text: string;
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
  private idMapping: Map<string, { docId: string; chunkIndex: number; text: string }> = new Map();
  // Reverse mapping: docId -> Set of chunk indices
  private docIdToChunks: Map<string, Set<string>> = new Map();

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
      // Using tokenize: "full" for better phrase matching
      this.index = new Index({
        tokenize: 'full',
        worker: false, // Disable worker for simpler IndexedDB serialization
        resolution: 9,
      });

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
   */
  addDocument(docId: string, chunkIndex: number, text: string): void {
    if (!this.isReady()) {
      throw new Error('KeywordIndex not initialized. Call initialize() first.');
    }

    if (!text || typeof text !== 'string') {
      throw new Error('Text must be a non-empty string');
    }

    const id = this.makeChunkId(docId, chunkIndex);

    // Store metadata for retrieval
    this.idMapping.set(id, { docId, chunkIndex, text });

    // Update reverse mapping
    if (!this.docIdToChunks.has(docId)) {
      this.docIdToChunks.set(docId, new Set());
    }
    this.docIdToChunks.get(docId)!.add(id);

    // Add to FlexSearch index
    this.index!.add(id, text);
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
      this.addDocument(chunk.docId, chunk.chunkIndex, chunk.text);
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
      // Search FlexSearch index - returns array of document IDs
      const results = this.index!.search(query, { limit, suggest: true });

      return results.map((id: string | number, rank: number) => {
        const meta = this.idMapping.get(String(id));
        return {
          docId: meta?.docId ?? 'unknown',
          chunkIndex: meta?.chunkIndex ?? 0,
          score: 1 / (rank + 1), // Position-based scoring: higher rank = higher score
          text: meta?.text,
        };
      });
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
   * Persist the index to IndexedDB.
   */
  async save(): Promise<void> {
    if (!this.isReady()) {
      throw new Error('KeywordIndex not initialized. Call initialize() first.');
    }

    try {
      const entries: IndexEntry[] = [];
      for (const [id, meta] of this.idMapping) {
        entries.push({
          id,
          docId: meta.docId,
          chunkIndex: meta.chunkIndex,
          text: meta.text,
        });
      }

      const data: StoredData = {
        entries,
        documentChunks: this.docIdToChunks,
      };

      await this.persistToIDB(data);
      console.info(`[KeywordIndex] Saved ${this.size()} entries to IndexedDB`);
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

        tx.onerror = () => {
          db.close();
          reject(new Error(`Transaction failed: ${tx.error}`));
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
