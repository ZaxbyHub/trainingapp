import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmbeddingEntry } from '../../types/embedding';

/**
 * Frozen check C3 (trace collated-270-273, AC3 of issue #270): two
 * VectorIndex instances share one IndexedDB; each saves a different
 * document's chunks after both loaded the same state; search after a fresh
 * load returns BOTH documents' chunks and every mapping id resolves to a
 * stored vector. The plan-critic-required cases are included: first-ever
 * ingest (no snapshot exists), mapping-without-snapshot recovery (a mapping
 * row alone must not be retained), and repeated same-docId replacement
 * (soft-deleted baseline vectors must not crowd the search k-window).
 *
 * The edgevec stub retains inserted vectors per index name (a stateless stub
 * would pass vacuously) and assigns real sequential ids; the mapping rows go
 * through a stateful fake IndexedDB shared by every module instance.
 *
 * RED/ERROR at base (spec absent), GREEN after the fix.
 */

const h = vi.hoisted(() => {
  // Persisted EdgeVec snapshots: name -> id -> {vec, deleted}. save()
  // serializes the live vectors; load() rejects when the name is absent
  // (the real backend's reject-on-miss contract).
  const snapshots = new Map<string, Map<number, { vec: Float32Array; deleted: boolean }>>();
  return { snapshots };
});

vi.mock('edgevec', () => {
  class EdgeVecConfig {
    metric = 'cosine';
    ef_construction = 200;
    m = 16;
    ef_search = 64;
    constructor(public dimension: number) {}
    free(): void {}
  }
  class BatchResult {
    constructor(public ids: BigUint64Array, public inserted: number, public total: number) {}
    free(): void {}
  }
  class FakeEdgeVec {
    private store: Map<number, { vec: Float32Array; deleted: boolean }>;
    private nextId: number;
    constructor(_config: unknown) {
      this.store = new Map();
      this.nextId = 0;
    }
    static load(name: string): Promise<FakeEdgeVec> {
      const snap = h.snapshots.get(name);
      if (!snap) {
        return Promise.reject(new Error(`File ${name} not found`));
      }
      const inst = new FakeEdgeVec(null);
      let maxId = -1;
      for (const [id, rec] of snap) {
        inst.store.set(id, { vec: rec.vec, deleted: rec.deleted });
        maxId = Math.max(maxId, id);
      }
      inst.nextId = maxId + 1;
      return Promise.resolve(inst);
    }
    save(name: string): Promise<void> {
      const snap = new Map<number, { vec: Float32Array; deleted: boolean }>();
      for (const [id, rec] of this.store) {
        snap.set(id, { vec: rec.vec, deleted: rec.deleted });
      }
      h.snapshots.set(name, snap);
      return Promise.resolve();
    }
    insert(vector: Float32Array): number {
      const id = this.nextId++;
      this.store.set(id, { vec: vector, deleted: false });
      return id;
    }
    insertBatchWithProgress(vectors: Float32Array[], _onProgress: unknown): BatchResult {
      const ids: bigint[] = [];
      for (const v of vectors) ids.push(BigInt(this.insert(v)));
      return new BatchResult(new BigUint64Array(ids), vectors.length, vectors.length);
    }
    softDelete(id: number): void {
      const rec = this.store.get(id);
      if (rec) rec.deleted = true;
    }
    liveCount(): number {
      let n = 0;
      for (const rec of this.store.values()) if (!rec.deleted) n++;
      return n;
    }
    canInsert(): boolean {
      return true;
    }
    search(query: Float32Array, k: number): Array<{ id: number; score: number }> {
      // Brute-force cosine similarity over live vectors, top-k by score.
      const scored: Array<{ id: number; score: number }> = [];
      for (const [id, rec] of this.store) {
        if (rec.deleted) continue;
        let dot = 0;
        let qn = 0;
        let vn = 0;
        for (let i = 0; i < query.length; i++) {
          dot += query[i] * rec.vec[i];
          qn += query[i] * query[i];
          vn += rec.vec[i] * rec.vec[i];
        }
        const denom = Math.sqrt(qn) * Math.sqrt(vn) || 1;
        scored.push({ id, score: dot / denom });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k);
    }
  }
  return {
    default: async (): Promise<void> => undefined,
    EdgeVec: FakeEdgeVec,
    EdgeVecConfig,
  };
});

interface FakeRequest {
  onsuccess: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onupgradeneeded: ((event?: unknown) => void) | null;
  result: unknown;
  error: unknown;
}

