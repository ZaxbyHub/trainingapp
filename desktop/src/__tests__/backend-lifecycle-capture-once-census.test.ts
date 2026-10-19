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

/**
 * A document surface whose every call suspends until the test releases it and
 * then REJECTS with a worker-exit style error.
 *
 * Rejecting (rather than resolving) is what makes the census discriminate: a
 * "hardening" mutant that wraps the post-await surface read in try/catch and
 * substitutes the no-surface default would otherwise resolve every row and
 * leave the census green — the exact silent-truncation shape this guardrail
 * exists to prevent (PRR review finding H3 / CAND-6, execution-proven). With a
 * rejecting surface the unmutated code propagates the rejection, while the
 * mutant resolves with the default id, and the identity assertion below tells
 * them apart.
 */
function rejectingSurface(): { surface: DocumentSurface; release: () => void } {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const boom = async (): Promise<never> => {
    await gate;
    throw new Error('worker exited');
  };
  const surface: DocumentSurface = {
    embedderModelId: 'census-embedder',
    listDocuments: boom,
    clearDocuments: boom,
    ingestDirectory: boom,
    ingestFile: boom,
    ingestBatch: boom,
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
): Promise<{ name: string; result: string; embeddingModel?: string }> {
  const engine = new StubEngine();
  const release = attach(engine);
  const pending = invoke(engine).then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
  );
  // Let the engine method reach its await inside the surface call.
  await new Promise((r) => setTimeout(r, 30));
  // Teardown lands in the await window.
  engine.attachDocumentSurface(null);
  engine.attachRetrievalSurface(null);
  release();
  const settled = await pending;
  const result = settled.ok ? 'RESOLVED' : `THREW: ${settled.message}`;
  // getStats() resolves to an object carrying the surface's embedder id, which
  // is the positive identity witness for the document half of the census.
  const embeddingModel =
    settled.ok && settled.value && typeof settled.value === 'object' && 'embedding_model' in settled.value
      ? String((settled.value as { embedding_model: unknown }).embedding_model)
      : undefined;
  return { name, result, embeddingModel };
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
            const { surface, release } = rejectingSurface();
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
            const { surface, release } = rejectingSurface();
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
            const { surface, release } = rejectingSurface();
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
            const { surface, release } = rejectingSurface();
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
            const { surface, release } = rejectingSurface();
            engine.attachDocumentSurface(surface);
            return release;
          },
        ),
      );

      // eslint-disable-next-line no-console
      console.log(`CENSUS ${JSON.stringify(rows)}`);

      // The retrieval row must resolve and report the CAPTURED surface's field,
      // not a detached one — the positive half of the capture-once invariant.
      const retrieve = rows.find((row) => row.name === 'retrieveContext');
      expect(retrieve?.result, 'retrieveContext must resolve, not throw').toBe('RESOLVED');

      // The document rows must PROPAGATE the surface's rejection (PRR review
      // finding H3 / CAND-6). The fixture rejects with 'worker exited' after the
      // gate, so unmutated code surfaces that error. A "hardening" mutant that
      // wraps the post-await surface read in try/catch and substitutes the
      // no-surface default resolves instead — which is the silent-truncation
      // shape this guardrail exists to prevent, and which an
      // absence-of-throw-only assertion cannot see (execution-proven: such a
      // mutant left all five rows green before this assertion existed).
      const documentRows = rows.filter((row) => row.name !== 'retrieveContext');
      const swallowed = documentRows.filter((row) => !row.result.startsWith('THREW'));
      expect(
        swallowed,
        `every document-surface row must propagate the surface rejection, not swallow it: ${JSON.stringify(swallowed)}`,
      ).toEqual([]);
      for (const row of documentRows) {
        expect(
          row.result,
          `${row.name} must surface the surface's own error, not a substituted default`,
        ).toContain('worker exited');
      }

      // The one document method whose output is observable must report the
      // CAPTURED surface's identity when the surface is healthy. Driven by the
      // second test below, which uses a resolving surface.
      const statsRow = rows.find((row) => row.name === 'getStats');
      expect(
        statsRow?.result,
        'getStats must surface the surface rejection rather than a substituted default',
      ).toContain('worker exited');
    },
    30_000,
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
