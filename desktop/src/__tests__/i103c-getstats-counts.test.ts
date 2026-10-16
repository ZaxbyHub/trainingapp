// i103c-getstats-counts.test.ts — FROZEN ACCEPTANCE SPEC (issue #103, i103c).
//
// Lifecycle: RED at base (dbbd93ca), GREEN after the fix.
//
// This file is a frozen acceptance spec authored by the issue-tracer check
// author. It pins StubEngine.getStats() to the attached document surface:
// getStats()'s document_count must equal the surface's listDocuments().total,
// and its chunk_count must equal the sum of the per-document chunk_count
// values (the surface exposes no other counting primitive). With no surface
// attached — or after detaching via attachDocumentSurface(null) — getStats()
// must keep returning zeros for both counts. The documents: string[] payload
// field stays [] in both cases and is out of scope here.
//
// FROZEN COUNTS CONTRACT:
//   1. getStats().document_count === listDocuments().total when a surface
//      is attached (listDocuments already delegates; /stats must agree with
//      the same surface the list endpoint reads).
//   2. getStats().chunk_count === sum(doc.chunk_count) over the surface's
//      listDocuments().documents.
//   3. No surface attached => document_count 0 and chunk_count 0 (the
//      no-store contract is preserved; detach restores it).
import { describe, expect, it } from 'vitest';
import { StubEngine } from '../../main/backend/engine.js';
// The fake surface factory lives in ./fixtures/document-surface-fake.ts —
// ONE fixture source shared by i103c/i169-llama/i175/i185 (issue #193 AC19 /
// #200 AC2; previously copy-pasted here). The zero-arg form preserves this
// spec's historical payload exactly: 'test-embedder' + the 2-doc (2+3
// chunks) DEFAULT_DOCS corpus.
import { makeFakeSurface } from './fixtures/document-surface-fake.js';

describe('StubEngine.getStats document/chunk counts (i103c)', () => {
  it('with a surface attached, getStats reports the surface total as document_count and the summed per-document chunk counts as chunk_count', async () => {
    const engine = new StubEngine();
    engine.attachDocumentSurface(makeFakeSurface());

    const listed = await engine.listDocuments();
    const stats = await engine.getStats();

    // document_count mirrors the total the list endpoint reports.
    expect(listed.total).toBe(2);
    expect(stats.document_count).toBe(listed.total);
    expect(stats.document_count).toBe(2);

    // chunk_count is the sum of per-document chunk_count values.
    const summedChunks = listed.documents.reduce((acc, doc) => acc + doc.chunk_count, 0);
    expect(summedChunks).toBe(5);
    expect(stats.chunk_count).toBe(summedChunks);
    expect(stats.chunk_count).toBe(5);

    // Agreement pin: /stats equals what the surface itself reports, read
    // directly — independent of the delegation path, not of the fixture
    // (PRR-008 F-1: both reads derive from the same shared factory, so this
    // block cannot fail independently of it; the redundant asserts are kept
    // deliberately as belt-and-suspenders - a NON-discriminating consistency
    // check, PRR-034).
    const surfaceView = await makeFakeSurface().listDocuments();
    expect(stats.document_count).toBe(surfaceView.total);
    expect(stats.chunk_count).toBe(
      surfaceView.documents.reduce((acc, doc) => acc + doc.chunk_count, 0),
    );
  });

  it('no-surface: getStats returns zero document_count and chunk_count, and detaching a surface restores the zeros', async () => {
    // Bare engine, nothing ever attached.
    const engine = new StubEngine();
    const bare = await engine.getStats();
    expect(bare.document_count).toBe(0);
    expect(bare.chunk_count).toBe(0);

    // Second path: attach a surface, then detach via attachDocumentSurface(null)
    // — the no-store contract must come back (zeros, not the surface's counts).
    engine.attachDocumentSurface(makeFakeSurface());
    engine.attachDocumentSurface(null);
    const detached = await engine.getStats();
    expect(detached.document_count).toBe(0);
    expect(detached.chunk_count).toBe(0);
  });
});

// issue #190 AC16 (trace test-batch-oct2026 Cluster A, additive to the frozen
// i103c spec above — closed trace 169, blob f7041ec): the single-call
// invariant the engine.ts production comment claims ("a single
// listDocuments() call derives BOTH counts so a concurrent ingest cannot
// skew them apart") was prose-only; this pin makes it executable. The shared
// factory exposes listDocumentsCalls for exactly this purpose.
describe('StubEngine.getStats calls listDocuments exactly once (issue #190 AC16)', () => {
  it('single-listDocuments', async () => {
    const engine = new StubEngine();
    const surface = makeFakeSurface();
    engine.attachDocumentSurface(surface);
    expect(surface.listDocumentsCalls).toBe(0);

    await engine.getStats();

    // Both counts derive from ONE surface read; a second listDocuments()
    // call (the skew the engine.ts comment warns about) must fail here.
    expect(surface.listDocumentsCalls).toBe(1);
  });
});
