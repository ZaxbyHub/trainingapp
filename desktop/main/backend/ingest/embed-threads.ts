// ingest/embed-threads.ts — env-gated ONNX session determinism seam (issue #170, D1).
//
// transformers.js ONNX CPU sessions default to a multithreaded intra-op
// threadpool; parallel float reduction reorders accumulation, so embeddings
// and rerank scores are not run-to-run byte-deterministic (a prior incident
// broke byte-identical pack builds). The eval-parity host therefore pins
// threading via TRAININGAPP_DESKTOP_EMBED_THREADS: when set to a positive
// integer, every retrieval-path session (ingest/query embedder plus the
// rerank worker's rerank and query-embed sessions) passes
// session_options: { intraOpNumThreads: <min(n, host cores)>, interOpNumThreads: 1,
// executionMode: 'sequential' } to transformers.js. The value is CLAMPED to
// the host's available parallelism (floor 1) so an oversized pin cannot
// overflow the ONNX threadpool — see issue #204 AC6. Determinism consequence
// (review PRR-009): the seam is run-to-run deterministic WITHIN a host; the
// clamp makes the effective thread count host-relative, so cross-host
// byte-equality of embeddings is only guaranteed when the pin is at or below
// every host's core count (pack builds keep packtool's separate always-1
// literal and are unaffected).
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

import os from 'node:os';

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
 *
 * Issue #204 AC6: the requested count is CLAMPED to the host's parallelism
 * (floor 1 — a container can report 0 available processors), so an oversized
 * TRAININGAPP_DESKTOP_EMBED_THREADS can never overflow the ONNX threadpool.
 * `coreCount` is injectable for tests; it defaults to os.availableParallelism()
 * (cgroup-aware). Values at or below the core count pass through unchanged.
 */
export function embedSessionOptions(
  env: Record<string, string | undefined> = process.env,
  coreCount: number = defaultCoreCount(),
): EmbedSessionThreadOptions | undefined {
  const raw = (env[EMBED_THREADS_ENV] ?? '').trim();
  if (!/^\d+$/.test(raw)) return undefined;
  const threads = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(threads) || threads < 1) return undefined;
  const cores = Number.isSafeInteger(coreCount) && coreCount >= 1 ? coreCount : 1;
  const clamped = Math.max(1, Math.min(threads, cores));
  return { intraOpNumThreads: clamped, interOpNumThreads: 1, executionMode: 'sequential' };
}

function defaultCoreCount(): number {
  return Math.max(1, os.availableParallelism());
}

/**
 * Resolve the seam's env record from an optional injected host record.
 * Per-key override (review PRR-011): an injected STRING value wins over
 * ambient for that key; keys the injection omits (or sets to undefined) keep
 * their ambient values. Whole-record substitution would silently drop the
 * ambient TRAININGAPP_DESKTOP_EMBED_THREADS pin the moment a host injects a
 * partial record — the silent-failure shape this batch exists to close.
 */
export function seamEnvRecord(
  injected: Record<string, string | undefined> | null | undefined,
): Record<string, string | undefined> {
  if (injected === null || injected === undefined) return process.env;
  const merged: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(injected)) {
    if (typeof value === 'string') merged[key] = value;
  }
  return merged;
}
