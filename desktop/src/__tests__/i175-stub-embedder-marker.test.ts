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
// The fake surface factory lives in ./fixtures/document-surface-fake.ts —
// ONE fixture source shared by i103c/i169-llama/i175/i185 (issue #193 AC19 /
// #200 AC2; previously copy-pasted here). Behavior-preserving adoption in
// this frozen spec (closed trace 185, blob 1a177d5): the id-taking call
// shape and the 2-doc (2+3 chunks) payload are unchanged.
import { makeFakeSurface } from './fixtures/document-surface-fake.js';

const STUB_MARKER = 'desktop-stub (B5 #63)';

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
