import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentChunk } from '../../../types/document';
import type { PackHealthKeywordTarget } from '../pack-index-health';

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
  indexPackKeywords: async (manifest: { id: string }, docs: Map<string, Uint8Array>) => {
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

function makeKeyword(presentDocIds: Set<string>): PackHealthKeywordTarget {
  return {
    initialize: async () => undefined,
    isReady: () => true,
    findChunks: (predicate: (meta: { docId: string }) => boolean, limit = 10) => {
      const hits: unknown[] = [];
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
    });
    expect(result.repaired).toEqual([]);
    expect(h.indexCalls).toEqual([]);
    expect(m.marked).toEqual([]);
  });

  it('a zero-chunk pack is healthy on the first and second run (no re-trigger)', async () => {
    const { ensurePackIndexHealth } = await import('../pack-index-health');
    h.chunksByPack.set('empty-pack', []); // zero chunks: healthy by definition
    const m = makeManager([{ packId: 'empty-pack', version: '3.0.0', embedded: true }]);
    const r1 = await ensurePackIndexHealth(m.manager, { keyword: makeKeyword(new Set()) });
    const r2 = await ensurePackIndexHealth(m.manager, { keyword: makeKeyword(new Set()) });
    expect(r1.repaired).toEqual([]);
    expect(r2.repaired).toEqual([]);
    expect(h.indexCalls).toEqual([]);
    expect(m.marked).toEqual([]);
  });

  it('a pack whose stored files are gone is skipped without error', async () => {
    const { ensurePackIndexHealth } = await import('../pack-index-health');
    const m = makeManager([{ packId: 'gone-pack', version: '1.0.0', embedded: true }]);
    const result = await ensurePackIndexHealth(m.manager, { keyword: makeKeyword(new Set()) });
    expect(result.checked).toBe(1);
    expect(result.repaired).toEqual([]);
    expect(h.indexCalls).toEqual([]);
  });

  it('the boot composition embeds only AFTER the health gate settles (PC-8)', async () => {
    const { ensurePackIndexHealthThenEmbed } = await import('../pack-index-health');
    h.chunksByPack.set('repair-first', [chunkFor('repair-first', 'docs/a.md')]);
    const m = makeManager([{ packId: 'repair-first', version: '1.0.0', embedded: true }]);

    // Park the health repair (indexPackKeywords) on a deferred gate.
    h.indexGate = new Promise<void>((resolve) => {
      h.indexGateRelease = resolve;
    });

    const embedCalls: number[] = [];
    const embed = async (): Promise<void> => {
      embedCalls.push(1);
    };

    const run = ensurePackIndexHealthThenEmbed(m.manager, embed);
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
});
