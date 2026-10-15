// fixtures/document-surface-fake.test.ts — smoke spec for the shared
// DocumentSurface fake (issue #193 AC19, trace test-batch-oct2026 Cluster A).
//
// The four getStats specs (i103c, i169-llama, i175, i185) all derive their
// fake surfaces from ./document-surface-fake.ts; this file pins THAT
// parameterization contract so a mutation of the shared factory fails here
// first (named mutant AC19: changing DEFAULT_DOCS or dropping the docs seam).
import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCS, makeFakeSurface } from './document-surface-fake.js';

function chunkSum(docs: Array<{ id: string; chunk_count: number }>): number {
  return docs.reduce((acc, doc) => acc + doc.chunk_count, 0);
}

describe('document-surface-fake (shared fixture contract, issue #193 AC19)', () => {
  it('zero-arg default: embedderModelId "test-embedder" + the canonical DEFAULT_DOCS counts (2 docs / 5 chunks / total 2)', async () => {
    const surface = makeFakeSurface();
    expect(surface.embedderModelId).toBe('test-embedder');
    const listed = await surface.listDocuments();
    expect(listed.total).toBe(2);
    expect(listed.documents).toHaveLength(2);
    expect(chunkSum(listed.documents)).toBe(5);
  });

  it('docs seam: distinct docs arrays yield distinct counts and totals (docs: [] -> zero counts / total 0)', async () => {
    // The seam is load-bearing: i185's swap test gives surface-B a DISTINCT
    // 1-doc/1-chunk payload so COUNT assertions detect cross-surface mixing.
    const canonical = await makeFakeSurface('s-canonical').listDocuments();
    const single = await makeFakeSurface('s-single', {
      docs: [{ id: 'x.md', chunk_count: 1 }],
    }).listDocuments();
    const empty = await makeFakeSurface('s-empty', { docs: [] }).listDocuments();

    expect(canonical.total).toBe(2);
    expect(chunkSum(canonical.documents)).toBe(5);

    expect(single.total).toBe(1);
    expect(chunkSum(single.documents)).toBe(1);

    expect(empty.total).toBe(0);
    expect(empty.documents).toHaveLength(0);
    expect(chunkSum(empty.documents)).toBe(0);

    // Distinctness, explicitly: no payload aliasing between parameterizations.
    expect(canonical.total).not.toBe(single.total);
    expect(chunkSum(canonical.documents)).not.toBe(chunkSum(single.documents));
  });

  it('total is always documents.length, never a hardcoded 2', async () => {
    // The AC20(a) mutant hardcodes `total: 2` regardless of docs — a 1-doc
    // surface must report total 1 (and the empty surface total 0, above).
    const one = await makeFakeSurface('s-one', {
      docs: [{ id: 'only.md', chunk_count: 4 }],
    }).listDocuments();
    expect(one.total).toBe(1);
    expect(chunkSum(one.documents)).toBe(4);
  });

  it('onList gates listDocuments: the async gate is observed before the payload resolves', async () => {
    let gateRan = false;
    const surface = makeFakeSurface('s-gated', {
      onList: async () => {
        await Promise.resolve();
        gateRan = true;
      },
    });
    const pending = surface.listDocuments();
    expect(gateRan).toBe(false); // still parked inside the gate
    const listed = await pending;
    expect(gateRan).toBe(true); // the gate ran before resolution
    expect(listed.total).toBe(2);
  });

  it('rejectList: listDocuments rejects with the EXACT error (no swallow)', async () => {
    const boom = new Error('surface exploded');
    const surface = makeFakeSurface('s-rejecting', { rejectList: boom });
    await expect(surface.listDocuments()).rejects.toBe(boom);
  });

  it('rejectList takes precedence over docs/onList and still counts the call', async () => {
    let onListRan = false;
    const boom = new Error('reject-first');
    const surface = makeFakeSurface('s-reject-first', {
      rejectList: boom,
      onList: async () => {
        onListRan = true;
      },
      docs: [{ id: 'never.md', chunk_count: 9 }],
    });
    await expect(surface.listDocuments()).rejects.toBe(boom);
    expect(onListRan).toBe(false);
    expect(surface.listDocumentsCalls).toBe(1);
  });

  it('listDocumentsCalls counts every observed call (the issue #190 AC16 recording seam)', async () => {
    const surface = makeFakeSurface();
    expect(surface.listDocumentsCalls).toBe(0);
    await surface.listDocuments();
    await surface.listDocuments();
    expect(surface.listDocumentsCalls).toBe(2);
  });

  it('no-op ingest/clear shapes match the historical factories + vacuous-pass guard', async () => {
    const surface = makeFakeSurface();
    await expect(surface.clearDocuments()).resolves.toBeUndefined();
    await expect(surface.ingestDirectory('nowhere')).resolves.toEqual({
      success: true,
      documents: 0,
      chunks_added: 0,
      message: null,
    });
    await expect(surface.ingestFile()).resolves.toEqual({
      success: true,
      documents: 0,
      chunks_added: 0,
      message: null,
    });
    await expect(surface.ingestBatch()).resolves.toEqual({
      total_files: 0,
      successful: 0,
      failed: 0,
      results: [],
    });

    // Vacuous-pass guard (the repo's hygiene-test pattern): the counts
    // asserted throughout this spec are cross-checked against the
    // DEFAULT_DOCS export itself, so a changed payload flips THIS assertion
    // too — the spec can never pass vacuously against a mutated fixture.
    expect(DEFAULT_DOCS).toHaveLength(2);
    expect(chunkSum(DEFAULT_DOCS)).toBe(5);
    // The zero-docs default reuses the canonical export by reference.
    expect((await makeFakeSurface().listDocuments()).documents).toBe(DEFAULT_DOCS);
  });
});
