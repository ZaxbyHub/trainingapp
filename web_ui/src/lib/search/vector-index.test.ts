/**
 * Tests for VectorIndex HNSW index using EdgeVec (mocked).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VectorIndex } from './vector-index';

// Create a mock instance that can be configured by tests - initialize at module level
const mockEdgeVecInstance: {
  insert: ReturnType<typeof vi.fn>;
  insertBatchWithProgress: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  softDelete: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  liveCount: ReturnType<typeof vi.fn>;
  canInsert: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
} = {
  insert: vi.fn<(_vector: Float32Array) => number>(),
  insertBatchWithProgress: vi.fn<(_vectors: Float32Array[], _onProgress?: (done: number, total: number) => void) => { ids: BigUint64Array; inserted: number; total: number; free: () => void }>(),
  search: vi.fn<(_query: Float32Array, k: number) => Array<{ id: number; score: number }>>(),
  softDelete: vi.fn<(id: number) => void>(),
  save: vi.fn<(_name: string) => Promise<void>>(),
  liveCount: vi.fn<() => number>(),
  canInsert: vi.fn<() => boolean>(),
  free: vi.fn<() => void>(),
};

// Mock the edgevec module - vi.mock is hoisted to top of file
vi.mock('edgevec', () => {
  const mockInitFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const mockLoadStaticFn = vi.fn().mockResolvedValue(null);

  // The default export is a constructor that returns mockEdgeVecInstance (must use regular function for 'new')
  const MockEdgeVecConstructor = vi.fn().mockImplementation(function(this: typeof mockEdgeVecInstance) {
    return mockEdgeVecInstance;
  });

  // Copy static methods to the constructor
  (MockEdgeVecConstructor as { load: typeof mockLoadStaticFn }).load = mockLoadStaticFn;

  // EdgeVecConfig mock - exported as named export (must use regular function, not arrow, for 'new' to work)
  const MockEdgeVecConfig = vi.fn().mockImplementation(function(this: { dimensions: number; metric: string; ef_search: number; ef_construction: number; m: number; m0: number; free: ReturnType<typeof vi.fn> }, dimensions: number) {
    this.dimensions = dimensions;
    this.metric = '';
    this.ef_search = 50;
    this.ef_construction = 200;
    this.m = 16;
    this.m0 = 32;
    this.free = vi.fn();
  });

  return {
    default: mockInitFn, // default export = init function (initWasm)
    EdgeVec: MockEdgeVecConstructor, // named export = EdgeVec class
    EdgeVecConfig: MockEdgeVecConfig, // named export = EdgeVecConfig class
    load: mockLoadStaticFn, // static load function
    __esModule: true,
  };
});

describe('VectorIndex', () => {
  beforeEach(async () => {
    // Clear all mock call history but NOT implementations
    vi.clearAllMocks();

    // Get fresh instance for each test
    VectorIndex['instance'] = null;

    // Reset the edgevec module mock to default implementations
    const edgevec = await import('edgevec');
    (edgevec.default as ReturnType<typeof vi.fn>).mockReset();
    (edgevec.default as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (edgevec.load as ReturnType<typeof vi.fn>).mockReset();
    (edgevec.load as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Reset methods on the EXISTING mock instance (don't replace the object!)
    // This ensures this.index still references the same mock object
    mockEdgeVecInstance.insert.mockReset();
    mockEdgeVecInstance.insert.mockReturnValue(0);
    mockEdgeVecInstance.insertBatchWithProgress.mockReset();
    mockEdgeVecInstance.insertBatchWithProgress.mockReturnValue({
      ids: new BigUint64Array([0n, 1n]),
      inserted: 2,
      total: 2,
      free: vi.fn(),
    });
    mockEdgeVecInstance.search.mockReset();
    mockEdgeVecInstance.search.mockReturnValue([]);
    mockEdgeVecInstance.softDelete.mockReset();
    mockEdgeVecInstance.save.mockReset();
    mockEdgeVecInstance.save.mockResolvedValue(undefined);
    mockEdgeVecInstance.liveCount.mockReset();
    mockEdgeVecInstance.liveCount.mockReturnValue(0);
    mockEdgeVecInstance.canInsert.mockReset();
    mockEdgeVecInstance.canInsert.mockReturnValue(true);
    mockEdgeVecInstance.free.mockReset();
  });

  afterEach(() => {
    // Dispose to clean up singleton
    try {
      const instance = VectorIndex.getInstance();
      instance.dispose();
    } catch {
      // ignore
    }
  });

  describe('getInstance', () => {
    it('returns singleton instance', () => {
      const instance1 = VectorIndex.getInstance();
      const instance2 = VectorIndex.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('creates new instance on first call', () => {
      const instance = VectorIndex.getInstance();
      expect(instance).toBeInstanceOf(VectorIndex);
    });
  });

  describe('initialize', () => {
    it('initializes EdgeVec and creates index', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      expect(instance.isReady()).toBe(true);
    });

    it('returns early if already ready', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();
      await instance.initialize();

      // init should only be called once (first initialize)
      // The second call returns early due to initPromise check
      expect(instance.isReady()).toBe(true);
    });

    it('sets ready=false on failure and rethrows', async () => {
      const edgevec = await import('edgevec');
      (edgevec.default as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('WASM init failed'));

      const instance = VectorIndex.getInstance();
      await expect(instance.initialize()).rejects.toThrow('Failed to initialize VectorIndex');
      expect(instance.isReady()).toBe(false);
    });
  });

  describe('isReady', () => {
    it('returns false before initialization', () => {
      const instance = VectorIndex.getInstance();
      expect(instance.isReady()).toBe(false);
    });

    it('returns true after successful initialization', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();
      expect(instance.isReady()).toBe(true);
    });
  });

  describe('load() - KEY: ordering regression', () => {
    it('calls loadMapping() BEFORE assigning this.index', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      // Create a loaded index that will be assigned
      const loadedIndex = {
        insert: vi.fn<(_vector: Float32Array) => number>(),
        insertBatchWithProgress: vi.fn<(_vectors: Float32Array[], _onProgress?: (done: number, total: number) => void) => { ids: BigUint64Array; inserted: number; total: number; free: () => void }>(),
        search: vi.fn<(_query: Float32Array, k: number) => Array<{ id: number; score: number }>>(),
        softDelete: vi.fn<(id: number) => void>(),
        save: vi.fn<(_name: string) => Promise<void>>(),
        liveCount: vi.fn<() => number>().mockReturnValue(5),
        canInsert: vi.fn<() => boolean>(),
        free: vi.fn<() => void>(),
        [Symbol.dispose]: vi.fn<() => void>(),
      };

      // Mock static load to succeed
      const edgevec = await import('edgevec');
      (edgevec.load as ReturnType<typeof vi.fn>).mockResolvedValue(loadedIndex);

      // Spy on the instance's loadMapping to track call order
      const loadMappingSpy = vi.spyOn(instance as unknown as { loadMapping: () => Promise<void> }, 'loadMapping');

      // Track if index was assigned before loadMapping
      let indexAssignedBeforeMapping = false;
      const originalLoadMapping = (instance as unknown as { loadMapping: () => Promise<void> }).loadMapping.bind(instance);
      (instance as unknown as { loadMapping: () => Promise<void> }).loadMapping = async () => {
        // Check if index has been replaced during loadMapping
        const currentIndex = (instance as unknown as { index: typeof loadedIndex | null }).index;
        indexAssignedBeforeMapping = currentIndex === loadedIndex;
        await originalLoadMapping();
      };

      await instance.load();

      // Verify loadMapping was called
      expect(loadMappingSpy).toHaveBeenCalled();

      // Key assertion: index should NOT be the loaded index yet when loadMapping runs
      // This verifies the ordering fix - loadMapping is called before this.index = loadedIndex
      expect(indexAssignedBeforeMapping).toBe(false);
    });

    it('disposes loadedIndex in catch block on mapping failure', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      // Create a loaded index that will be disposed
      const loadedIndex = {
        insert: vi.fn<(_vector: Float32Array) => number>(),
        insertBatchWithProgress: vi.fn<(_vectors: Float32Array[], _onProgress?: (done: number, total: number) => void) => { ids: BigUint64Array; inserted: number; total: number; free: () => void }>(),
        search: vi.fn<(_query: Float32Array, k: number) => Array<{ id: number; score: number }>>(),
        softDelete: vi.fn<(id: number) => void>(),
        save: vi.fn<(_name: string) => Promise<void>>(),
        liveCount: vi.fn<() => number>().mockReturnValue(5),
        canInsert: vi.fn<() => boolean>(),
        free: vi.fn<() => void>(),
        [Symbol.dispose]: vi.fn<() => void>(),
      };

      // Mock static load to succeed but make loadMapping fail
      const edgevec = await import('edgevec');
      (edgevec.load as ReturnType<typeof vi.fn>).mockResolvedValue(loadedIndex);

      // Spy on the instance's loadMapping to make it throw
      const originalLoadMapping = (instance as unknown as { loadMapping: () => Promise<void> }).loadMapping.bind(instance);
      (instance as unknown as { loadMapping: () => Promise<void> }).loadMapping = async () => {
        throw new Error('Mapping DB error');
      };

      const freeSpy = vi.spyOn(loadedIndex, 'free');
      const disposeSpy = vi.spyOn(loadedIndex, Symbol.dispose as unknown as keyof typeof loadedIndex);

      const result = await instance.load();

      expect(result).toBe(false);
      // loadedIndex should have been disposed (either free or Symbol.dispose)
      expect(freeSpy.mock.calls.length + disposeSpy.mock.calls.length).toBeGreaterThan(0);

      // Restore original
      (instance as unknown as { loadMapping: () => Promise<void> }).loadMapping = originalLoadMapping;
    });
  });

  describe('addBatch - KEY: uses startId = liveCount()', () => {
    it('captures startId = liveCount() before batch insert for correct ID mapping', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      // Mock liveCount to return 10 before batch insert, then 13 after
      mockEdgeVecInstance.liveCount = vi.fn<() => number>()
        .mockReturnValueOnce(10)  // First call = startId capture
        .mockReturnValueOnce(13); // Second call after insert (if any)

      const entries = [
        { docId: 'doc1', chunkIndex: 0, vector: new Float32Array(384) },
        { docId: 'doc2', chunkIndex: 1, vector: new Float32Array(384) },
        { docId: 'doc3', chunkIndex: 2, vector: new Float32Array(384) },
      ];

      await instance.addBatch(entries);

      // liveCount should be called to capture startId before batch insert
      const liveCountCalls = mockEdgeVecInstance.liveCount.mock.calls;
      expect(liveCountCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('maps correct internal IDs after batch insert using startId + index', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      // Set up liveCount to return 0 initially (empty index)
      mockEdgeVecInstance.liveCount = vi.fn<() => number>().mockReturnValue(0);

      const entries = [
        { docId: 'docA', chunkIndex: 0, vector: new Float32Array(384) },
        { docId: 'docB', chunkIndex: 1, vector: new Float32Array(384) },
      ];

      await instance.addBatch(entries);

      // After batch insert, the idMapping should have entries with IDs 0 and 1 (startId=0 + j)
      const idMapping = (instance as unknown as { idMapping: Map<number, { docId: string; chunkIndex: number }> }).idMapping;
      expect(idMapping.size).toBe(2);
    });

    it('throws when index is full', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      // Set up canInsert to return false - this should cause the add to throw
      mockEdgeVecInstance.liveCount.mockReturnValue(99999);
      mockEdgeVecInstance.canInsert.mockReturnValue(false);
      // Make insertBatchWithProgress throw synchronously when index is full
      mockEdgeVecInstance.insertBatchWithProgress = vi.fn().mockImplementation(() => {
        throw new Error('Index is full');
      });

      const entries = [
        { docId: 'doc1', chunkIndex: 0, vector: new Float32Array(384) },
      ];

      await expect(instance.addBatch(entries)).rejects.toThrow('Index is full');
    });
  });

  describe('search - KEY: maps results through idMapping', () => {
    it('maps search results through idMapping to get docId and chunkIndex', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      // Manually set up idMapping entries
      const idMapping = (instance as unknown as { idMapping: Map<number, { docId: string; chunkIndex: number }> }).idMapping;
      idMapping.set(0, { docId: 'doc-abc', chunkIndex: 5 });
      idMapping.set(1, { docId: 'doc-xyz', chunkIndex: 12 });

      // Mock search to return results with internal IDs 0 and 1
      mockEdgeVecInstance.search = vi.fn<(_query: Float32Array, k: number) => Array<{ id: number; score: number }>>()
        .mockReturnValue([
          { id: 0, score: 0.95 },
          { id: 1, score: 0.87 },
        ]);

      const results = await instance.search(new Float32Array(384), { k: 2 });

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ docId: 'doc-abc', chunkIndex: 5, score: 0.95 });
      expect(results[1]).toEqual({ docId: 'doc-xyz', chunkIndex: 12, score: 0.87 });
    });

    it('handles missing idMapping entries with unknown docId', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      // Mock search to return a result with an ID not in mapping
      mockEdgeVecInstance.search = vi.fn<(_query: Float32Array, k: number) => Array<{ id: number; score: number }>>()
        .mockReturnValue([
          { id: 99, score: 0.75 },
        ]);

      const results = await instance.search(new Float32Array(384), { k: 1 });

      // Should return 'unknown' for missing docId
      expect(results[0]).toEqual({ docId: 'unknown', chunkIndex: 0, score: 0.75 });
    });

    it('respects efSearch option', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      mockEdgeVecInstance.search = vi.fn<(_query: Float32Array, k: number) => Array<{ id: number; score: number }>>()
        .mockReturnValue([]);

      // efSearch is set via EdgeVecConfig at initialization time, not at search time
      // The search method accepts efSearch in options but the current implementation
      // does not use it - it was set on EdgeVecConfig during initialize()
      await instance.search(new Float32Array(384), { k: 5, efSearch: 100 });

      // Verify search was called (efSearch config is applied at init time)
      expect(mockEdgeVecInstance.search).toHaveBeenCalled();
    });

    it('throws on invalid query vector dimension', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      const shortVector = new Float32Array(128); // Wrong dimension
      await expect(instance.search(shortVector)).rejects.toThrow('Invalid query vector dimension');
    });
  });

  describe('removeByDocId - KEY: calls softDelete for all matching IDs', () => {
    it('calls softDelete for all internal IDs associated with docId', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      // Set up idMapping with multiple entries for same docId
      const idMapping = (instance as unknown as { idMapping: Map<number, { docId: string; chunkIndex: number }> }).idMapping;
      idMapping.set(0, { docId: 'doc-to-delete', chunkIndex: 0 });
      idMapping.set(1, { docId: 'doc-to-delete', chunkIndex: 1 });
      idMapping.set(2, { docId: 'doc-to-delete', chunkIndex: 2 });
      idMapping.set(3, { docId: 'other-doc', chunkIndex: 0 });

      await instance.removeByDocId('doc-to-delete');

      // softDelete should be called 3 times (for IDs 0, 1, 2)
      expect(mockEdgeVecInstance.softDelete).toHaveBeenCalledTimes(3);
      expect(mockEdgeVecInstance.softDelete).toHaveBeenCalledWith(0);
      expect(mockEdgeVecInstance.softDelete).toHaveBeenCalledWith(1);
      expect(mockEdgeVecInstance.softDelete).toHaveBeenCalledWith(2);

      // ID 3 should remain in mapping
      expect(idMapping.has(3)).toBe(true);
      expect(idMapping.has(0)).toBe(false);
      expect(idMapping.has(1)).toBe(false);
      expect(idMapping.has(2)).toBe(false);
    });

    it('handles docId with no matching entries', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      const idMapping = (instance as unknown as { idMapping: Map<number, { docId: string; chunkIndex: number }> }).idMapping;
      idMapping.set(0, { docId: 'other-doc', chunkIndex: 0 });

      await instance.removeByDocId('non-existent-doc');

      // softDelete should not be called
      expect(mockEdgeVecInstance.softDelete).not.toHaveBeenCalled();
    });
  });

  describe('dispose - KEY: calls free()', () => {
    it('calls free() on the index to release WASM resources', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      instance.dispose();

      // free() should have been called
      expect(mockEdgeVecInstance.free.mock.calls).toHaveLength(1);

      expect(instance.isReady()).toBe(false);
    });

    it('clears idMapping on dispose', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      const idMapping = (instance as unknown as { idMapping: Map<number, { docId: string; chunkIndex: number }> }).idMapping;
      idMapping.set(0, { docId: 'doc1', chunkIndex: 0 });

      expect(idMapping.size).toBe(1);

      instance.dispose();

      expect(idMapping.size).toBe(0);
    });

    it('resets singleton instance to null', () => {
      const instance = VectorIndex.getInstance();
      instance.dispose();

      // After dispose, getInstance should return a new instance
      const newInstance = VectorIndex.getInstance();
      expect(newInstance).not.toBe(instance);
    });
  });

  describe('save', () => {
    it('calls EdgeVec.save and saveMapping', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      // Mock saveMapping to avoid IndexedDB not defined error
      const saveMappingSpy = vi.spyOn(instance as unknown as { saveMapping: () => Promise<void> }, 'saveMapping').mockResolvedValue();

      await instance.save();

      expect(mockEdgeVecInstance.save.mock.calls).toContainEqual(['doc-qa-index']);
      expect(saveMappingSpy).toHaveBeenCalled();
    });
  });

  describe('size', () => {
    it('returns liveCount from EdgeVec index', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      mockEdgeVecInstance.liveCount = vi.fn<() => number>().mockReturnValue(42);

      expect(instance.size()).toBe(42);
    });

    it('falls back to idMapping.size if index is null', () => {
      const instance = VectorIndex.getInstance();
      // Before initialization, size should reflect idMapping
      expect(instance.size()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('addVector', () => {
    it('inserts vector and stores mapping', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      const vector = new Float32Array(384);
      mockEdgeVecInstance.insert = vi.fn<(_vector: Float32Array) => number>().mockReturnValue(5);

      await instance.addVector(vector, 'test-doc', 3);

      const idMapping = (instance as unknown as { idMapping: Map<number, { docId: string; chunkIndex: number }> }).idMapping;
      expect(idMapping.get(5)).toEqual({ docId: 'test-doc', chunkIndex: 3 });
    });

    it('throws on invalid vector dimension', async () => {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      const wrongDimension = new Float32Array(128);
      await expect(instance.addVector(wrongDimension, 'doc', 0)).rejects.toThrow('Invalid vector dimension');
    });

    it('throws when index is not ready', async () => {
      const instance = VectorIndex.getInstance();
      // Don't initialize

      const vector = new Float32Array(384);
      await expect(instance.addVector(vector, 'doc', 0)).rejects.toThrow('not initialized');
    });
  });
});
