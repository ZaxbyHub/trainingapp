import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Frozen check C16 (trace collated-270-273, AC9 of issue #273): index save
 * rejections carry the raw error identity as `cause` (e.g. a
 * QuotaExceededError DOMException, flattened to a string before) and never
 * stay pending when the transaction aborts (no onabort handler before).
 * Covers both persisted stores: vector-index saveMapping and keyword-index
 * persistToIDB.
 *
 * RED/ERROR at base (spec absent), GREEN after the fix.
 */

const h = vi.hoisted(() => {
  return {
    failMode: 'none' as 'none' | 'error' | 'abort' | 'get-error',
    failSnapshot: false,
  };
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
  class MinimalEdgeVec {
    private store = new Map<number, Float32Array>();
    private nextId = 0;
    constructor(_config: unknown) {}
    static load(name: string): Promise<MinimalEdgeVec> {
      return Promise.reject(new Error(`File ${name} not found`));
    }
    save(_name: string): Promise<void> {
      if (h.failSnapshot) {
        // PRR-007 injection: the SNAPSHOT write fails AFTER the merged
        // mapping row already committed (F11 order).
        return Promise.reject(new Error('simulated snapshot write failure'));
      }
      return Promise.resolve();
    }
    insert(v: Float32Array): number {
      const id = this.nextId++;
      this.store.set(id, v);
      return id;
    }
    insertBatchWithProgress(vectors: Float32Array[], _p: unknown) {
      const ids = vectors.map((v) => BigInt(this.insert(v)));
      return {
        ids: new BigUint64Array(ids),
        inserted: vectors.length,
        total: vectors.length,
        free(): void {},
      };
    }
    softDelete(_id: number): void {}
    liveCount(): number {
      return this.store.size;
    }
    canInsert(): boolean {
      return true;
    }
    search(_q: Float32Array, _k: number): Array<{ id: number; score: number }> {
      return [];
    }
  }
  return { default: async (): Promise<void> => undefined, EdgeVec: MinimalEdgeVec, EdgeVecConfig };
});

interface FakeRequest {
  onsuccess: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onupgradeneeded: ((event?: unknown) => void) | null;
  result: unknown;
  error: unknown;
}

/** Fake IndexedDB whose write transactions fail or abort on demand. */
let testDb: Map<string, unknown> | null = null;

function installFailModeIndexedDB(): Map<string, unknown> {
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
                return {
                  get(key: string): FakeRequest {
                    const req = makeReq();
                    setTimeout(() => {
                      if (h.failMode === 'get-error') {
                        // Reads fail, writes still succeed: the exact
                        // transient-read-failure window PRR-003 names.
                        req.error = new DOMException('simulated read failure', 'UnknownError');
                        req.onerror?.();
                        return;
                      }
                      req.result = db.has(key) ? structuredClone(db.get(key)) : undefined;
                      req.onsuccess?.();
                    });
                    return req;
                  },
                  put(value: unknown): FakeRequest {
                    const req = makeReq();
                    const key =
                      (value as { key?: string }).key ??
                      (value as { id?: string }).id ??
                      'unknown';
                    setTimeout(() => {
                      if (h.failMode === 'error') {
                        tx.error = new DOMException('quota exceeded', 'QuotaExceededError');
                        req.onerror?.();
                        tx.onerror?.();
                        return;
                      }
                      if (h.failMode === 'abort') {
                        tx.error = new DOMException('aborted: quota', 'QuotaExceededError');
                        req.onsuccess?.();
                        tx.onabort?.();
                        return;
                      }
                      db.set(key, structuredClone(value));
                      req.onsuccess?.();
                      setTimeout(() => tx.oncomplete?.());
                    });
                    return req;
                  },
                };
              },
            };
            return tx;
          },
        };
        request.onupgradeneeded?.({ target: request });
        setTimeout(() => {
          request.onsuccess?.();
        });
      });
      return request;
    },
  };
  return db;
}

