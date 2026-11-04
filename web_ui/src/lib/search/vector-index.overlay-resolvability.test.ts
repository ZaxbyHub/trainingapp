/**
 * Overlay-resolvability pin (PR #285 review PRR-001; companion to the frozen
 * C1 merge-window spec — this file is NOT frozen).
 *
 * The U1 overlay guard `!insertedOriginalIds.includes(id)` excludes ids the
 * discovery loop already re-inserted into the merged snapshot under REMAPPED
 * ids: overlaying such an original id would put a live-mapping entry whose
 * vector exists only in the disposed pre-swap instance. The frozen C1 spec's
 * discriminators are insensitive to that guard (they read the pre-overlay
 * persisted copy and a remapped live entry), and deleting the single guard
 * line left the FULL suite green — this spec is the pin that makes that
 * mutant RED.
 *
 * Faithful mock: like the real EdgeVec contract (edgevec.d.ts — softDelete
 * "Returns an error if the vector ID doesn't exist"), the merged snapshot
 * instance's softDelete THROWS on an id it never inserted, so "resolvable in
 * the live index" is observable rather than assumed.
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
 * collide across snapshot instances. */
let nextTempVectorId = 0;

function makeTempInstance() {
  const insertedIds = new Set<number>();
  return {
    insertedIds,
    softDelete: vi.fn((id: number) => {
      // Faithful EdgeVec contract: softDelete REJECTS an id this instance
      // never inserted (edgevec.d.ts:147-149).
      if (!insertedIds.has(id)) {
        throw new Error(`softDelete: unknown vector id ${id}`);
      }
    }),
    insertBatchWithProgress: vi.fn(
      (vectors: Float32Array[], _onProgress?: (done: number, total: number) => void) => {
        const ids = new BigUint64Array(vectors.map(() => BigInt(nextTempVectorId++)));
        for (const id of ids) insertedIds.add(Number(id));
        return { ids, inserted: vectors.length, total: vectors.length, free: vi.fn() };
      }
    ),
    save: vi.fn(async () => {}),
    liveCount: vi.fn(() => 0),
    canInsert: vi.fn(() => true),
    free: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  };
}

type LoadHandler = () => Promise<unknown>;
const notFoundLoad = () => Promise.reject(new Error('EdgeVec index not found: resolvability'));
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

describe('VectorIndex overlay resolvability (PRR-001 pin)', () => {
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

  it('a snapshot doc re-put inside the merge window never leaves a live-map id the live index cannot resolve', async () => {
    const idb = makeStatefulIdb({ version: { key: 'version', version: 3 } });
    (globalThis as { indexedDB?: unknown }).indexedDB = idb;

    const temp1 = makeTempInstance();
    let releaseBaselineLoad!: () => void;
    const parkedBaselineLoad = new Promise<unknown>((resolve) => {
      releaseBaselineLoad = () => resolve(temp1);
    });
    loadHandlers = [
      notFoundLoad,
      () => parkedBaselineLoad,
      () => Promise.resolve(makeTempInstance()), // save #2 baseline
      () => Promise.resolve(makeTempInstance()), // reload boot
    ];

    const instance = VectorIndex.getInstance();
    await instance.initialize();

    mockEdgeVecInstance.insert.mockReturnValueOnce(100);
    await instance.addVector(new Float32Array(768), 'doc-resolv-a', 0, { text: 'a' });

    mockEdgeVecInstance.insert.mockReturnValueOnce(102);
    await instance.addVector(new Float32Array(768), 'doc-resolv-c', 0, { text: 'c0' });

    const save1 = instance.save();
    await flushTasks();

    // The mid-window re-put of the SNAPSHOT doc: its discovery consumes the
    // original ids (102) into insertedOriginalIds and re-inserts under a
    // remapped id. A broken overlay guard re-adds the ORIGINAL id to the
    // live map, where the live index (temp1) cannot resolve it.
    mockEdgeVecInstance.insert.mockReturnValueOnce(103);
    await instance.addVector(new Float32Array(768), 'doc-resolv-c', 1, { text: 'c1' });

    releaseBaselineLoad();
    await save1;

    // The invariant: every live-map entry for SNAPSHOT-OWNED docs (A, C —
    // the docs this save merged) must reference an id the live index
    // (temp1) actually holds. (A NON-snapshot mid-window put keeps its
    // live-instance id by design until the next save re-inserts it — that
    // disclosed blind-delta window is handled by removeByDocId's tolerant
    // softDelete, PRR-006.)
    const liveMap = (instance as unknown as {
      idMapping: Map<number, { docId: string; chunkIndex: number }>;
    }).idMapping;
    for (const [id, meta] of liveMap) {
      if (meta.docId === 'doc-resolv-a' || meta.docId === 'doc-resolv-c') {
        expect(temp1.insertedIds.has(id)).toBe(true);
      }
    }

    // Behavioral consequence (PRR-006 contract): removing the re-put doc
    // must complete with every softDelete targeting an id the live index
    // holds — the faithful mock THROWS on anything else.
    await expect(instance.removeByDocId('doc-resolv-c')).resolves.toBeUndefined();
    expect(instance.hasDocEntries('doc-resolv-c')).toBe(false);
    for (const call of temp1.softDelete.mock.calls) {
      expect(temp1.insertedIds.has(call[0])).toBe(true);
    }
  });
});
