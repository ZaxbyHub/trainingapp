/**
 * Frozen check C1 (trace collated-275-268, AC1 of issue #275).
 *
 * A put (`addVector`/`addBatch`) that lands while a `save()`'s async merge is
 * in flight must survive the save's pre-write `idMapping` swap
 * (vector-index.ts:643 `this.idMapping = newMapping`) and be persisted by the
 * SUBSEQUENT save, so that after a reload every chunk id added during the
 * merge window resolves to a live vector.
 *
 * The merge window is held open deterministically: the baseline load
 * (`EdgeVec.load`) of the first save resolves on a test-controlled deferred,
 * and the mid-save put lands while that promise is parked (no wall-clock
 * sleeps anywhere in this spec).
 *
 * RED at base (the swap wipes the mid-save put's mapping entry; the next
 * save's discovery loop never sees it), GREEN after the fix.
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
// vector-index.test.ts:29-60 so this spec never touches the WASM backend).
vi.mock('edgevec', () => {
  const mockInitFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const mockLoadStaticFn = vi.fn().mockResolvedValue(null);

  // The default export is a constructor that returns mockEdgeVecInstance (must use regular function for 'new')
  const MockEdgeVecConstructor = vi.fn().mockImplementation(function(this: typeof mockEdgeVecInstance) {
    return mockEdgeVecInstance;
  });

  // Copy static methods to the constructor
  (MockEdgeVecConstructor as unknown as { load: typeof mockLoadStaticFn }).load = mockLoadStaticFn;

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

/**
 * Stateful fake IndexedDB: rows survive across `open` calls within one test
 * (this is what makes the save's baseline read and the reload observe the
 * same persisted corpus). Requests resolve on microtasks, so one macrotask
 * flush (`flushTasks`) settles any chain of them deterministically.
 */
function makeStatefulIdb(seed: Record<string, unknown>) {
  const rows = new Map<string, unknown>(Object.entries(seed));
  const makeDb = () => ({
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
      // readwrite transactions resolve on tx.oncomplete, which production
      // assigns synchronously after queuing its puts - fire it one
      // microtask later, after the assignments have happened.
      Promise.resolve().then(() => {
        if (tx.oncomplete) tx.oncomplete();
      });
      return tx;
    },
  });
  return {
    rows,
    open: vi.fn().mockImplementation(() => {
      const req = {
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
        onupgradeneeded: null as null | (() => void),
        result: makeDb(),
        error: null,
      };
      Promise.resolve().then(() => req.onsuccess && req.onsuccess());
      return req;
    }),
  } as unknown as typeof indexedDB & { rows: Map<string, unknown> };
}

/** A controllable baseline instance handed to save()'s merge via EdgeVec.load. */
function makeTempInstance() {
  return {
    softDelete: vi.fn(),
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
const notFoundLoad = () => Promise.reject(new Error('EdgeVec index not found: merge-window-spec'));
let loadHandlers: LoadHandler[] = [];

const flushTasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('VectorIndex merge-window put retention (C1)', () => {
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

  it('a put landing during the save merge survives the swap and persists with the next save', async () => {
    const edgevec = await import('edgevec');
    const loadMock = (edgevec as unknown as { load: ReturnType<typeof vi.fn> }).load;

    // A persisted v3 corpus with no snapshot yet: boot load misses, save
    // merges into a baseline instance (the merge window this spec holds open).
    const idb = makeStatefulIdb({ version: { key: 'version', version: 3 } });
    (globalThis as { indexedDB?: unknown }).indexedDB = idb;

    const temp1 = makeTempInstance();
    let releaseBaselineLoad!: () => void;
    const parkedBaselineLoad = new Promise<unknown>((resolve) => {
      releaseBaselineLoad = () => resolve(temp1);
    });
    loadHandlers = [
      notFoundLoad, // boot load: no snapshot yet
      () => parkedBaselineLoad, // save #1 merge baseline: parked (the merge window)
      () => Promise.resolve(makeTempInstance()), // save #2 merge baseline
      () => Promise.resolve(makeTempInstance()), // reload boot load
    ];

    const instance = VectorIndex.getInstance();
    await instance.initialize();

    // Doc A is put BEFORE the save starts (it is in the save's snapshot).
    mockEdgeVecInstance.insert.mockReturnValueOnce(100);
    await instance.addVector(new Float32Array(768), 'doc-merge-a', 0, { text: 'chunk a' });

    // Start save #1 and let it reach the parked baseline load.
    const save1 = instance.save();
    await flushTasks();
    expect(loadMock).toHaveBeenCalledTimes(2); // boot + save #1's baseline (parked)

    // Doc B lands INSIDE the merge window, while save #1 awaits its baseline.
    mockEdgeVecInstance.insert.mockReturnValueOnce(101);
    await instance.addVector(new Float32Array(768), 'doc-merge-b', 0, { text: 'chunk b' });

    // Complete save #1 (the pre-write idMapping swap happens after this).
    releaseBaselineLoad();
    await save1;

    // Discriminator 1: the mid-save put's mapping entry must still resolve
    // after the save's swap. At base the swap (vector-index.ts:643) wipes it.
    const mappingAfterSave1 = (instance as unknown as { idMapping: Map<number, { docId: string }> })
      .idMapping;
    expect(
      Array.from(mappingAfterSave1.values()).some((meta) => meta.docId === 'doc-merge-b')
    ).toBe(true);

    // Discriminator 2: the next save persists the mid-save put.
    await instance.save();
    const persisted = idb.rows.get('idMapping') as { data: Array<{ docId: string }> } | undefined;
    expect(persisted).toBeDefined();
    expect(
      persisted!.data.some((entry) => entry.docId === 'doc-merge-b')
    ).toBe(true);

    // Discriminator 3: after a reload, every chunk id added during the merge
    // window resolves to a live vector (the mapping row covers doc B).
    instance.dispose();
    VectorIndex['instance'] = null;
    const reloaded = VectorIndex.getInstance();
    await reloaded.initialize();
    expect(reloaded.hasDocEntries('doc-merge-a')).toBe(true);
    expect(reloaded.hasDocEntries('doc-merge-b')).toBe(true);
  });
});
