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

export function resetRetrievalHealth(): void {
  state = { status: 'ok' };
  notify();
}
