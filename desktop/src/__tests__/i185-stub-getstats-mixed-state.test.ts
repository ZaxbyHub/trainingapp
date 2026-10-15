// i185-stub-getstats-mixed-state.test.ts — issue #185 guardrail (concurrency).
//
// Lifecycle: RED at base, GREEN after the fix.
//
// The frozen acceptance spec (i175-stub-embedder-marker.test.ts) pins the VALUE
// of getStats().embedding_model on the attached and detached paths, but it is
// strictly sequential and cannot reach the await window where a detach/attach
// lands while getStats() is suspended inside listDocuments(). This guardrail
// pins the capture-once invariant the fix introduces (the same defect class
// issue #191 fixed in LlamaEngine): because the stub captures the surface
// reference ONCE before the await, a detach or swap landing in that window can
// never null-deref and can never pair one surface's counts with another
// surface's (or the marker's) embedder id — counts and embedding_model always
// describe the SAME captured surface.
//
// RED at base: base hardcodes `embedding_model: 'desktop-stub (B5 #63)'` on the
// attached branch, so both the detach and swap cases below fail the
// embedding_model VALUE assertion (the marker is returned instead of the
// captured surface's id). The capture-once half of the invariant is proven by
// MUTATION, not by the base run: reverting to a post-await re-read of
// `this.documentSurface` turns the detach case RED with
// `TypeError: Cannot read properties of null` and the swap case RED with a
// surface-b id leak (counts derive from the pre-await listDocuments call, so
// only the id diverges under that mutant; the distinct surface payloads make a
// separate counts-mixing mutant fail the count assertions too).
// GREEN after the fix: every case stays internally consistent.
import { describe, expect, it } from 'vitest';
import { StubEngine } from '../../main/backend/engine.js';
// The fake surface factory is THE shared fixture in
// ./fixtures/document-surface-fake.ts — this file's factory body was moved
// there verbatim as the superset shape (issue #193 AC19 / #200 AC2): same
// parameterization (embedderModelId first, then docs/onList/rejectList),
// same DEFAULT_DOCS, same `total: documents.length`. The swap test below is
// byte-verbatim and still speaks the docs seam.
import { makeFakeSurface } from './fixtures/document-surface-fake.js';

const STUB_MARKER = 'desktop-stub (B5 #63)';

/** Bound the enteredGate so a getStats that never enters listDocuments fails fast
 *  with a descriptive error instead of hanging to the 30s suite timeout. */
async function awaitEntered(entered: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('getStats never entered listDocuments (enteredGate timeout)')),
      5000,
    );
  });
  try {
    await Promise.race([entered, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
    await awaitEntered(enteredGate); // getStats is now suspended INSIDE listDocuments
    engine.attachDocumentSurface(null); // detach lands in the await window
    release();
    const stats = await pending;

    // Captured-attachment payload: counts from the old surface paired with the
    // OLD surface's embedder id — never a null-deref, never the marker.
    expect(stats.document_count).toBe(2);
    expect(stats.chunk_count).toBe(5);
    expect(stats.embedding_model).toBe('surface-a');
    expect(stats.embedding_model).not.toBe(STUB_MARKER);

    // And the detached engine afterwards reports the no-surface contract.
    const detached = await engine.getStats();
    expect(detached.embedding_model).toBe(STUB_MARKER);
    expect(detached.document_count).toBe(0);
  });

  it('swap during the listDocuments await: counts AND id stay with the captured surface-A, never surface-B', async () => {
    const engine = new StubEngine();
    // Distinct payloads per surface so the COUNT assertions actually detect
    // cross-surface mixing: surface-A is 2 docs / 5 chunks; surface-B is 1 doc /
    // 1 chunk. A buggy impl that took surface-B's counts would be 1/1 here.
    const surfaceA = makeFakeSurface('surface-a');
    const surfaceB = makeFakeSurface('surface-b', { docs: [{ id: 'x.md', chunk_count: 1 }] });
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
    await awaitEntered(enteredGate); // suspended inside surface-A's listDocuments
    engine.attachDocumentSurface(surfaceB); // swap lands in the await window
    release();
    const stats = await pending;

    // The payload describes the CAPTURED surface-A in full: its counts AND its
    // id — never surface-B's (which would be 1 doc / 1 chunk and id 'surface-b').
    expect(stats.document_count).toBe(2);
    expect(stats.chunk_count).toBe(5);
    expect(stats.embedding_model).toBe('surface-a');
    expect(stats.embedding_model).not.toBe('surface-b');
  });

  it('listDocuments rejection propagates out of getStats (no silent swallow)', async () => {
    const engine = new StubEngine();
    engine.attachDocumentSurface(
      makeFakeSurface('surface-x', { rejectList: new Error('store closed') }),
    );
    // getStats has no try/catch around the surface call: a rejecting listDocuments
    // must surface to the caller (server.ts turns it into a 500), never be
    // swallowed into a zeroed/marker payload.
    await expect(engine.getStats()).rejects.toThrow('store closed');
  });

  it('attached-but-empty surface still reports the surface id with zero counts (not the marker)', async () => {
    const engine = new StubEngine();
    engine.attachDocumentSurface(makeFakeSurface('stub-dims-empty', { docs: [] }));
    const stats = await engine.getStats();
    // Empty store handle / empty corpus: counts zero out but the id is still the
    // attached surface's, not the no-surface marker.
    expect(stats.document_count).toBe(0);
    expect(stats.chunk_count).toBe(0);
    expect(stats.embedding_model).toBe('stub-dims-empty');
    expect(stats.embedding_model).not.toBe(STUB_MARKER);
  });
});
