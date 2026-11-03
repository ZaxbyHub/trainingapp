/**
 * Rollback-recovery probe (trace collated-275-268, U1 verification plan;
 * companion to the frozen C1 merge-window spec — this file is NOT frozen).
 *
 * Deterministic failure-path probe: a save's WRITE (the merged snapshot's
 * `temp.save`) is parked AFTER the idMapping swap (the baseline-load path
 * cannot reach the write-failure catch), a put is registered while the write
 * is parked (it lands in the live map), and the parked write is then
 * REJECTED. The failure path must restore the pre-save mapping AND carry
 * the post-write registration (the liveDuringWrites overlay), so:
 *   (i)  the put still resolves in the live map after the failed save;
 *   (ii) a subsequent save persists it;
 *   (iii) a reload resolves it.
 *
 * The plan's verification section requires a MUTATION run proving this probe
 * fails when the liveDuringWrites restoration overlay is removed (recorded
 * in the trace's 08a sweep evidence).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VectorIndex } from './vector-index';

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

/** Monotone id allocator (mirrors the frozen C1 amendment): ids never
 * collide across snapshot instances, the way a real index never re-issues. */
let nextTempVectorId = 0;

function makeTempInstance(opts?: { save?: () => Promise<void> }) {
  const insertedIds = new Set<number>();
  return {
    insertedIds,
    softDelete: vi.fn(),
    insertBatchWithProgress: vi.fn(
      (vectors: Float32Array[], _onProgress?: (done: number, total: number) => void) => {
        const ids = new BigUint64Array(vectors.map(() => BigInt(nextTempVectorId++)));
        for (const id of ids) insertedIds.add(Number(id));
        return { ids, inserted: vectors.length, total: vectors.length, free: vi.fn() };
      }
    ),
    save: vi.fn(opts?.save ?? (async () => {})),
    liveCount: vi.fn(() => 0),
    canInsert: vi.fn(() => true),
    free: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  };
}

type LoadHandler = () => Promise<unknown>;
const notFoundLoad = () => Promise.reject(new Error('EdgeVec index not found: rollback-probe'));
let loadHandlers: LoadHandler[] = [];

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

const flushTasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('VectorIndex save-failure rollback recovery (U1 probe)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    nextTempVectorId = 0;

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
    mockEdgeVecInstance.search.mockReset();
    mockEdgeVecInstance.search.mockReturnValue([]);
    mockEdgeVecInstance.save.mockReset();
    mockEdgeVecInstance.save.mockResolvedValue(undefined);
    mockEdgeVecInstance.canInsert.mockReset();
    mockEdgeVecInstance.canInsert.mockReturnValue(true);
    mockEdgeVecInstance.liveCount.mockReset();
    mockEdgeVecInstance.liveCount.mockReturnValue(0);
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

  it('a put registered while the write is parked survives the failed save and persists with the next save', async () => {
    const edgevec = await import('edgevec');
    const loadMock = (edgevec as unknown as { load: ReturnType<typeof vi.fn> }).load;

    const idb = makeStatefulIdb({ version: { key: 'version', version: 3 } });
    (globalThis as { indexedDB?: unknown }).indexedDB = idb;

    // save #1's merged snapshot: its temp.save is a PARKED write (the
    // failure window). The rejection is test-controlled.
    let rejectTempSave!: (reason: Error) => void;
    const parkedTempSave = new Promise<void>((_resolve, reject) => {
      rejectTempSave = reject;
    });
    const temp1 = makeTempInstance({ save: () => parkedTempSave });

    loadHandlers = [
      notFoundLoad, // boot load: no snapshot yet
      () => Promise.resolve(temp1), // save #1 merge baseline
      () => Promise.resolve(makeTempInstance()), // save #2 merge baseline
      () => Promise.resolve(makeTempInstance()), // reload boot load
    ];

    const instance = VectorIndex.getInstance();
    await instance.initialize();

    mockEdgeVecInstance.insert.mockReturnValueOnce(100);
    await instance.addVector(new Float32Array(768), 'doc-rollback-a', 0, { text: 'chunk a' });

    // Start save #1; run it to the PARKED temp.save (the swap and the
    // saveMapping write both happen before it).
    const save1 = instance.save();
    await flushTasks();
    await flushTasks();
    expect(temp1.insertBatchWithProgress).toHaveBeenCalled(); // merge consumed the snapshot

    // Register a put WHILE the write is parked (post-swap: it lands in the
    // live map).
    mockEdgeVecInstance.insert.mockReturnValueOnce(101);
    await instance.addVector(new Float32Array(768), 'doc-rollback-b', 0, { text: 'chunk b' });

    // REJECT the parked write: the failure catch must restore the mapping
    // AND carry the post-write registration.
    rejectTempSave(new Error('snapshot write failed'));
    await expect(save1).rejects.toThrow(/Save failed/);

    // (i) the put still resolves in the live map after the failed save.
    expect(instance.hasDocEntries('doc-rollback-b')).toBe(true);
    expect(instance.hasDocEntries('doc-rollback-a')).toBe(true);

    // (ii) a subsequent save persists it (its op is live, so the next save's
    // discovery re-inserts it into the fresh baseline).
    await instance.save();
    const persisted = idb.rows.get('idMapping') as
      | { data: Array<{ docId: string; chunkIndex: number }> }
      | undefined;
    expect(persisted).toBeDefined();
    expect(persisted!.data.some((e) => e.docId === 'doc-rollback-b')).toBe(true);
    expect(persisted!.data.some((e) => e.docId === 'doc-rollback-a')).toBe(true);

    // (iii) a reload resolves it.
    instance.dispose();
    VectorIndex['instance'] = null;
    const reloaded = VectorIndex.getInstance();
    await reloaded.initialize();
    expect(reloaded.hasDocEntries('doc-rollback-b')).toBe(true);
    expect(reloaded.hasDocEntries('doc-rollback-a')).toBe(true);
  });
});
