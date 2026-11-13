/**
 * Production load() wiring spec (issue #325 AC2).
 *
 * The production path load() -> loadFromIDB() -> rebuildFromEntries(data.entries)
 * is what serves persisted entries to real users, but no spec drove it: the
 * normalization spec calls rebuildFromEntries directly, and the vector twin's
 * spec drives its production load(). This spec drives the REAL load() against
 * a stateful fake IndexedDB seeded through the production save(), then
 * asserts the persisted entries reach the live serving state through the
 * real wiring. Discriminating: deleting the `this.rebuildFromEntries(data.entries)`
 * line in load() turns the reload leg RED (the persisted entries never reach
 * the serving state).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KeywordIndex } from './keyword-index';

/** Stateful fake IndexedDB (rows survive across `open` calls within a test),
 *  copied from the mid-save spec's pattern so save/load observe one corpus. */
function makeStatefulIdb() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    open: vi.fn().mockImplementation(() => {
      const db = {
        objectStoreNames: { contains: (n: string) => n === 'keyword-index' },
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

describe('KeywordIndex production load() wiring (issue #325 AC2)', () => {
  let idb: ReturnType<typeof makeStatefulIdb>;

  beforeEach(() => {
    vi.clearAllMocks();
    (KeywordIndex as unknown as { instance: KeywordIndex | null }).instance = null;
    idb = makeStatefulIdb();
    (globalThis as { indexedDB?: unknown }).indexedDB = idb;
  });

  afterEach(() => {
    try {
      KeywordIndex.getInstance().dispose();
    } catch {
      /* ignore */
    }
    try {
      (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    } catch {
      /* ignore */
    }
  });

  it('drives the production load() path: persisted entries reach rebuildFromEntries and serve', async () => {
    // Seed the persisted corpus through the PRODUCTION save() path (not by
    // hand-building the StoredData blob), so the spec exercises real writers.
    const writer = KeywordIndex.getInstance();
    await writer.initialize();
    writer.addDocument('doc-wire', 0, 'quirky zebra mandate');
    writer.addDocument('doc-wire', 1, 'alpha bravo charlie');
    await writer.save();
    expect(idb.rows.has('data')).toBe(true);
    writer.dispose();
    (KeywordIndex as unknown as { instance: KeywordIndex | null }).instance = null;

    // Fresh instance: drive the REAL load() end-to-end.
    const reader = KeywordIndex.getInstance();
    await reader.initialize();
    const loaded = await reader.load();
    expect(loaded).toBe(true);

    // The persisted entries must reach the LIVE SERVING STATE through the
    // real wiring — asserted against the public search surface, not
    // internals. If the rebuildFromEntries(data.entries) call inside load()
    // is deleted, the fresh FlexSearch index stays empty and both hits
    // disappear (the load still resolves true).
    const zebra = reader.search('zebra');
    expect(zebra.some((hit) => hit.docId === 'doc-wire' && hit.chunkIndex === 0)).toBe(true);
    const alpha = reader.search('alpha');
    expect(alpha.some((hit) => hit.docId === 'doc-wire' && hit.chunkIndex === 1)).toBe(true);
    expect(reader.size()).toBe(2);
  });

  it('load() with an empty store resolves false and serves nothing', async () => {
    const instance = KeywordIndex.getInstance();
    await instance.initialize();
    const loaded = await instance.load();
    expect(loaded).toBe(false);
    expect(instance.size()).toBe(0);
  });
});
