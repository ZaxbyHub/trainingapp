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

/** Fake BroadcastChannel with deterministic same-tab delivery to EVERY
 * instance of the name (including the sender - createStoreChannel's sender-id
 * stamp filters self-echoes, exactly like production). */
function installLinkedBroadcastChannel(): void {
  const channels: Array<{ name: string; onmessage: ((event: MessageEvent) => void) | null }> = [];
  class FakeChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(readonly name: string) {
      channels.push(this);
    }
    postMessage(message: unknown): void {
      for (const other of channels) {
        if (other.name === this.name) {
          other.onmessage?.({ data: message } as unknown as MessageEvent);
        }
      }
    }
    close(): void {
      /* noop */
    }
  }
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel;
}


describe('keyword index across two tabs (shared IndexedDB)', () => {
  beforeEach(() => {
    vi.resetModules();
    installSharedFakeIndexedDB();
    installLinkedBroadcastChannel();
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

  it('a remote save rebuilds this tab live search state (PRR-004)', async () => {
    // Tab A: initialized and subscribed, nothing of its own pending - the
    // refresh guard lets the reload run.
    const A = await import('./keyword-index');
    const a = A.getKeywordIndex();
    await a.initialize();

    vi.resetModules();
    const B = await import('./keyword-index');
    const b = B.getKeywordIndex();
    await b.initialize();
    b.addDocuments([chunk('doc-b', 0, 'beta document text')]);
    await b.save(); // posts the change to every channel instance

    // The refresh rebuild runs async on the fake IDB's macrotask chains —
    // poll until it lands.
    let hits = a.search('beta');
    const deadline = Date.now() + 2000;
    while (hits.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      hits = a.search('beta');
    }
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.docId).toBe('doc-b');
    expect(hits[0]?.text).toContain('beta document text');
  });

  it('a tab with unsaved local ops does NOT reload on a remote change (PRR-004 guard)', async () => {
    const A = await import('./keyword-index');
    const a = A.getKeywordIndex();
    await a.initialize();
    a.addDocuments([chunk('doc-a', 0, 'local unsaved text')]); // pendingOps non-empty

    vi.resetModules();
    const B = await import('./keyword-index');
    const b = B.getKeywordIndex();
    await b.initialize();
    b.addDocuments([chunk('doc-b', 0, 'remote beta text')]);
    await b.save();

    // Absence can only be time-bounded: watch a window comfortably beyond
    // the observed refresh latency (a broken guard would surface doc-b
    // within it).
    const deadline = Date.now() + 600;
    let hits = a.search('beta');
    while (hits.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      hits = a.search('beta');
    }

    // No refresh: a never sees doc-b...
    expect(hits).toEqual([]);
    // ...and its own unsaved doc is intact (a refresh would have wiped it).
    expect(a.search('local').length).toBeGreaterThanOrEqual(1);
  });

  it('the saving tab folds the merged baseline into its live search state (PRR-004 4(a))', async () => {
    const A = await import('./keyword-index');
    const a = A.getKeywordIndex();
    await a.initialize();

    vi.resetModules();
    const B = await import('./keyword-index');
    const b = B.getKeywordIndex();
    await b.initialize(); // both tabs boot EMPTY

    // B takes a local op FIRST so its pendingOps guard blocks A's
    // announcement — the concurrent-ingest ordering the finding names. B then
    // saves: the merge persists A's doc-a + B's doc-b, but B's own
    // announcement is self-filtered, so only the save-time rebuild can put
    // doc-a into B's live FlexSearch.
    b.addDocuments([chunk('doc-b', 0, 'beta document text')]);
    a.addDocuments([chunk('doc-a', 0, 'alpha document text')]);
    await a.save(); // posts; B skips (pendingOps non-empty)
    await b.save(); // merge: baseline doc-a + local doc-b

    const hits = b.search('alpha');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.docId).toBe('doc-a');
    // its own doc is still served after the rebuild
    expect(b.search('beta').length).toBeGreaterThanOrEqual(1);
  });

  it('remote refreshes are serialized: a burst never runs two loads concurrently (PRR-004)', async () => {
    const A = await import('./keyword-index');
    const a = A.getKeywordIndex();
    await a.initialize();

    // Hold every load open so a second announcement arriving mid-load would
    // overlap unless the refresh is single-flight with a queued trailing run.
    let concurrent = 0;
    let maxConcurrent = 0;
    const wrapped = a as unknown as { load: () => Promise<boolean> };
    const origLoad = wrapped.load.bind(a);
    wrapped.load = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 120));
      try {
        return await origLoad();
      } finally {
        concurrent -= 1;
      }
    };

    vi.resetModules();
    const B = await import('./keyword-index');
    const b = B.getKeywordIndex();
    await b.initialize();
    b.addDocuments([chunk('doc-b1', 0, 'first remote text')]);
    await b.save(); // announcement 1 opens a's refresh (held by the wrap)
    b.addDocuments([chunk('doc-b2', 0, 'second remote text')]);
    await b.save(); // announcement 2 must queue, not start a second load

    // Drain: the queued trailing run must apply the second announcement.
    const deadline = Date.now() + 3000;
    let hits = a.search('second');
    while (hits.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      hits = a.search('second');
    }
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.docId).toBe('doc-b2');
    expect(maxConcurrent).toBe(1);
  });
});
