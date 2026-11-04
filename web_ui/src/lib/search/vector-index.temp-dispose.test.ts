/**
 * Frozen check C4 (trace collated-275-268, AC4 of issue #275).
 *
 * A failure injected at each POST-ASSIGNMENT point of save()'s temp-EdgeVec
 * lifecycle - mapping-read, softDelete, insert, write (the four
 * `disposeEdgeVec(temp)` catch sites around the merge, PRR-012) - must
 * dispose the temp instance EXACTLY ONCE and leave the LIVE instance
 * untouched. This contract is currently proven by code reading only; the
 * spec pins it so any refactor that skips (or doubles) a dispose, or frees
 * the live instance on a merge failure, goes red.
 *
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
 * Stateful fake IndexedDB (rows survive across `open` calls within a test) so
 * the merge's baseline read observes the seeded persisted rows.
 */
function makeStatefulIdb(seed: Record<string, unknown>) {
  const rows = new Map<string, unknown>(Object.entries(seed));
  return {
    rows,
    open: vi.fn().mockImplementation(() => {
      const db = {
        objectStoreNames: { contains: (n: string) => n === 'mappings' },
        close: vi.fn(),
        transaction: (_store: string, _mode?: IDBTransactionMode) => {
          const tx = {
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
          };
          Promise.resolve().then(() => {
            if (tx.oncomplete) tx.oncomplete();
          });
          return tx;
        },
      };
      const req = {
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
        onupgradeneeded: null as null | (() => void),
        result: db,
        error: null,
      };
      Promise.resolve().then(() => req.onsuccess && req.onsuccess());
      return req;
    }),
  } as unknown as typeof indexedDB & { rows: Map<string, unknown> };
}

/**
 * A controllable baseline instance handed to save()'s merge via EdgeVec.load.
 * Disposal is tracked on BOTH channels (Symbol.dispose preferred by
 * disposeEdgeVec, free as the fallback).
 */
function makeTempInstance() {
  return {
    softDelete: vi.fn<(id: number) => void>(),
    insertBatchWithProgress: vi.fn(
      (vectors: Float32Array[], _onProgress?: (done: number, total: number) => void) => ({
        ids: new BigUint64Array(vectors.map((_v, i) => BigInt(i))),
        inserted: vectors.length,
        total: vectors.length,
        free: vi.fn(),
      })
    ),
    save: vi.fn(async () => {}),
    liveCount: vi.fn(() => 0),
    canInsert: vi.fn(() => true),
    free: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  };
}

type LoadHandler = () => Promise<unknown>;
const notFoundLoad = () => Promise.reject(new Error('EdgeVec index not found: temp-dispose-spec'));
let loadHandlers: LoadHandler[] = [];

