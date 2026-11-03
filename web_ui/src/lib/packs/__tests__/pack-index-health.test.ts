import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DocumentChunk } from '../../../types/document';
import type { PackHealthKeywordTarget, PackHealthVectorTarget } from '../pack-index-health';

function vectorTarget(
  presentDocIds: Set<string>,
  ready = true
): PackHealthVectorTarget {
  return {
    initialize: async () => undefined,
    isReady: () => ready,
    hasDocEntries: (docId: string) => presentDocIds.has(docId),
  };
}

const ALL_PRESENT = new Set(['wiped-pack:docs/a.md', 'wiped-pack:docs/b.md', 'good-pack:docs/a.md', 'empty-pack:x', 'gone-pack:x', 'repair-first:docs/a.md', 'vec-only-pack:docs/a.md']);
function okVector(): PackHealthVectorTarget {
  return vectorTarget(ALL_PRESENT);
}

/**
 * Frozen check C6 (trace collated-270-273, AC7 of issue #270): boot-time pack
 * index health — a pack whose keyword chunks are wiped from the index is
 * detected at boot, its chunks re-indexed via the install path, its
 * `embedded` flag cleared so the embed pass re-embeds the vector side; a
 * zero-chunk pack is healthy and never re-triggers indexing on a second run;
 * the boot composition runs the health gate BEFORE embedding pending records
 * (a deferred health gate must not let the embed pass enumerate early).
 *
 * RED/ERROR at base (spec absent), GREEN after the fix.
 */

const h = vi.hoisted(() => {
  const state = {
    indexCalls: [] as Array<{ packId: string; docs: number }>,
    indexGate: null as Promise<void> | null,
    indexGateRelease: null as (() => void) | null,
    chunksByPack: new Map<string, DocumentChunk[]>(),
    failPackIds: new Set<string>(),
  };
  return state;
});

function releaseIndexGate(): void {
  h.indexGateRelease?.();
  h.indexGateRelease = null;
  h.indexGate = null;
}

vi.mock('../pack-ingest', () => ({
  buildPackChunks: (manifest: { id: string }) => h.chunksByPack.get(manifest.id) ?? [],
  indexPackKeywords: async (
    manifest: { id: string },
    docs: Map<string, Uint8Array>,
    targets?: unknown
  ) => {
    // PRR-001: the REAL indexPackKeywords dereferences targets.keyword.* —
    // passing the bare KeywordIndex instance (the pre-fix production bug)
    // makes targets.keyword undefined and throws. This mock reproduces that
    // contract so the false-green cannot recur.
    const kw = (targets as { keyword?: { initialize?: unknown } } | undefined)?.keyword;
    if (!kw || typeof kw.initialize !== 'function') {
      throw new TypeError('indexPackKeywords requires a { keyword } targets bundle');
    }
    (h as { lastTargets?: unknown }).lastTargets = targets;
    if (h.failPackIds.has(manifest.id)) {
      throw new Error(`simulated repair failure for ${manifest.id}`);
    }
    if (h.indexGate) {
      await h.indexGate;
    }
    h.indexCalls.push({ packId: manifest.id, docs: docs.size });
    return [];
  },
  packDocId: (packId: string, docPath: string) => `${packId}:${docPath}`,
}));

vi.mock('../browser-pack-manager', () => ({
  storedVersionDocs: async (
    _manager: unknown,
    record: { packId: string; version: string }
  ) => {
    if (record.packId === 'gone-pack') return null;
    return {
      manifest: { id: record.packId, version: record.version, name: 'P', docs: [] },
      docs: new Map([
        ['docs/a.md', new Uint8Array([1])],
        ['docs/b.md', new Uint8Array([2])],
      ]),
    };
  },
}));

function chunkFor(packId: string, docPath: string): DocumentChunk {
  return {
    docId: `${packId}:${docPath}`,
    chunkIndex: 0,
    text: 'chunk text',
    source: docPath,
    packId,
  } as DocumentChunk;
}

function makeKeyword(
  presentDocIds: Set<string>,
  lazy = false
): PackHealthKeywordTarget & { initializeCalls: number } {
  let ready = !lazy;
  const kw = {
    initializeCalls: 0,
    initialize: async () => {
      ready = true;
      kw.initializeCalls++;
    },
    isReady: () => ready,
    findChunks: (predicate: (meta: { docId: string }) => boolean, limit = 10) => {
      const hits: unknown[] = [];
      if (!ready) return hits; // uninitialized keyword reads an empty mapping
      for (const docId of presentDocIds) {
        if (predicate({ docId })) {
          hits.push({ docId });
          if (hits.length >= limit) break;
        }
      }
      return hits;
    },
    addDocuments: () => undefined,
    removeByDocId: () => undefined,
    save: async () => undefined,
  };
  return kw;
}

