/**
 * Frozen check C5 (trace collated-275-268, AC5 of issue #275).
 *
 * A keyword mutation landing while a save()'s merge is in flight must keep
 * serving after that save completes and be persisted by the NEXT save (the
 * `stillPending` rebuild branch of keyword-index.ts's save, the surviving
 * sibling of the vector merge's swap).
 *
 * Discriminating timing: the mutation lands on a docId that is ALREADY in
 * the save's snapshot, DURING the persist await (after `merged` was
 * computed). The save's snapshot-clear then drops the re-set op at base,
 * wiping the mid-save chunks from the live rebuild - the same
 * snapshot-then-swap class as the vector merge-window defect. The persist is
 * held open on a test-controlled deferred (no wall-clock sleeps).
 *
 * RED at base (the mid-save chunk is wiped), GREEN after the fix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KeywordIndex } from './keyword-index';

/**
 * Stateful fake IndexedDB (rows survive across `open` calls within a test)
 * for the 'keyword-index' store, so save/load observe one persisted corpus.
 */
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

interface PersistedKeywordData {
  key: string;
  entries: Array<{ id: string; docId: string; text: string }>;
  documentChunks: Record<string, string[]>;
}

describe('KeywordIndex mid-save mutation retention (C5)', () => {
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

  it('a mutation landing mid-merge stays searchable after that save and persists with the next', async () => {
    const instance = KeywordIndex.getInstance();
    await instance.initialize();

    // Pre-save chunks for docMid (these are in the save's snapshot).
    instance.addDocument('doc-mid', 0, 'alpha bravo charlie');
    instance.addDocument('doc-mid', 1, 'delta echo foxtrot');

    // Hold the save open INSIDE the persist await (after `merged` was
    // computed, before the snapshot ops are cleared): this is the window a
    // concurrent mutation can land in.
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const internals = instance as unknown as {
      persistToIDB: (data: unknown) => Promise<void>;
    };
    const originalPersist = internals.persistToIDB.bind(instance);
    internals.persistToIDB = async (data: unknown) => {
      await originalPersist(data as never);
      await persistGate;
    };

    const save1 = instance.save();
    // Let save1 reach the parked persist (microtask-chained IDB fakes settle
    // within one macrotask flush).
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The mid-save mutation: MORE chunks for the SAME (snapshotted) docId,
    // landing while the save's persist is in flight.
    instance.addDocument('doc-mid', 2, 'quirky zebra mandate');
    releasePersist();
    await save1;

    internals.persistToIDB = originalPersist;

    // Discriminator 1: the mid-save chunk keeps serving after save #1.
    const liveHits = instance.search('zebra');
    expect(liveHits.some((hit) => hit.docId === 'doc-mid' && hit.chunkIndex === 2)).toBe(true);

    // Discriminator 2: the next save persists the mid-save chunk.
    await instance.save();
    const persisted = idb.rows.get('data') as PersistedKeywordData | undefined;
    expect(persisted).toBeDefined();
    expect(
      persisted!.entries.some(
        (entry) => entry.docId === 'doc-mid' && entry.text.includes('zebra')
      )
    ).toBe(true);

    // Discriminator 3: after a reload the mid-save chunk is still searchable.
    instance.dispose();
    (KeywordIndex as unknown as { instance: KeywordIndex | null }).instance = null;
    const reloaded = KeywordIndex.getInstance();
    await reloaded.initialize();
    const reloadHits = reloaded.search('zebra');
    expect(reloadHits.some((hit) => hit.docId === 'doc-mid' && hit.chunkIndex === 2)).toBe(true);
  });
});
