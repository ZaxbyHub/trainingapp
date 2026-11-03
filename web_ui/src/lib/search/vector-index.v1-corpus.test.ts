/**
 * Frozen check C7 (trace collated-275-268, AC2 of issue #268).
 *
 * A persisted store with an `idMapping` row but NO `version` row is a
 * genuine v1 (pre-versioned, mean-pooled) corpus: it must still be DISCARDED
 * without calling `EdgeVec.load`, and the re-index flag must be set. This is
 * the guard rail for the fresh-store fix (AC6/C6): treating every
 * missing-version store as fresh would reload incompatible mean-pooled
 * vectors.
 *
 * The fake IndexedDB is stateful and PRE-SEEDED with an `idMapping` row (a
 * real v1 corpus always has one - `saveMapping()` writes both rows), with no
 * `version` row, and never fires `onupgradeneeded` (the DB pre-exists).
 *
 * Regression floor: this behaviour holds at base and must survive the fix.
 * RED at base (spec absent), GREEN after the fix.
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

// Mock the edgevec module - vi.mock is hoisted to top of file (copied from
// vector-index.test.ts:29-60).
vi.mock('edgevec', () => {
  const mockInitFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const mockLoadStaticFn = vi.fn().mockResolvedValue(null);

  const MockEdgeVecConstructor = vi.fn().mockImplementation(function(this: typeof mockEdgeVecInstance) {
    return mockEdgeVecInstance;
  });

  (MockEdgeVecConstructor as unknown as { load: typeof mockLoadStaticFn }).load = mockLoadStaticFn;

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
    default: mockInitFn,
    EdgeVec: MockEdgeVecConstructor,
    EdgeVecConfig: MockEdgeVecConfig,
    load: mockLoadStaticFn,
    __esModule: true,
  };
});

/**
 * A PRE-EXISTING mappings store holding a v1 corpus: an `idMapping` row but
 * no `version` row. The DB pre-exists, so `onupgradeneeded` never fires and
 * `createdFresh` stays false - this is the upgrade shape, not a fresh install.
 */
function makeV1CorpusIdb() {
  const rows = new Map<string, unknown>([
    [
      'idMapping',
      {
        key: 'idMapping',
        data: [
          { id: 1, docId: 'v1-doc-a', chunkIndex: 0 },
          { id: 2, docId: 'v1-doc-a', chunkIndex: 1 },
        ],
      },
    ],
    // NOTE: no 'version' row - the pre-v2 signature.
  ]);
  return {
    rows,
    open: vi.fn().mockImplementation(() => {
      const db = {
        objectStoreNames: { contains: (n: string) => n === 'mappings' },
        close: vi.fn(),
        transaction: (_store: string, _mode?: IDBTransactionMode) => ({
          objectStore: () => ({
            get: (key: string) => {
              const r = {
                onsuccess: null as null | (() => void),
                onerror: null as null | (() => void),
                result: rows.has(key) ? rows.get(key) : null,
              };
              Promise.resolve().then(() => r.onsuccess && r.onsuccess());
              return r;
            },
            put: (value: { key: string }) => {
              rows.set(value.key, value);
              const r = { onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
              Promise.resolve().then(() => r.onsuccess && r.onsuccess());
              return r;
            },
          }),
          oncomplete: null as null | (() => void),
          onabort: null as null | (() => void),
          onerror: null as null | (() => void),
        }),
      };
      const req = {
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
        // The DB already exists: no upgrade fires for a v1 corpus.
        onupgradeneeded: null as null | (() => void),
        result: db,
        error: null,
      };
      Promise.resolve().then(() => req.onsuccess && req.onsuccess());
      return req;
    }),
  } as unknown as typeof indexedDB & { rows: Map<string, unknown> };
}

describe('VectorIndex v1-corpus discard (C7)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    VectorIndex['instance'] = null;

    const edgevec = await import('edgevec');
    (edgevec.default as ReturnType<typeof vi.fn>).mockReset();
    (edgevec.default as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (edgevec as unknown as { load: ReturnType<typeof vi.fn> }).load.mockReset();
    (edgevec as unknown as { load: ReturnType<typeof vi.fn> }).load.mockResolvedValue(null);

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

    try {
      (globalThis as { localStorage?: Storage }).localStorage?.removeItem('rag-reindex-required');
    } catch {
      /* private mode */
    }
  });

  afterEach(() => {
    try {
      VectorIndex.getInstance().dispose();
    } catch {
      /* ignore */
    }
    try {
      (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    } catch {
      /* ignore */
    }
  });

  it('discards a v1 corpus (idMapping row, no version row) without EdgeVec.load and flags re-index', async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = makeV1CorpusIdb();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const instance = VectorIndex.getInstance();
      await instance.initialize();

      const edgevec = await import('edgevec');
      const loadMock = (edgevec as unknown as { load: ReturnType<typeof vi.fn> }).load;
      loadMock.mockClear();

      const loaded = await instance.load();

      // The incompatible v1 corpus is discarded...
      expect(loaded).toBe(false);
      // ...WITHOUT ever reading the native (mean-pooled) snapshot...
      expect(loadMock).not.toHaveBeenCalled();
      // ...and the UI is told to re-index.
      expect(
        (globalThis as { localStorage?: Storage }).localStorage?.getItem('rag-reindex-required')
      ).toBe('1');

      // The discard warns once with the pre-versioned signature.
      const preversioned = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('pre-versioned')
      );
      expect(preversioned.length).toBeGreaterThanOrEqual(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('clears any in-memory mapping while discarding the v1 corpus', async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = makeV1CorpusIdb();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const instance = VectorIndex.getInstance();
      await instance.initialize();
      await instance.load();

      expect(instance.hasDocEntries('v1-doc-a')).toBe(false);
      expect(instance.isReady()).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
