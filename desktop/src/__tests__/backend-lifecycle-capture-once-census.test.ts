// backend-lifecycle-capture-once-census.test.ts — GUARDRAIL (Phase 4.2 recurrence
// census) for trace 199-229-backend-host-lifecycle.
//
// Defect class: a backend-host function reads mutable lifecycle state at a point
// where a concurrent lifecycle transition can have replaced or nulled it, or
// reads it from a source other than the effective configuration record.
//
// This spec generalizes frozen check C8 (which covered ONLY
// StubEngine.retrieveContext) across EVERY StubEngine method that awaits a
// document- or retrieval-surface call. Each one is driven with a surface whose
// call suspends, the surface is detached while the engine method is suspended
// inside it, and the method must complete without a null-dereference and
// without reporting a stale surface's identity.
//
// GREEN on the fixed tree. Demonstrated RED on the original defect by reverting
// the capture-once hunk in retrieveContext (see 08a-recurrence-sweep.md): the
// retrieveContext row throws `Cannot read properties of null (reading
// 'floorActive')` while every sibling row stays green — which is exactly why
// the class needed a census rather than a single pin.
import { describe, expect, it } from 'vitest';
import { StubEngine } from '../../main/backend/engine.js';
import type { DocumentSurface } from '../../main/backend/types.js';
import type { RetrievalSurface } from '../../main/backend/retrieval/hybrid.js';

/** A surface whose every call suspends until the test releases it. */
function suspendingSurface(): { surface: DocumentSurface; release: () => void } {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const surface: DocumentSurface = {
    embedderModelId: 'census-embedder',
    listDocuments: async () => {
      await gate;
      return { documents: [], total: 0 };
    },
    clearDocuments: async () => {
      await gate;
    },
    ingestDirectory: async () => {
      await gate;
      return { ingested: 0, chunks: 0, skipped: 0 };
    },
    ingestFile: async () => {
      await gate;
      return { ingested: 0, chunks: 0, skipped: 0 };
    },
    ingestBatch: async () => {
      await gate;
      return { ingested: 0, chunks: 0, skipped: 0, results: [] };
    },
  };
  return { surface, release: release ?? (() => {}) };
}

/** A retrieval surface whose search suspends until the test releases it. */
function suspendingRetrievalSurface(): { surface: RetrievalSurface; release: () => void } {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const surface: RetrievalSurface = {
    floorActive: true,
    search: async () => {
      await gate;
      return [{ text: 'row', source: 'a.md', similarity: 0.9 }];
    },
  };
  return { surface, release: release ?? (() => {}) };
}

function outcome(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'RESOLVED',
    (e: unknown) => `THREW: ${e instanceof Error ? e.message : String(e)}`,
  );
}

/**
 * Run one census row: call `invoke(engine)`, wait until the surface call has
 * been entered, detach BOTH surfaces (what stop() does), then release the
 * suspended call and report how the engine method settled.
 */
async function censusRow(
  name: string,
  invoke: (engine: StubEngine) => Promise<unknown>,
  attach: (engine: StubEngine) => () => void,
): Promise<{ name: string; result: string }> {
  const engine = new StubEngine();
  const release = attach(engine);
  const pending = outcome(invoke(engine));
  // Let the engine method reach its await inside the surface call.
  await new Promise((r) => setTimeout(r, 30));
  // Teardown lands in the await window.
  engine.attachDocumentSurface(null);
  engine.attachRetrievalSurface(null);
  release();
  const result = await pending;
  return { name, result };
}

describe('guardrail: no engine method reads a mutable surface after its await', () => {
  it(
    'every surface-awaiting engine method survives a mid-await detach',
    async () => {
      const rows: Array<{ name: string; result: string }> = [];

      rows.push(
        await censusRow(
          'retrieveContext',
          (engine) => engine.retrieveContext('q', 4),
          (engine) => {
            const { surface, release } = suspendingRetrievalSurface();
            engine.attachRetrievalSurface(surface);
            return release;
          },
        ),
      );

      rows.push(
        await censusRow(
          'getStats',
          (engine) => engine.getStats(),
          (engine) => {
            const { surface, release } = suspendingSurface();
            engine.attachDocumentSurface(surface);
            return release;
          },
        ),
      );

      rows.push(
        await censusRow(
          'clearDocuments',
          (engine) => engine.clearDocuments(),
          (engine) => {
            const { surface, release } = suspendingSurface();
            engine.attachDocumentSurface(surface);
            return release;
          },
        ),
      );

      rows.push(
        await censusRow(
          'ingestDirectory',
          (engine) => engine.ingestDirectory('/tmp/census'),
          (engine) => {
            const { surface, release } = suspendingSurface();
            engine.attachDocumentSurface(surface);
            return release;
          },
        ),
      );

      rows.push(
        await censusRow(
          'ingestFile',
          (engine) => engine.ingestFile({} as never),
          (engine) => {
            const { surface, release } = suspendingSurface();
            engine.attachDocumentSurface(surface);
            return release;
          },
        ),
      );

      rows.push(
        await censusRow(
          'ingestBatch',
          (engine) => engine.ingestBatch([]),
          (engine) => {
            const { surface, release } = suspendingSurface();
            engine.attachDocumentSurface(surface);
            return release;
          },
        ),
      );

      // eslint-disable-next-line no-console
      console.log(`CENSUS ${JSON.stringify(rows)}`);

      const threw = rows.filter((row) => row.result.startsWith('THREW'));
      expect(
        threw,
        `no engine method may null-deref when a detach lands inside its await: ${JSON.stringify(threw)}`,
      ).toEqual([]);

      // The retrieval row must also report the CAPTURED surface's field, not a
      // detached one — the positive half of the capture-once invariant.
      const retrieve = rows.find((row) => row.name === 'retrieveContext');
      expect(retrieve?.result, 'retrieveContext must resolve, not throw').toBe('RESOLVED');
    },
    60_000,
  );

  it(
    'retrieveContext reports the captured surface floorActive after a mid-await detach',
    async () => {
      const engine = new StubEngine();
      const { surface, release } = suspendingRetrievalSurface();
      engine.attachRetrievalSurface(surface);
      const pending = engine.retrieveContext('q', 4);
      await new Promise((r) => setTimeout(r, 30));
      engine.attachRetrievalSurface(null);
      release();
      const result = await pending;
      expect(
        result?.floorActive,
        'the captured surface fields must describe the result after a mid-await detach',
      ).toBe(true);
    },
    30_000,
  );
});
