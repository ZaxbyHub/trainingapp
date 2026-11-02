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

let sharedDb: Map<string, unknown> | null = null;

function installFakeIndexedDB(): Map<string, unknown> {
  const db = new Map<string, unknown>();
  sharedDb = db;
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
  return db;
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
    const unmappedWarns: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const message = args.map(String).join(' ');
      if (message.includes('unmapped internal id')) unmappedWarns.push(message);
    });
    const hitsA = await c.search(queryFor(10), { k: 5 });
    expect(hitsA.length).toBeGreaterThanOrEqual(1);
    expect(hitsA[0]?.docId).toBe('doc-a');
    expect(hitsA[0]?.text).toBe('alpha chunk');

    const hitsB = await c.search(queryFor(20), { k: 5 });
    expect(hitsB.length).toBeGreaterThanOrEqual(1);
    expect(hitsB[0]?.docId).toBe('doc-b');
    expect(hitsB[0]?.text).toBe('beta chunk');
    // AC3 explicit: every candidate id the snapshot produced resolved to a
    // stored vector (no F11 skips).
    expect(unmappedWarns).toEqual([]);
    warnSpy.mockRestore();
    // AC3 explicit (IR-14/IR-20, mapping -> vector): every PERSISTED mapping
    // id resolves to a LIVE (non-tombstoned) vector in the persisted snapshot.
    const snapKey = [...h.snapshots.keys()][0];
    const liveSnap = h.snapshots.get(snapKey);
    const persistedMapping = (sharedDb!.get('idMapping') as { data: Array<{ id: number }> }).data;
    expect(persistedMapping.length).toBeGreaterThan(0);
    for (const item of persistedMapping) {
      expect(liveSnap?.get(item.id)?.deleted).toBe(false);
    }
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

    // IR-20 strict form: the superseded old chunk's mapping row is gone and
    // every persisted mapping entry points at a live vector — a mutant that
    // keeps a superseded chunk's mapping row fails here.
    const snapKey2 = [...h.snapshots.keys()][0];
    const snap2 = h.snapshots.get(snapKey2);
    const mapping2 = (sharedDb!.get('idMapping') as {
      data: Array<{ id: number; docId: string; text?: string }>;
    }).data;
    expect(mapping2.some((item) => item.text === 'old chunk text')).toBe(false);
    for (const item of mapping2) {
      expect(snap2?.get(item.id)?.deleted).toBe(false);
    }
  });

  it('mapping row without a snapshot is not retained (AC3 every-id-resolves)', async () => {
    // Seed a REAL ghost mapping row (unique id + docId, so a mutant carrying
    // it forward keeps a visible dangling entry) plus a version row, with NO
    // persisted snapshot. The merge must treat the missing snapshot as an
    // empty baseline and drop the ghost.
    const db = installFakeIndexedDB();
    db.set('idMapping', {
      key: 'idMapping',
      data: [{ id: 99, docId: 'ghost-doc', chunkIndex: 0, text: 'ghost text' }],
    });
    db.set('version', { key: 'version', version: 3 });

    const idx = await freshIndex();
    await idx.addBatch([entry('doc-real', 0, 'real chunk', 50)]);
    await idx.save();

    // The persisted mapping row holds ONLY the real doc's entry: the ghost
    // was dropped with the missing snapshot (every mapping id resolves).
    const persisted = db.get('idMapping') as { data: Array<{ docId: string }> };
    expect(persisted.data.some((item) => item.docId === 'ghost-doc')).toBe(false);
    expect(persisted.data.some((item) => item.docId === 'doc-real')).toBe(true);
  });

  it('a remove op REMOVES: saved chunks vanish after removeByDocId + save (IR-12 floor)', async () => {
    const a = await freshIndex();
    await a.addBatch([entry('doc-r', 0, 'x chunk', 70)]);
    await a.save();

    // Remove through the change log (the delete/terminal-purge path).
    a.removeByDocId('doc-r');
    await a.save();

    const c = await freshIndex();
    const hits = await c.search(queryFor(70), { k: 4 });
    expect(hits).toEqual([]); // IR-12: a remove op removes nothing was the defect

    // And the persisted mapping holds no entry for the removed doc.
    const persisted = (sharedDb!.get('idMapping') as { data: Array<{ docId: string }> }).data;
    expect(persisted.some((item) => item.docId === 'doc-r')).toBe(false);
  });

  it('remove-then-reput with fewer chunks leaves no stale trailing chunk (IR-12 floor 2)', async () => {
    const a = await freshIndex();
    await a.addBatch([
      entry('doc-t', 0, 'old one', 71),
      entry('doc-t', 1, 'old two', 72),
    ]);
    await a.save();

    // removeByDocId then re-add only chunk 0: chunk 1 must not survive.
    a.removeByDocId('doc-t');
    await a.addBatch([entry('doc-t', 0, 'new one', 73)]);
    await a.save();

    const c = await freshIndex();
    const stale = await c.search(queryFor(72), { k: 4 });
    expect(stale.find((r) => r.text === 'old two')).toBeUndefined();

    const fresh = await c.search(queryFor(73), { k: 4 });
    expect(fresh[0]?.text).toBe('new one');
  });

  it('same-tab incremental re-put carries saved chunks AND adds new ones (IR-1 floor)', async () => {
    const a = await freshIndex();
    await a.addBatch([entry('doc-x', 0, 'first chunk text', 60)]);
    await a.save();

    // A fresh instance boot-loads doc-x (entries WITHOUT retained raw
    // vectors), then re-puts the same docId with an additional chunk.
    const b = await freshIndex();
    await b.addBatch([entry('doc-x', 1, 'second chunk text', 61)]);
    await b.save();

    const c = await freshIndex();
    const first = await c.search(queryFor(60), { k: 4 });
    expect(first[0]?.text).toBe('first chunk text'); // carried, not dangling

    const second = await c.search(queryFor(61), { k: 4 });
    expect(second[0]?.text).toBe('second chunk text');
  });
});