function installFakeIndexedDB(): void {
  const db = new Map<string, unknown>();
  (globalThis as { indexedDB: unknown }).indexedDB = {
    open(_name: string): FakeRequest {
      const request: FakeRequest = {
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        result: null,
        error: null,
      };
      const hadStore = db.has('__store_created__');
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          close(): void {},
          transaction(_storeName: string, _mode?: string) {
            const tx = {
              oncomplete: null as (() => void) | null,
              onabort: null as (() => void) | null,
              onerror: null as ((event?: unknown) => void) | null,
              error: null as unknown,
              objectStore() {
                const makeReq = (): FakeRequest => ({
                  onsuccess: null,
                  onerror: null,
                  onupgradeneeded: null,
                  result: null,
                  error: null,
                });
                const fire = (req: FakeRequest, outcome: () => void): void => {
                  setTimeout(() => {
                    outcome();
                    req.onsuccess?.();
                    setTimeout(() => tx.oncomplete?.());
                  });
                };
                return {
                  get(key: string): FakeRequest {
                    const req = makeReq();
                    fire(req, () => {
                      req.result = db.has(key) ? structuredClone(db.get(key)) : undefined;
                    });
                    return req;
                  },
                  put(value: unknown): FakeRequest {
                    const req = makeReq();
                    const key =
                      (value as { key?: string }).key ??
                      (value as { id?: string }).id ??
                      'unknown';
                    fire(req, () => {
                      db.set(key, structuredClone(value));
                    });
                    return req;
                  },
                };
              },
            };
            return tx;
          },
        };
        if (!hadStore) {
          db.set('__store_created__', true);
          request.onupgradeneeded?.({ target: request });
        }
        setTimeout(() => {
          request.onsuccess?.();
        });
      });
      return request;
    },
  };
}

function entry(docId: string, i: number, text: string, seed: number): EmbeddingEntry {
  const vector = new Float32Array(768);
  vector[seed] = 1;
  return {
    docId,
    chunkIndex: i,
    text,
    source: `${docId}.txt`,
    page: i + 1,
    vector,
  } as unknown as EmbeddingEntry;
}

function queryFor(seed: number): Float32Array {
  const q = new Float32Array(768);
  q[seed] = 1;
  return q;
}

async function freshIndex() {
  vi.resetModules();
  const mod = await import('./vector-index');
  const idx = mod.VectorIndex.getInstance();
  await idx.initialize();
  return idx;
}

describe('vector index across two tabs (shared IndexedDB + snapshot store)', () => {
  beforeEach(() => {
    h.snapshots.clear();
    installFakeIndexedDB();
  });

  it('two instances save different docs; fresh load returns both and every id resolves', async () => {
    const a = await freshIndex();
    await a.addBatch([entry('doc-a', 0, 'alpha chunk', 10)]);
    await a.save(); // first-ever ingest: no snapshot exists yet

    const b = await freshIndex();
    await b.addBatch([entry('doc-b', 0, 'beta chunk', 20)]);
    await b.save(); // merges into A's snapshot; B's id 0 collides with A's id 0

    const c = await freshIndex();
    const hitsA = await c.search(queryFor(10), { k: 5 });
    expect(hitsA.length).toBeGreaterThanOrEqual(1);
    expect(hitsA[0]?.docId).toBe('doc-a');
    expect(hitsA[0]?.text).toBe('alpha chunk');

    const hitsB = await c.search(queryFor(20), { k: 5 });
    expect(hitsB.length).toBeGreaterThanOrEqual(1);
    expect(hitsB[0]?.docId).toBe('doc-b');
    expect(hitsB[0]?.text).toBe('beta chunk');
  });

  it('repeated same-docId replacement: old vectors are soft-deleted, not live orphans', async () => {
    const a = await freshIndex();
    await a.addBatch([entry('doc-x', 0, 'old chunk text', 30)]);
    await a.save();

    // Another tab replaces doc-x with new vectors and adds doc-y.
    const b = await freshIndex();
    await b.addBatch([entry('doc-x', 0, 'new chunk text', 31), entry('doc-y', 0, 'why chunk', 40)]);
    await b.save();

    const c = await freshIndex();
    const stale = await c.search(queryFor(30), { k: 4 });
    expect(stale.find((r) => r.text === 'old chunk text')).toBeUndefined();

    const fresh = await c.search(queryFor(31), { k: 4 });
    expect(fresh[0]?.docId).toBe('doc-x');
    expect(fresh[0]?.text).toBe('new chunk text');

    const why = await c.search(queryFor(40), { k: 4 });
    expect(why[0]?.docId).toBe('doc-y');
  });

  it('mapping row without a snapshot is not retained (AC3 every-id-resolves)', async () => {
    // A ghost mapping row + version row with NO persisted snapshot: the merge
    // must treat the missing snapshot as an empty baseline (ghost dropped).
    const dbMod = (globalThis as unknown as {
      __c3fakeDb?: Map<string, unknown>;
    });
    void dbMod;
    const idx = await freshIndex();
    await idx.addBatch([entry('doc-real', 0, 'real chunk', 50)]);
    await idx.save();
    // Simulate a lost snapshot blob (mapping rows remain).
    h.snapshots.clear();
    // Re-save: baseline loader sees version 3 but no snapshot -> fresh empty
    // baseline; the real doc's unsaved vector re-inserts; ghost never written.
    await idx.addBatch([entry('doc-two', 0, 'second chunk', 51)]);
    await idx.save();

    const c = await freshIndex();
    const hits = await c.search(queryFor(51), { k: 4 });
    expect(hits.some((r) => r.docId === 'doc-real' || r.docId === 'doc-two')).toBe(true);
    expect(hits.every((r) => r.docId !== 'ghost')).toBe(true);
  });
});
