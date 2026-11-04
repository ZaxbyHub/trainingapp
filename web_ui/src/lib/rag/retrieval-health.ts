/**
 * Session-level retrieval-health store (trace collated-275-268 U7, #268).
 *
 * One subscribable store carrying the session's retrieval degradation state:
 * `ok`, or `keyword-only` with a cause string. `setKeywordOnly` marks the
 * session degraded (the embedding service is unavailable or the runtime
 * encode failed); `setOk` restores it once the embedder is CONFIRMED ready
 * again. The once-per-session `Embedding service unavailable` warn lives at
 * the `ok → keyword-only` transition in the orchestrator, not here.
 */

export type RetrievalHealthState =
  | { status: 'ok' }
  | { status: 'keyword-only'; cause: string };

let state: RetrievalHealthState = { status: 'ok' };

const listeners = new Set<(state: RetrievalHealthState) => void>();

function notify(): void {
  for (const listener of listeners) {
    listener(state);
  }
}

export function getRetrievalHealth(): RetrievalHealthState {
  return state;
}

export function setKeywordOnly(cause: string): void {
  state = { status: 'keyword-only', cause };
  notify();
}

export function setOk(): void {
  state = { status: 'ok' };
  notify();
}

export function subscribe(listener: (state: RetrievalHealthState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * U8/U7 (#268): the most recent embedding-service initialization failure
 * message (cleared to null once init succeeds). The orchestrator surfaces it
 * as the keyword-only health cause so the persistent notice names the REAL
 * problem (e.g. the staging error `embedding model not staged: <url>`).
 */
let lastInitFailure: string | null = null;

/** Record the latest embedding-init failure message (null = recovered). */
export function noteEmbeddingInitFailure(message: string | null): void {
  lastInitFailure = message;
}

/** The last embedding-init failure message, or null once init succeeds. */
export function getLastEmbeddingInitFailure(): string | null {
  return lastInitFailure;
}

export function resetRetrievalHealth(): void {
  state = { status: 'ok' };
  // Fresh-session reset also clears the init-failure memo (the orchestrator
  // reads it for the next degradation cause); otherwise a stale staging
  // error would outlive the session reset.
  lastInitFailure = null;
  notify();
}