function makeManager(
  records: Array<{ packId: string; version: string; dir?: string; embedded?: boolean }>
): {
  manager: {
    activeRecords(): Promise<Array<{ packId: string; version: string; dir: string; embedded?: boolean }>>;
    readVersionFile(): Promise<Uint8Array | null>;
    markEmbedded(id: string, v: string, e: boolean): Promise<void>;
  };
  marked: Array<{ id: string; v: string; e: boolean }>;
} {
  const marked: Array<{ id: string; v: string; e: boolean }> = [];
  return {
    manager: {
      activeRecords: async () =>
        records.map((r) => ({ ...r, dir: r.dir ?? `/${r.packId}/${r.version}` })),
      readVersionFile: async () => null,
      markEmbedded: async (id: string, v: string, e: boolean) => {
        marked.push({ id, v, e });
      },
    },
    marked,
  };
}

describe('pack index health (C6)', () => {
  beforeEach(() => {
    h.indexCalls.length = 0;
    h.failPackIds.clear();
    (h as { lastTargets?: unknown }).lastTargets = undefined;
    h.indexGate = null;
    h.indexGateRelease = null;
    h.chunksByPack.clear();
  });

  it('a pack with wiped keyword chunks is re-indexed and its embedded flag cleared', async () => {
    const { ensurePackIndexHealth } = await import('../pack-index-health');
    h.chunksByPack.set('wiped-pack', [
      chunkFor('wiped-pack', 'docs/a.md'),
      chunkFor('wiped-pack', 'docs/b.md'),
    ]);
    const m = makeManager([{ packId: 'wiped-pack', version: '1.0.0', embedded: true }]);
    const result = await ensurePackIndexHealth(m.manager, {
      keyword: makeKeyword(new Set()), // nothing present: chunks wiped
      vector: okVector(),
    });
    expect(result.checked).toBe(1);
    expect(result.repaired).toEqual(['wiped-pack@1.0.0']);
    expect(h.indexCalls).toEqual([{ packId: 'wiped-pack', docs: 2 }]);
    expect(m.marked).toEqual([{ id: 'wiped-pack', v: '1.0.0', e: false }]);
  });

  it('a healthy pack is not repaired and its flag is not touched', async () => {
    const { ensurePackIndexHealth } = await import('../pack-index-health');
    h.chunksByPack.set('good-pack', [chunkFor('good-pack', 'docs/a.md')]);
    const m = makeManager([{ packId: 'good-pack', version: '2.0.0', embedded: true }]);
    const result = await ensurePackIndexHealth(m.manager, {
      keyword: makeKeyword(new Set(['good-pack:docs/a.md'])),
      vector: okVector(),
    });
    expect(result.repaired).toEqual([]);
    expect(h.indexCalls).toEqual([]);
    expect(m.marked).toEqual([]);
  });

  it('a zero-chunk pack is healthy on the first and second run (no re-trigger)', async () => {
    const { ensurePackIndexHealth } = await import('../pack-index-health');
    h.chunksByPack.set('empty-pack', []); // zero chunks: healthy by definition
    const m = makeManager([{ packId: 'empty-pack', version: '3.0.0', embedded: true }]);
    const r1 = await ensurePackIndexHealth(m.manager, { keyword: makeKeyword(new Set()), vector: okVector() });
    const r2 = await ensurePackIndexHealth(m.manager, { keyword: makeKeyword(new Set()), vector: okVector() });
    expect(r1.repaired).toEqual([]);
    expect(r2.repaired).toEqual([]);
    expect(h.indexCalls).toEqual([]);
    expect(m.marked).toEqual([]);
  });

  it('a pack whose stored files are gone is skipped without error', async () => {
    const { ensurePackIndexHealth } = await import('../pack-index-health');
    const m = makeManager([{ packId: 'gone-pack', version: '1.0.0', embedded: true }]);
    const result = await ensurePackIndexHealth(m.manager, { keyword: makeKeyword(new Set()), vector: okVector() });
    expect(result.checked).toBe(1);
    expect(result.repaired).toEqual([]);
    expect(h.indexCalls).toEqual([]);
  });

  it('the boot composition embeds only AFTER the health gate settles (PC-8)', async () => {
    h.chunksByPack.set('repair-first', [chunkFor('repair-first', 'docs/a.md')]);
    const m = makeManager([{ packId: 'repair-first', version: '1.0.0', embedded: true }]);
    const healthTargets = { keyword: makeKeyword(new Set()), vector: okVector() };

    // Park the health repair (indexPackKeywords) on a deferred gate.
    h.indexGate = new Promise<void>((resolve) => {
      h.indexGateRelease = resolve;
    });

    const embedCalls: number[] = [];
    const embed = async (): Promise<void> => {
      embedCalls.push(1);
    };

    // IR-13: the REAL composition is under test (reversing the production
    // order must fail this test), with injectable targets.
    const { ensurePackIndexHealthThenEmbed: compose } = await import('../pack-index-health');
    const run = compose(m.manager, embed, healthTargets);
    await new Promise((r) => setTimeout(r, 20));
    // The health gate is still deferred: the embed pass must NOT have run.
    expect(embedCalls).toEqual([]);
    expect(h.indexCalls).toEqual([]);

    releaseIndexGate();
    await run;
    // Health repair landed first, then the embed pass ran exactly once.
    expect(h.indexCalls).toEqual([{ packId: 'repair-first', docs: 2 }]);
    expect(m.marked).toEqual([{ id: 'repair-first', v: '1.0.0', e: false }]);
    expect(embedCalls).toEqual([1]);
  });

  it('a vector-only wipe (keyword intact) is detected and repaired (AC6 keyword-or-vector)', async () => {
    const { ensurePackIndexHealth } = await import('../pack-index-health');
    h.chunksByPack.set('vec-only-pack', [chunkFor('vec-only-pack', 'docs/a.md')]);
    const m = makeManager([{ packId: 'vec-only-pack', version: '1.0.0', embedded: true }]);
    const result = await ensurePackIndexHealth(m.manager, {
      keyword: makeKeyword(new Set(['vec-only-pack:docs/a.md'])), // keyword present
      vector: vectorTarget(new Set()), // vector mapping wiped: nothing present
    });
    expect(result.repaired).toEqual(['vec-only-pack@1.0.0']);
    expect(h.indexCalls).toEqual([{ packId: 'vec-only-pack', docs: 2 }]);
    expect(m.marked).toEqual([{ id: 'vec-only-pack', v: '1.0.0', e: false }]);
  });

  it('the health pass initializes a lazy keyword index before probing (IR-21/IR-23)', async () => {
    const { ensurePackIndexHealth } = await import('../pack-index-health');
    h.chunksByPack.set('good-pack', [chunkFor('good-pack', 'docs/a.md')]);
    const m = makeManager([{ packId: 'good-pack', version: '2.0.0', embedded: true }]);
    // Lazy keyword: uninitialized findChunks reads an empty mapping — the
    // pre-IR-21 code would mis-diagnose the intact pack as wiped. The
    // initialize-call pin is the healing half: the pass must HAVE initialized
    // the index and then correctly seen the intact chunks (a mutant deleting
    // the initialize() call makes ready stay false, the pack is skipped, and
    // initializeCalls stays 0 -> both assertions fail).
    const keyword = makeKeyword(new Set(['good-pack:docs/a.md']), true);
    const result = await ensurePackIndexHealth(m.manager, {
      keyword,
      vector: okVector(),
    });
    expect(keyword.initializeCalls).toBe(1);
    expect(result.repaired).toEqual([]);
    expect(h.indexCalls).toEqual([]);
    expect(m.marked).toEqual([]);
  });

  it('the repair receives a targets bundle whose keyword member is the injected target (PRR-001)', async () => {
    const { ensurePackIndexHealth } = await import('../pack-index-health');
    h.chunksByPack.set('wiped-pack', [chunkFor('wiped-pack', 'docs/a.md')]);
    const m = makeManager([{ packId: 'wiped-pack', version: '1.0.0', embedded: true }]);
    const keyword = makeKeyword(new Set());
    const result = await ensurePackIndexHealth(m.manager, {
      keyword,
      vector: okVector(),
    });
    expect(result.repaired).toEqual(['wiped-pack@1.0.0']);
    expect(h.indexCalls).toEqual([{ packId: 'wiped-pack', docs: 2 }]);
    expect((h as { lastTargets?: { keyword?: unknown } }).lastTargets?.keyword).toBe(keyword);
  });

  it('a repair failure for one pack neither aborts the pass nor suppresses the embed (PRR-001)', async () => {
    const { ensurePackIndexHealthThenEmbed } = await import('../pack-index-health');
    h.chunksByPack.set('bad-pack', [chunkFor('bad-pack', 'docs/a.md')]);
    h.chunksByPack.set('good-pack', [chunkFor('good-pack', 'docs/a.md')]);
    h.failPackIds.add('bad-pack');
    const m = makeManager([
      { packId: 'bad-pack', version: '1.0.0', embedded: true },
      { packId: 'good-pack', version: '1.0.0', embedded: true },
    ]);
    const embed = vi.fn(async () => undefined);
    await ensurePackIndexHealthThenEmbed(m.manager, embed, {
      keyword: makeKeyword(new Set()),
      vector: okVector(),
    });
    // good-pack still repaired; bad-pack skipped with its flag untouched;
    // the embed pass ran despite the bad-pack repair failure.
    expect(h.indexCalls).toEqual([{ packId: 'good-pack', docs: 2 }]);
    expect(m.marked).toEqual([{ id: 'good-pack', v: '1.0.0', e: false }]);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('a health-read failure still runs the embed pass (PRR-001)', async () => {
    const { ensurePackIndexHealthThenEmbed } = await import('../pack-index-health');
    const m = makeManager([]);
    m.manager.activeRecords = async () => {
      throw new Error('registry unreadable');
    };
    const embed = vi.fn(async () => undefined);
    await ensurePackIndexHealthThenEmbed(m.manager, embed, {
      keyword: makeKeyword(new Set()),
      vector: okVector(),
    });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('the boot call site wires health-then-embed inside the embedding-service-ready listener (IR-3/IR-22 pin)', async () => {
    const src = readFileSync(
      path.join(import.meta.dirname, '..', '..', '..', 'lib', 'packs', 'browser-training.ts'),
      'utf-8'
    );
    // IR-22: anchor at the real listener REGISTRATION (the first occurrence
    // of the string is the IR-17 comment, not the listener), and pin the
    // CALL SHAPE (void ensurePackIndexHealthThenEmbed() — the bare module
    // import does not match this).
    const listenerAt = src.indexOf("window.addEventListener('embedding-service-ready'");
    expect(listenerAt).toBeGreaterThan(-1);
    const beforeListener = src.slice(0, listenerAt);
    const bootCall = beforeListener.match(/void\s+ensurePackIndexHealthThenEmbed\(/);
    expect(bootCall).not.toBeNull();
    // Listener ordering: health composition BEFORE the embed pass, inside
    // the listener registration.
    const listener = src.slice(listenerAt);
    const healthInListener = listener.indexOf('ensurePackIndexHealthThenEmbed');
    const embedInListener = listener.indexOf('embedPendingPackChunks');
    expect(healthInListener).toBeGreaterThan(-1);
    expect(embedInListener).toBeGreaterThan(healthInListener);
  });

  it('concurrent health calls join one in-flight pass (PRR-010)', async () => {
    const { ensurePackIndexHealth } = await import('../pack-index-health');
    h.chunksByPack.set('wiped-pack', [
      chunkFor('wiped-pack', 'docs/a.md'),
      chunkFor('wiped-pack', 'docs/b.md'),
    ]);
    const m = makeManager([{ packId: 'wiped-pack', version: '1.0.0', embedded: true }]);
    let scans = 0;
    const originalActiveRecords = m.manager.activeRecords.bind(m.manager);
    m.manager.activeRecords = async () => {
      scans++;
      return originalActiveRecords();
    };

    const [r1, r2] = await Promise.all([
      ensurePackIndexHealth(m.manager, { keyword: makeKeyword(new Set()), vector: okVector() }),
      ensurePackIndexHealth(m.manager, { keyword: makeKeyword(new Set()), vector: okVector() }),
    ]);

    // One scan, one repair: the second caller joined the running pass instead
    // of interleaving its own repair of the same packs.
    expect(scans).toBe(1);
    expect(h.indexCalls).toEqual([{ packId: 'wiped-pack', docs: 2 }]);
    expect(r1.repaired).toEqual(['wiped-pack@1.0.0']);
    expect(r2).toEqual(r1);
  });
});
