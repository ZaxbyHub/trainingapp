import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentChunk } from '../../types/document';

/**
 * Frozen check C2 (trace collated-270-273, AC2 of issue #270): two
 * KeywordIndex instances (a "tab" is vi.resetModules() plus a fresh dynamic
 * import) share one IndexedDB; each adds and saves a different document's
 * chunks after both loaded the same state; a fresh load returns BOTH
 * documents' chunks with their text and citation/pack metadata (PC-11: the
 * entries payload is what carries text — presence of docIds alone is not
 * proof). Also holds the removal case: tab A removes document X while tab B
 * adds document Y; after a fresh load X is absent and Y is present (a plain
 * union merge would resurrect X; the change-log merge must not).
 *
 * RED/ERROR at base (spec absent), GREEN after the fix.
 */

interface FakeRequest {
  onsuccess: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onupgradeneeded: ((event?: unknown) => void) | null;
  result: unknown;
  error: unknown;
}

/** Stateful IndexedDB fake: one store keyed by `key`, values under id/key. */
function installSharedFakeIndexedDB(): Map<string, Map<string, unknown>> {
  const databases = new Map<string, Map<string, unknown>>();
  const getDb = (name: string) => {
    let d = databases.get(name);
    if (!d) {
      d = new Map();
      databases.set(name, d);
    }
    return d;
  };

  (globalThis as { indexedDB: unknown }).indexedDB = {
    open(name: string): FakeRequest {
      const db = getDb(name);
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
          close(): void {
            /* noop */
          },
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
                    const k =
                      (value as { key?: string }).key ??
                      (value as { id?: string }).id ??
                      JSON.stringify(value);
                    fire(req, () => {
                      db.set(k, structuredClone(value));
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
  return databases;
}

function chunk(docId: string, i: number, text: string): DocumentChunk {
  return { docId, chunkIndex: i, text, source: `${docId}.txt`, page: i + 1 } as DocumentChunk;
}

describe('keyword index across two tabs (shared IndexedDB)', () => {
  beforeEach(() => {
    vi.resetModules();
    installSharedFakeIndexedDB();
  });

  it('two instances save different documents; a fresh load returns both with metadata', async () => {
    const A = await import('./keyword-index');
    const a = A.getKeywordIndex();
    await a.initialize();
    a.addDocuments([chunk('doc-a', 0, 'alpha document text'), chunk('doc-a', 1, 'more alpha')]);
    await a.save();

    // A genuinely separate tab: fresh module registry -> fresh singleton.
    vi.resetModules();
    const B = await import('./keyword-index');
    const b = B.getKeywordIndex();
    await b.initialize(); // loads A's persisted entries (fresh baseline read)
    b.addDocuments([chunk('doc-b', 0, 'beta document text')]);
    await b.save();

    // Fresh tab: loads the merged persisted state.
    vi.resetModules();
    const C = await import('./keyword-index');
    const c = C.getKeywordIndex();
    await c.initialize();

    const hitsA = c.search('alpha');
    expect(hitsA.length).toBeGreaterThanOrEqual(1);
    expect(hitsA[0]?.docId).toBe('doc-a');
    expect(hitsA[0]?.text).toContain('alpha document text');
    expect(hitsA[0]?.source).toBe('doc-a.txt');

    const hitsB = c.search('beta');
    expect(hitsB.length).toBeGreaterThanOrEqual(1);
    expect(hitsB[0]?.docId).toBe('doc-b');
    expect(hitsB[0]?.text).toContain('beta document text');
  });

  it('A removes X while B adds Y; fresh load has Y and NOT X (no resurrection)', async () => {
    const A = await import('./keyword-index');
    const a = A.getKeywordIndex();
    await a.initialize();
    a.addDocuments([chunk('doc-x', 0, 'xray document text')]);
    await a.save();

    vi.resetModules();
    const B = await import('./keyword-index');
    const b = B.getKeywordIndex();
    await b.initialize(); // sees X
    b.addDocuments([chunk('doc-y', 0, 'yankee document text')]);
    await b.save(); // baseline X kept + Y put

    // Stale A removes X (its log records remove) and saves. Its in-memory
    // state knows only X, but the merge reads the FRESH baseline (X+Y).
    a.removeByDocId('doc-x');
    await a.save(); // fresh baseline = X+Y; drop X; keep Y

    vi.resetModules();
    const C = await import('./keyword-index');
    const c = C.getKeywordIndex();
    await c.initialize();
    expect(c.search('xray')).toEqual([]);
    expect(c.search('yankee').length).toBeGreaterThanOrEqual(1);
  });
});