describe('index save error identity (C16)', () => {
  beforeEach(() => {
    h.failMode = 'none';
    h.failSnapshot = false;
    testDb = installFailModeIndexedDB();
  });

  describe('vector-index saveMapping', () => {
    it('rejects with the raw QuotaExceededError preserved as cause', async () => {
      vi.resetModules();
      const mod = await import('./vector-index');
      const idx = mod.VectorIndex.getInstance();
      await idx.initialize();
      await idx.addBatch([
        {
          docId: 'doc-q',
          chunkIndex: 0,
          text: 'quota chunk',
          vector: new Float32Array(768).fill(0.1),
        } as never,
      ]);
      h.failMode = 'error';
      const err = await idx.save().then(
        () => {
          throw new Error('save should have rejected');
        },
        (e: unknown) => e as Error
      );
      expect(err.message).toContain('Failed to save idMapping');
      const inner = (err as Error & { cause?: Error }).cause as Error & { cause?: unknown };
      expect(inner).toBeInstanceOf(Error);
      expect(inner.message).toContain('Failed to save idMapping');
      expect(inner.cause).toBeInstanceOf(DOMException);
      expect((inner.cause as DOMException).name).toBe('QuotaExceededError');
    });

    it('rejects (never stays pending) when the transaction aborts', async () => {
      vi.resetModules();
      const mod = await import('./vector-index');
      const idx = mod.VectorIndex.getInstance();
      await idx.initialize();
      await idx.addBatch([
        {
          docId: 'doc-q2',
          chunkIndex: 0,
          text: 'abort chunk',
          vector: new Float32Array(768).fill(0.2),
        } as never,
      ]);
      h.failMode = 'abort';
      // If the promise stayed pending, this test would time out.
      const err = await idx.save().then(
        () => {
          throw new Error('save should have rejected');
        },
        (e: unknown) => e as Error
      );
      expect(String(err.message)).toContain('Failed to save idMapping');
      const inner = (err as Error & { cause?: Error }).cause as Error & { cause?: unknown };
      expect(inner.cause).toBeInstanceOf(DOMException);
    });
  });

  describe('keyword-index persistToIDB', () => {
    it('rejects with the raw QuotaExceededError preserved as cause', async () => {
      vi.resetModules();
      const mod = await import('./keyword-index');
      const idx = mod.getKeywordIndex();
      await idx.initialize();
      idx.addDocument('doc-k', 0, 'keyword quota chunk');
      h.failMode = 'error';
      const err = await idx.save().then(
        () => {
          throw new Error('save should have rejected');
        },
        (e: unknown) => e as Error
      );
      expect(err.message).toContain('Save failed');
      let cursor: unknown = err;
      let sawDomException = false;
      for (let depth = 0; depth < 5 && cursor != null; depth++) {
        // jsdom's DOMException is not `instanceof Error`: check the name
        // before descending via cause.
        if ((cursor as { name?: string }).name === 'QuotaExceededError') {
          sawDomException = true;
        }
        cursor = (cursor as Error & { cause?: unknown }).cause;
      }
      expect(sawDomException).toBe(true);
    });

    it('rejects (never stays pending) when the transaction aborts', async () => {
      vi.resetModules();
      const mod = await import('./keyword-index');
      const idx = mod.getKeywordIndex();
      await idx.initialize();
      idx.addDocument('doc-k2', 0, 'keyword abort chunk');
      h.failMode = 'abort';
      // If the promise stayed pending, this test would time out.
      const err = await idx.save().then(
        () => {
          throw new Error('save should have rejected');
        },
        (e: unknown) => e as Error
      );
      expect(err.message).toContain('Save failed');
      let cursor: unknown = err;
      let sawDomException = false;
      for (let depth = 0; depth < 5 && cursor != null; depth++) {
        if ((cursor as { name?: string }).name === 'QuotaExceededError') {
          sawDomException = true;
        }
        cursor = (cursor as Error & { cause?: unknown }).cause;
      }
      expect(sawDomException).toBe(true);
    });
  });

  it('a transient baseline READ failure fails the save closed and never overwrites the corpus (PRR-003)', async () => {
    // Seed a prior corpus the merge must NOT clobber. Reads (get) fail while
    // writes (put) succeed — the transient-read-failure window the finding
    // names; the pre-fix code resolved the failure as "empty baseline" and
    // overwrote the seeded mapping with only the pending op (silent
    // truncation of every other doc).
    const db = testDb as Map<string, unknown>;
    db.set('idMapping', {
      key: 'idMapping',
      data: [{ id: 7, docId: 'doc-old', chunkIndex: 0, text: 'old chunk' }],
    });
    db.set('version', { key: 'version', version: 3 });
    h.failMode = 'get-error';

    vi.resetModules();
    const mod = await import('./vector-index');
    const idx = mod.VectorIndex.getInstance();
    await idx.initialize();
    await idx.addBatch([
      {
        docId: 'doc-new',
        chunkIndex: 0,
        vector: new Float32Array(768).fill(0.3),
        text: 'new chunk',
      } as never,
    ]);

    // Fail closed: the read failure surfaces as a save rejection...
    const err = await idx.save().then(
      () => {
        throw new Error('save should have rejected');
      },
      (e: unknown) => e as Error
    );
    expect(String(err.message)).toContain('Save failed');

    // ...and no truncating write happened: the seeded corpus is untouched.
    const row = db.get('idMapping') as { data: Array<{ docId: string }> };
    expect(row.data.map((d) => d.docId)).toEqual(['doc-old']);
    expect(db.get('version')).toEqual({ key: 'version', version: 3 });
  });

  it('a SNAPSHOT write failure rolls the persisted row back to the snapshot-paired baseline (PRR-007)', async () => {
    // Save #1 commits the row for doc-new. The second save of the SAME chunk
    // inserts a replacement and commits the MERGED row before the snapshot
    // write (F11). When the snapshot write then fails, the persisted row must
    // be rewritten to the baseline the still-persisted snapshot represents
    // (this fake never persists a snapshot, so the baseline is empty) — not
    // left holding the merged write (pre-fix) nor rolled back to the
    // in-memory map, which still carries the not-yet-persisted replacement.
    vi.resetModules();
    const mod = await import('./vector-index');
    const idx = mod.VectorIndex.getInstance();
    await idx.initialize();
    await idx.addBatch([
      {
        docId: 'doc-new',
        chunkIndex: 0,
        vector: new Float32Array(768).fill(0.3),
        text: 'new chunk',
      } as never,
    ]);
    await idx.save(); // row: [doc-new] + version

    await idx.addBatch([
      {
        docId: 'doc-new',
        chunkIndex: 0,
        vector: new Float32Array(768).fill(0.4),
        text: 'new chunk v2',
      } as never,
    ]);
    h.failSnapshot = true;
    const err = await idx.save().then(
      () => {
        throw new Error('save should have rejected');
      },
      (e: unknown) => e as Error
    );
    expect(String(err.message)).toContain('Save failed');
    h.failSnapshot = false;

    const row = testDb!.get('idMapping') as { data: Array<{ docId: string }> } | undefined;
    expect((row?.data ?? []).map((d) => d.docId)).toEqual([]);
  });
});