describe('VectorIndex temp-instance disposal on save failures (C4)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    VectorIndex['instance'] = null;

    const edgevec = await import('edgevec');
    (edgevec.default as ReturnType<typeof vi.fn>).mockReset();
    (edgevec.default as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const loadMock = (edgevec as unknown as { load: ReturnType<typeof vi.fn> }).load;
    loadMock.mockReset();
    loadHandlers = [];
    loadMock.mockImplementation(() =>
      loadHandlers.length > 0 ? loadHandlers.shift()!() : notFoundLoad()
    );

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

  /** Boot the singleton against a v3 store, then hand the merge a temp. */
  async function bootWithTempBaseline(
    idb: ReturnType<typeof makeStatefulIdb>,
    temp: ReturnType<typeof makeTempInstance>
  ): Promise<void> {
    (globalThis as { indexedDB?: unknown }).indexedDB = idb;
    loadHandlers = [notFoundLoad, () => Promise.resolve(temp)];
    const instance = VectorIndex.getInstance();
    await instance.initialize();
  }

  it('mapping-read failure: temp disposed exactly once, live instance untouched', async () => {
    const temp = makeTempInstance();
    await bootWithTempBaseline(
      makeStatefulIdb({ version: { key: 'version', version: 3 } }),
      temp
    );

    const instance = VectorIndex.getInstance();
    mockEdgeVecInstance.insert.mockReturnValueOnce(10);
    await instance.addVector(new Float32Array(768), 'doc-mr', 0);

    // Inject the failure AFTER the temp instance is assigned: the baseline
    // mapping read rejects.
    const instanceInternals = instance as unknown as {
      readMappingEntries: () => Promise<Array<[number, unknown]>>;
    };
    const originalRead = instanceInternals.readMappingEntries.bind(instance);
    instanceInternals.readMappingEntries = async () => {
      await originalRead();
      throw new Error('mapping read failed');
    };

    await expect(instance.save()).rejects.toThrow('Save failed');

    const disposeCalls = (temp[Symbol.dispose] as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(disposeCalls + temp.free.mock.calls.length).toBe(1);
    expect(temp.save).not.toHaveBeenCalled();

    // The LIVE instance was never disposed and stays serviceable.
    expect(mockEdgeVecInstance.free).not.toHaveBeenCalled();
    expect(instance.isReady()).toBe(true);
  });

  it('softDelete failure: temp disposed exactly once, live instance untouched', async () => {
    // A persisted baseline entry for a docId this tab removes, so the merge
    // reaches the softDelete catch site.
    const temp = makeTempInstance();
    await bootWithTempBaseline(
      makeStatefulIdb({
        version: { key: 'version', version: 3 },
        idMapping: {
          key: 'idMapping',
          data: [{ id: 7, docId: 'stale-doc', chunkIndex: 0 }],
        },
      }),
      temp
    );

    const instance = VectorIndex.getInstance();
    await instance.removeByDocId('stale-doc');

    temp.softDelete.mockImplementationOnce(() => {
      throw new Error('soft delete failed');
    });

    await expect(instance.save()).rejects.toThrow('Save failed');
    expect(temp.softDelete).toHaveBeenCalled();

    const disposeCalls = (temp[Symbol.dispose] as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(disposeCalls + temp.free.mock.calls.length).toBe(1);
    expect(temp.save).not.toHaveBeenCalled();
    expect(mockEdgeVecInstance.free).not.toHaveBeenCalled();
    expect(instance.isReady()).toBe(true);
  });

  it('insert failure: temp disposed exactly once, live instance untouched', async () => {
    const temp = makeTempInstance();
    await bootWithTempBaseline(
      makeStatefulIdb({ version: { key: 'version', version: 3 } }),
      temp
    );

    const instance = VectorIndex.getInstance();
    mockEdgeVecInstance.insert.mockReturnValueOnce(11);
    await instance.addVector(new Float32Array(768), 'doc-ins', 0);

    temp.insertBatchWithProgress.mockImplementationOnce(() => {
      throw new Error('insert failed');
    });

    await expect(instance.save()).rejects.toThrow('Save failed');
    expect(temp.insertBatchWithProgress).toHaveBeenCalled();

    const disposeCalls = (temp[Symbol.dispose] as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(disposeCalls + temp.free.mock.calls.length).toBe(1);
    expect(temp.save).not.toHaveBeenCalled();
    expect(mockEdgeVecInstance.free).not.toHaveBeenCalled();
    expect(instance.isReady()).toBe(true);
  });

  it('write failure: temp disposed exactly once, live instance untouched', async () => {
    const temp = makeTempInstance();
    await bootWithTempBaseline(
      makeStatefulIdb({ version: { key: 'version', version: 3 } }),
      temp
    );

    const instance = VectorIndex.getInstance();
    mockEdgeVecInstance.insert.mockReturnValueOnce(12);
    await instance.addVector(new Float32Array(768), 'doc-wr', 0);

    // Inject the failure at the write stage: mapping+version write rejects
    // (both the primary write and the catch's best-effort baseline rewrite).
    vi.spyOn(
      instance as unknown as { saveMapping: () => Promise<void> },
      'saveMapping'
    ).mockRejectedValue(new Error('mapping write failed'));

    await expect(instance.save()).rejects.toThrow('Save failed');

    const disposeCalls = (temp[Symbol.dispose] as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(disposeCalls + temp.free.mock.calls.length).toBe(1);
    expect(mockEdgeVecInstance.free).not.toHaveBeenCalled();
    expect(instance.isReady()).toBe(true);
  });
});
