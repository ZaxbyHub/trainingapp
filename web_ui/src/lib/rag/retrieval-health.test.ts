/**
 * Frozen check C9 (trace collated-275-268, AC4 of issue #268).
 *
 * The session-level retrieval-health store: a subscribable `keyword-only`
 * state carrying a cause string, returning to `ok` when the embedder later
 * becomes ready. Module shape (issue #268 Design 2):
 *
 *   getRetrievalHealth(): { status: 'ok' | 'keyword-only'; cause?: string }
 *   setKeywordOnly(cause: string): void
 *   setOk(): void
 *   subscribe(listener: (state) => void): () => void   // returns unsubscribe
 *   resetRetrievalHealth(): void                       // test/session reset
 *
 * `resetRetrievalHealth` is part of the contract: the amended
 * rag-orchestrator suite (C8) resets the session latch in its beforeEach so
 * the once-per-session warning cannot be pre-tripped by earlier tests in the
 * same file.
 *
 * RED at base (module absent), GREEN after the fix.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  getRetrievalHealth,
  setKeywordOnly,
  setOk,
  subscribe,
  resetRetrievalHealth,
} from './retrieval-health';

type HealthState = ReturnType<typeof getRetrievalHealth>;

describe('retrieval-health store (C9)', () => {
  beforeEach(() => {
    resetRetrievalHealth();
  });

  it('starts in the ok state with no cause', () => {
    expect(getRetrievalHealth()).toEqual({ status: 'ok' });
  });

  it('setKeywordOnly exposes keyword-only state carrying the cause and notifies subscribers', () => {
    const listener = vi.fn<(state: HealthState) => void>();
    const unsubscribe = subscribe(listener);

    setKeywordOnly('Embedding service unavailable');

    expect(getRetrievalHealth()).toEqual({
      status: 'keyword-only',
      cause: 'Embedding service unavailable',
    });
    expect(listener).toHaveBeenCalledWith({
      status: 'keyword-only',
      cause: 'Embedding service unavailable',
    });

    unsubscribe();
  });

  it('a later setKeywordOnly updates the cause (still keyword-only)', () => {
    const listener = vi.fn<(state: HealthState) => void>();
    const unsubscribe = subscribe(listener);

    setKeywordOnly('Embedding service unavailable');
    setKeywordOnly('Embedding worker died');
    expect(getRetrievalHealth()).toEqual({
      status: 'keyword-only',
      cause: 'Embedding worker died',
    });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('setOk returns the state to ok with the cause cleared and notifies subscribers', () => {
    const listener = vi.fn<(state: HealthState) => void>();
    const unsubscribe = subscribe(listener);

    setKeywordOnly('Embedding service unavailable');
    setOk();

    expect(getRetrievalHealth()).toEqual({ status: 'ok' });
    const lastCall = listener.mock.calls[listener.mock.calls.length - 1];
    expect(lastCall[0]).toEqual({ status: 'ok' });

    unsubscribe();
  });

  it('subscribe returns an unsubscribe: a detached listener hears nothing further', () => {
    const listener = vi.fn<(state: HealthState) => void>();
    const unsubscribe = subscribe(listener);

    unsubscribe();
    setKeywordOnly('post-detach cause');

    expect(listener).not.toHaveBeenCalled();
    expect(getRetrievalHealth().status).toBe('keyword-only');
  });

  it('resetRetrievalHealth restores the pristine ok state for a fresh session', () => {
    setKeywordOnly('stale session cause');
    resetRetrievalHealth();
    expect(getRetrievalHealth()).toEqual({ status: 'ok' });
  });
});
