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
import type { DocumentSurface } from '../../main/backend/types.js';

/** Minimal fake surface: two documents, 2 + 3 chunks, everything else no-op. */
function makeFakeSurface(): DocumentSurface {
  return {
    async listDocuments() {
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
    embedderModelId: 'test-embedder',
  };
}

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
    // directly (independent of the listDocuments delegation path).
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
