// i175-stub-embedder-marker.test.ts — FROZEN ACCEPTANCE SPEC (issue #185).
//
// The filename prefix (i175-) is the frozen argv path from issue #185's
// executable contract, not the issue number; the issue is #185.
//
// Lifecycle: RED at base, GREEN after the fix.
//
// This file is a frozen acceptance spec authored at arm's length. It pins
// StubEngine.getStats()'s embedding_model to the attached document surface's
// embedderModelId — the same rule LlamaEngine.getStats() already applies to
// itself (embedding_model: docs.embedderModelId when a surface is attached).
// With a surface attached, getStats().embedding_model must be the surface's
// exact id, NOT the build marker. With no surface — a bare engine that never
// had one, or after detaching via attachDocumentSurface(null) — the frozen
// B3 conformance marker 'desktop-stub (B5 #63)' must come back unchanged.
//
// FROZEN EMBEDDING_MODEL CONTRACT:
//   1. Surface attached => getStats().embedding_model === the surface's
//      embedderModelId (and !== 'desktop-stub (B5 #63)').
//   2. No surface attached (bare engine, or detach restored the no-surface
//      branch) => getStats().embedding_model === 'desktop-stub (B5 #63)'.
import { describe, expect, it } from 'vitest';
import { StubEngine } from '../../main/backend/engine.js';
import type { DocumentSurface } from '../../main/backend/types.js';

const STUB_MARKER = 'desktop-stub (B5 #63)';

/** Minimal fake surface: two documents, 2 + 3 chunks, everything else no-op. */
function makeFakeSurface(embedderModelId: string): DocumentSurface {
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
    embedderModelId,
  };
}

describe('StubEngine.getStats embedding_model surface id (i175)', () => {
  it('with a surface attached, getStats reports the surface embedderModelId as embedding_model, not the stub marker', async () => {
    const engine = new StubEngine();
    engine.attachDocumentSurface(makeFakeSurface('stub-dims-8'));

    const stats = await engine.getStats();

    // The attached surface's id, exactly.
    expect(stats.embedding_model).toBe('stub-dims-8');
    // And explicitly not the hardcoded build marker.
    expect(stats.embedding_model).not.toBe(STUB_MARKER);
  });

  it('no-surface: a bare engine reports the stub marker, and detaching a surface restores it', async () => {
    // Bare engine, nothing ever attached.
    const bare = await new StubEngine().getStats();
    expect(bare.embedding_model).toBe(STUB_MARKER);

    // Second path: attach a surface with a distinct id, then detach via
    // attachDocumentSurface(null) — the frozen no-surface marker must come
    // back (not the detached surface's id).
    const engine = new StubEngine();
    engine.attachDocumentSurface(makeFakeSurface('stub-dims-16'));
    const attached = await engine.getStats();
    expect(attached.embedding_model).toBe('stub-dims-16');

    engine.attachDocumentSurface(null);
    const detached = await engine.getStats();
    expect(detached.embedding_model).toBe(STUB_MARKER);
  });
});
