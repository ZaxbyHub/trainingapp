// fixtures/document-surface-fake.ts — ONE shared DocumentSurface fake
// (issue #193 AC19 / issue #200 AC2, trace test-batch-oct2026 Cluster A).
//
// This is the SUPERSET of the four copy-pasted makeFakeSurface bodies that
// lived in i103c-getstats-counts.test.ts, i169-llama-getstats-counts.test.ts,
// i175-stub-embedder-marker.test.ts and i185-stub-getstats-mixed-state.test.ts
// (the i185 shape — the most parameterized of the four). The payload is NOT
// fixed: `opts.docs` overrides it per surface and `total` is ALWAYS
// `documents.length` — i185's swap test relies on DISTINCT per-surface
// payloads so its COUNT assertions can detect cross-surface mixing (a
// fixed-payload factory would resurrect the PR-#194 F-2 defect).
//
// The zero-argument form (`makeFakeSurface()`) keeps the historical defaults:
// embedderModelId 'test-embedder' (i169-llama's embedding_model assertions
// pin that id) and the canonical 2-doc/5-chunk DEFAULT_DOCS payload (i103c's
// `total: 2` / `chunk_count: 5` assertions).
//
// `listDocumentsCalls` (a call counter on the returned surface) exists for
// the single-call pin (issue #190 AC16): getStats must call listDocuments()
// EXACTLY once. Issue #209 AC1 extends the SAME observability contract to
// every mutating method (clearDocuments/ingestDirectory/ingestFile/
// ingestBatch): a getStats path that secretly calls a mutator must be
// observable, and `withGatedList` wraps WITHOUT shadowing the counters (the
// `{ ...base, listDocuments(){} }` spread copies accessor properties as
// frozen data values — the exact footgun this helper eradicates).

import type { DocumentSurface } from '../../../main/backend/types.js';

/** Canonical 2-doc / 5-chunk payload (a.md: 2 chunks + b.md: 3 chunks). */
export const DEFAULT_DOCS: Array<{ id: string; chunk_count: number }> = [
  { id: 'a.md', chunk_count: 2 },
  { id: 'b.md', chunk_count: 3 },
];

export interface FakeSurfaceOpts {
  /** Documents the surface reports. Default: the 2-doc/5-chunk payload. Pass a
   *  DISTINCT array per surface so COUNT assertions detect cross-surface mixing. */
  docs?: Array<{ id: string; chunk_count: number }>;
  /** Gates listDocuments() so a test can land an attach/detach in the await window. */
  onList?: () => Promise<void>;
  /** Makes listDocuments() throw (negative path). */
  rejectList?: Error;
  /**
   * The model that built the stored VECTORS (issue #198). Defaults to '' — the
   * schema's seeded value for a store with no writes yet — which makes every
   * caller fall back to `embedderModelId`.
   *
   * That default is load-bearing, not incidental: it is why the four frozen
   * specs sharing this fixture (i103c / i169 / i175 / i185) keep their existing
   * `embedding_model === embedderModelId` verdicts UNCHANGED. Set it only where
   * a test is exercising the divergence itself.
   */
  vectorsEmbeddingModelId?: string;
}

/** A fake DocumentSurface plus the observability the shared specs need. */
export interface FakeDocumentSurface extends DocumentSurface {
  /** How many listDocuments() calls have been observed so far (issue #190 AC16). */
  readonly listDocumentsCalls: number;
  /** How many clearDocuments() calls have been observed (issue #209 AC1). */
  readonly clearDocumentsCalls: number;
  /** How many ingestDirectory() calls have been observed (issue #209 AC1). */
  readonly ingestDirectoryCalls: number;
  /** How many ingestFile() calls have been observed (issue #209 AC1). */
  readonly ingestFileCalls: number;
  /** How many ingestBatch() calls have been observed (issue #209 AC1). */
  readonly ingestBatchCalls: number;
}

/**
 * Minimal fake DocumentSurface parameterized by embedder id and payload.
 * Zero-arg form: embedderModelId 'test-embedder' + DEFAULT_DOCS (the exact
 * payload all four historical factories returned).
 */
export function makeFakeSurface(
  embedderModelId: string = 'test-embedder',
  opts: FakeSurfaceOpts = {},
): FakeDocumentSurface {
  let listDocumentsCalls = 0;
  let clearDocumentsCalls = 0;
  let ingestDirectoryCalls = 0;
  let ingestFileCalls = 0;
  let ingestBatchCalls = 0;
  return {
    async listDocuments() {
      listDocumentsCalls += 1;
      if (opts.rejectList !== undefined) throw opts.rejectList;
      if (opts.onList !== undefined) await opts.onList();
      const documents = opts.docs ?? DEFAULT_DOCS;
      return { documents, total: documents.length };
    },
    async clearDocuments() {
      clearDocumentsCalls += 1;
    },
    async ingestDirectory() {
      ingestDirectoryCalls += 1;
      return { success: true, documents: 0, chunks_added: 0, message: null };
    },
    async ingestFile() {
      ingestFileCalls += 1;
      return { success: true, documents: 0, chunks_added: 0, message: null };
    },
    async ingestBatch() {
      ingestBatchCalls += 1;
      return { total_files: 0, successful: 0, failed: 0, results: [] };
    },
    embedderModelId,
    vectorsEmbeddingModelId: opts.vectorsEmbeddingModelId ?? '',
    get listDocumentsCalls() {
      return listDocumentsCalls;
    },
    get clearDocumentsCalls() {
      return clearDocumentsCalls;
    },
    get ingestDirectoryCalls() {
      return ingestDirectoryCalls;
    },
    get ingestFileCalls() {
      return ingestFileCalls;
    },
    get ingestBatchCalls() {
      return ingestBatchCalls;
    },
  };
}

/** Gates for `withGatedList` (issue #209 AC1 wrap idiom). */
export interface GatedListHooks {
  /** Called synchronously each time the wrapped listDocuments() is entered. */
  onEnter?: () => void;
  /** When provided, the wrapped listDocuments() awaits it before delegating. */
  release?: Promise<void>;
}

/**
 * Wrap a fake surface with a gated listDocuments() WITHOUT shadowing the
 * observability contract (issue #209 AC1, trace 201-207-208-209-210):
 * `{ ...base, listDocuments(){} }` copies the accessor properties
 * (listDocumentsCalls & friends) as frozen data values, killing the
 * observability seam exactly where capture-once is exercised. Building the
 * wrapper with Object.create(base) keeps EVERY counter live through the
 * prototype chain — the override delegates to base.listDocuments(), so all
 * counters (the overridden one included) keep incrementing on the base and
 * read correctly on the wrapper.
 */
export function withGatedList(
  base: FakeDocumentSurface,
  gates: GatedListHooks = {},
): FakeDocumentSurface {
  const wrapped = Object.create(base) as FakeDocumentSurface;
  Object.defineProperty(wrapped, 'listDocuments', {
    value: async () => {
      gates.onEnter?.();
      if (gates.release !== undefined) await gates.release;
      return base.listDocuments();
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return wrapped;
}
