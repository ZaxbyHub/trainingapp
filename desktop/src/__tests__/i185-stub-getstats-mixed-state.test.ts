// i185-stub-getstats-mixed-state.test.ts — issue #185 guardrail (concurrency).
//
// Lifecycle: RED at base (e595d169, before the fix), GREEN after the fix.
//
// The frozen acceptance spec (i175-stub-embedder-marker.test.ts) pins the
// VALUE of getStats().embedding_model on the attached and detached paths, but
// it is strictly sequential and cannot reach the await window where a
// detach/attach lands while getStats() is suspended inside
// listDocuments(). This guardrail pins the capture-once invariant the fix
// introduces (the same defect class issue #191 fixed in LlamaEngine):
// because the stub captures the surface reference ONCE before the await, a
// detach or swap landing in that window can never null-deref and can never
// pair one surface's counts with another surface's (or the marker's) embedder
// id — counts and embedding_model always describe the SAME captured surface.
//
// RED at base: base re-reads this.documentSurface AFTER the await, so the
// detach case throws on null and the swap case mixes states.
// GREEN after the fix: both cases stay internally consistent.
import { describe, expect, it } from 'vitest';
import { StubEngine } from '../../main/backend/engine.js';
import type { DocumentSurface } from '../../main/backend/types.js';

/** Minimal fake surface parameterized by embedder id; listDocuments is gate-able. */
function makeFakeSurface(
  embedderModelId: string,
  opts: { onList?: () => Promise<void> } = {},
): DocumentSurface {
  return {
    async listDocuments() {
      if (opts.onList !== undefined) await opts.onList();
      return {
        documents: [
          { id: 'a.md', chunk_count: 2 },
          { id: 'b.md', chunk_count: 3 },
        ],
        total: 2,
      };
    },
    async clearDocuments() {},
    async ingestDirectory() {
      return { success: true, documents: 0, chunks_added: 0, message: null };
    },
    async ingestFile() {
      return { success: true, documents: 0, chunks_added: 0, message: null };
    },
    async ingestBatch() {
      return { total_files: 0, successful: 0, failed: 0, results: [] };
    },
    embedderModelId,
  };
}

describe('StubEngine.getStats mixed-state guardrail (i185)', () => {
  it('detach during the listDocuments await: no crash, counts and embedder id both come from the captured surface', async () => {
    const engine = new StubEngine();
    const base = makeFakeSurface('surface-a');
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.attachDocumentSurface({
      ...base,
      async listDocuments() {
        entered();
        await releaseGate;
        return base.listDocuments();
      },
    });

    const pending = engine.getStats();
    await enteredGate; // getStats is now suspended INSIDE listDocuments
    engine.attachDocumentSurface(null); // detach lands in the await window
    release();
    const stats = await pending;

    // Captured-attachment payload: counts from the old surface paired with
    // the OLD surface's embedder id — never a null-deref, never the marker.
    expect(stats.document_count).toBe(2);
    expect(stats.chunk_count).toBe(5);
    expect(stats.embedding_model).toBe('surface-a');

    // And the detached engine afterwards reports the no-surface contract.
    const detached = await engine.getStats();
    expect(detached.embedding_model).toBe('desktop-stub (B5 #63)');
    expect(detached.document_count).toBe(0);
  });

  it('swap during the listDocuments await: embedder id and counts stay with the captured surface-A, never surface-B', async () => {
    const engine = new StubEngine();
    const surfaceA = makeFakeSurface('surface-a');
    const surfaceB = makeFakeSurface('surface-b');
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.attachDocumentSurface({
      ...surfaceA,
      async listDocuments() {
        entered();
        await releaseGate;
        return surfaceA.listDocuments();
      },
    });

    const pending = engine.getStats();
    await enteredGate; // suspended inside surface-A's listDocuments
    engine.attachDocumentSurface(surfaceB); // swap lands in the await window
    release();
    const stats = await pending;

    // The payload describes the CAPTURED surface-A: its counts AND its id.
    expect(stats.document_count).toBe(2);
    expect(stats.chunk_count).toBe(5);
    expect(stats.embedding_model).toBe('surface-a');
    expect(stats.embedding_model).not.toBe('surface-b');
  });
});
