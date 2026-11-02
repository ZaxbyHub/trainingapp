import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentEntry } from '../../types/document';

/**
 * Frozen check C1 (trace collated-270-273, AC1 of issue #270): two tabs share
 * one IndexedDB (a "tab" is vi.resetModules() plus a fresh dynamic import,
 * both imports sharing one globalThis.indexedDB — the stateful in-test fake
 * below). A stale tab's save must not wipe a document another tab added, and
 * the per-document production path (upsertDocument/deleteDocument) preserves
 * deletions against stale writes.
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

interface FakeTx {
  oncomplete: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
  objectStore(): {
    getAll(): FakeRequest;
    put(value: unknown): FakeRequest;
    delete(key: string): FakeRequest;
  };
}

/**
 * Minimal stateful IndexedDB fake shared by every module instance in the
 * test. Events fire on the macrotask queue (FIFO), so a transaction's
 * oncomplete fires after the request handlers set during the same
 * synchronous block — the ordering the store code relies on.
 */
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
          // The upgrade handler reads `objectStoreNames` off this object; the
          // fake store is implicit, so every name "exists".
          objectStoreNames: { contains: () => true },
          transaction(_storeName: string, _mode?: string): FakeTx {
            const tx: FakeTx = {
              oncomplete: null,
              onerror: null,
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
                  getAll(): FakeRequest {
                    const req = makeReq();
                    fire(req, () => {
                      req.result = [...db.entries()]
                        .filter(([k]) => k !== '__store_created__')
                        .map(([, v]) => structuredClone(v));
                    });
                    return req;
                  },
                  put(value: unknown): FakeRequest {
                    const req = makeReq();
                    const key = (value as { id?: string }).id ?? JSON.stringify(value);
                    fire(req, () => {
                      db.set(key, structuredClone(value));
                    });
                    return req;
                  },
                  delete(key: string): FakeRequest {
                    const req = makeReq();
                    fire(req, () => {
                      db.delete(key);
                    });
                    return req;
                  },
                };
              },
            };
            return tx;
          },
        };
        // Real IDB fires onupgradeneeded with the REQUEST itself as the event
        // target (its .result is the upgrading db), before onsuccess.
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

function makeDoc(id: string, fileName: string): DocumentEntry {
  return {
    id,
    fileName,
    fileType: 'txt',
    fileSize: 10,
    uploadedAt: Date.now(),
    status: 'ready',
    text: `content of ${fileName}`,
  } as unknown as DocumentEntry;
}

describe('document store across two tabs (shared IndexedDB)', () => {
  beforeEach(() => {
    vi.resetModules();
    installSharedFakeIndexedDB();
  });

  it('two shared-IDB tabs, both documents survive a later save by the stale tab', async () => {
    const A = await import('./document-store');
    const docA = makeDoc('doc-a', 'a.txt');
    await A.saveDocuments([docA]);

    const B = await import('./document-store');
    const docB = makeDoc('doc-b', 'b.txt');
    await B.saveDocuments([docB]);

    // A fresh load sees both documents.
    const C = await import('./document-store');
    const docs = await C.loadDocuments();
    const names = docs.map((d) => d.fileName).sort();
    expect(names).toEqual(['a.txt', 'b.txt']);
  });

  it('a stale whole-list save does not delete rows it does not contain (addition-only semantics)', async () => {
    const A = await import('./document-store');
    await A.saveDocuments([makeDoc('doc-a', 'a.txt')]);

    const B = await import('./document-store');
    await B.saveDocuments([makeDoc('doc-b', 'b.txt')]);

    // A's list is now stale (holds only doc-a); its debounced save must not
    // delete B's doc-b.
    await A.saveDocuments([makeDoc('doc-a', 'a.txt')]);

    const C = await import('./document-store');
    const docs = await C.loadDocuments();
    expect(docs.map((d) => d.fileName).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('production deletion survives a stale per-doc add (deleteDocument then upsertDocument)', async () => {
    const A = await import('./document-store');
    await A.saveDocuments([makeDoc('doc-x', 'x.txt')]);

    // B's instance starts with its own snapshot containing X and Y.
    const B = await import('./document-store');
    await B.saveDocuments([makeDoc('doc-x', 'x.txt'), makeDoc('doc-y', 'y.txt')]);

    // A deletes X through the production path; stale B then per-doc upserts
    // Y (never X). Deletion and addition must both survive.
    await A.deleteDocument('doc-x');
    await B.upsertDocument(makeDoc('doc-y', 'y.txt'));

    const C = await import('./document-store');
    const docs = await C.loadDocuments();
    expect(docs.map((d) => d.fileName).sort()).toEqual(['y.txt']);
  });
});
