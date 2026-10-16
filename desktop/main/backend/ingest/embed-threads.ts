// ingest/embed-threads.ts — env-gated ONNX session determinism seam (issue #170, D1).
//
// transformers.js ONNX CPU sessions default to a multithreaded intra-op
// threadpool; parallel float reduction reorders accumulation, so embeddings
// and rerank scores are not run-to-run byte-deterministic (a prior incident
// broke byte-identical pack builds). The eval-parity host therefore pins
// threading via TRAININGAPP_DESKTOP_EMBED_THREADS: when set to a positive
// integer, every retrieval-path session (ingest/query embedder plus the
// rerank worker's rerank and query-embed sessions) passes
// session_options: { intraOpNumThreads: <n>, interOpNumThreads: 1,
// executionMode: 'sequential' } to transformers.js.
//
// DEFAULT OFF: unset/empty/invalid values keep behavior byte-identical to
// the pre-seam code — call sites must NOT add a `session_options` key at all
// when this returns undefined (never pass `session_options: undefined`), so
// production embed cost is unchanged unless the env var opts in.
//
// This is the ONE shared definition of the desktop retrieval session knobs
// (all three desktop session call sites import it) so the seam cannot drift
// between embedder.ts and rerank-worker.ts.
//
// Scope of that claim: the desktop retrieval path only. packtool's build
// embedder (packtool/build/embedder.ts) deliberately carries its own pinned
// session literal — always 1-thread, under its reproducible-build contract —
// across the package boundary, and the two definitions are locked together
// by the drift pin in desktop/src/__tests__/embed-seam-contract.test.ts
// (issue #211), which goes red unless both sides are reconciled in the same
// change.

/** The env var key (positive integer = pin sessions to n intra-op threads). */
export const EMBED_THREADS_ENV = 'TRAININGAPP_DESKTOP_EMBED_THREADS';

/**
 * Narrow structural subset of the onnxruntime-common session-options type —
 * exactly the determinism-relevant knobs. (No ONNX API is called here; this
 * seam is pure env parsing, which is why it stays outside the B7 owner set.)
 */
export interface EmbedSessionThreadOptions {
  readonly intraOpNumThreads: number;
  readonly interOpNumThreads: number;
  readonly executionMode: 'sequential';
}

/**
 * Resolve the session thread pin from an env-like record (defaults to
 * process.env). Returns the options object when EMBED_THREADS_ENV is a
 * positive integer, otherwise undefined — the caller then omits the
 * `session_options` key entirely (see the header contract).
 */
export function embedSessionOptions(
  env: Record<string, string | undefined> = process.env,
): EmbedSessionThreadOptions | undefined {
  const raw = (env[EMBED_THREADS_ENV] ?? '').trim();
  if (!/^\d+$/.test(raw)) return undefined;
  const threads = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(threads) || threads < 1) return undefined;
  return { intraOpNumThreads: threads, interOpNumThreads: 1, executionMode: 'sequential' };
}
