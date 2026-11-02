import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Frozen check C13 (trace collated-270-273, AC7 of issue #273): overlapping
 * embedPendingPackChunks runs are single-flight — the second call JOINS the
 * in-flight run instead of re-enumerating the same pending records and
 * inserting duplicate vectors — and a version that becomes pending DURING
 * the active run is embedded on an automatic follow-up pass, exactly once
 * (rerun flag).
 *
 * The ingest layer is mocked (the pack manager's embedding loop is under
 * test, not the embedder); storedVersionDocs is stubbed so no real pack
 * files are needed.
 *
 * RED/ERROR at base (spec absent), GREEN after the fix.
 */

const h = vi.hoisted(() => {
  const embedCalls: string[][] = [];
  let gateResolve: (() => void) | null = null;
  let active: Promise<void> | null = null;
  return {
    embedCalls,
    park(): void {
      active = new Promise<void>((resolve) => {
        gateResolve = resolve;
      });
    },
    release(): void {
      gateResolve?.();
      gateResolve = null;
      active = null;
    },
    gatePromise(): Promise<void> | null {
      return active;
    },
  };
});

vi.mock('../pack-ingest', () => ({
  buildPackChunks: (manifest: { id?: string }) => [{ docId: `${manifest?.id ?? 'p'}-doc`, chunkIndex: 0, text: 'chunk' }],
  embedPackChunks: async (chunks: Array<{ text: string }>) => {
    const gate = h.gatePromise();
    if (gate) await gate;
    h.embedCalls.push(chunks.map((c) => c.text));
    return true;
  },
}));

interface Rec {
  packId: string;
  version: string;
  embedded?: boolean;
}

function makeManager(initial: Rec[]): {
  manager: {
    pendingEmbeddings(): Promise<Rec[]>;
    readVersionFile(record: { packId: string; version: string }, segments: string[]): Promise<Uint8Array | null>;
    markEmbedded(id: string, v: string, e: boolean): Promise<void>;
  };
  setPending(rec: Rec): void;
  marked: string[];
} {
  let pending: Rec[] = [...initial];
  const marked: string[] = [];
  // Schema-valid pack.json (same shape the pack-ingest fixture uses), so the
  // real storedVersionDocs parse path runs.
  const packJson = new TextEncoder().encode(
    JSON.stringify({
      id: 'test-pack',
      name: 'P',
      version: '1.0.0',
      published_at: '2026-10-01T00:00:00Z',
      source_class: 'training',
      embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
      chunking: { strategy: 'slide-aware', size: 256, overlap: 100 },
      docs: [{ path: 'docs/a.md', sha256: '0'.repeat(64), title: 'a', mime: 'text/markdown' }],
    })
  );
  const manager = {
    pendingEmbeddings: async () => pending.filter((r) => r.embedded !== true),
    readVersionFile: async (
      record: { packId: string; version: string },
      segments: string[]
    ): Promise<Uint8Array | null> => {
      if (segments.length === 1 && segments[0] === 'pack.json') return packJson;
      return null;
    },
    markEmbedded: async (id: string, v: string, e: boolean) => {
      if (e) {
        marked.push(`${id}@${v}`);
        pending = pending.filter((r) => !(r.packId === id && r.version === v));
      }
    },
  };
  return { manager, setPending: (rec: Rec) => { pending.push(rec); }, marked };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('embedPendingPackChunks single-flight (C13)', () => {
  beforeEach(() => {
    h.embedCalls.length = 0;
  });
  it('overlapping calls join one run: no duplicate embed enumeration', async () => {
    const { manager, marked } = makeManager([{ packId: 'p', version: '1' }]);
    const { embedPendingPackChunks } = await import('../browser-pack-manager');
    h.park();
    const run1 = embedPendingPackChunks(manager as never);
    const run2 = embedPendingPackChunks(manager as never); // joins the active run
    h.release();
    await Promise.all([run1, run2]);
    expect(h.embedCalls).toHaveLength(1); // one pass, not two
    expect(marked).toEqual(['p@1']);
  });

  it('a version pending mid-run is embedded on the follow-up pass exactly once', async () => {
    const m = makeManager([{ packId: 'p', version: '1' }]);
    const { embedPendingPackChunks } = await import('../browser-pack-manager');
    h.park();
    const run1 = embedPendingPackChunks(m.manager as never);
    await flush(); // let run1 enter the parked embed
    m.setPending({ packId: 'q', version: '2' }); // becomes pending mid-run
    const run2 = embedPendingPackChunks(m.manager as never); // joins, queues rerun
    h.release();
    await Promise.all([run1, run2]);
    // Pass 1 embedded v1; the follow-up pass embedded v2 exactly once.
    expect(h.embedCalls).toHaveLength(2);
    expect(m.marked).toEqual(['p@1', 'q@2']);
  });

  it('sequential runs without overlap do not trigger a rerun', async () => {
    const { manager, marked } = makeManager([{ packId: 'p', version: '3' }]);
    const { embedPendingPackChunks } = await import('../browser-pack-manager');
    await embedPendingPackChunks(manager as never);
    await embedPendingPackChunks(manager as never);
    expect(h.embedCalls).toHaveLength(1); // second run: nothing pending
    expect(marked).toEqual(['p@3']);
  });
});
