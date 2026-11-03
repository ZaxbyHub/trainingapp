/**
 * Frozen check C13 (trace collated-275-268, AC14 of issue #268 / comment R4).
 *
 * When the embedding worker fires `error` AFTER init has resolved, or a
 * request gets no reply within a bounded time, the service must:
 *   1. reject every pending encode/encodeBatch request,
 *   2. mark itself not ready (clearing the worker so a later initialize()
 *      can retry), and
 *   3. report the keyword-only health state with a cause
 *      (lib/rag/retrieval-health, the store this PR adds).
 *
 * No wall-clock sleeps: the worker seam is a synchronous test stub
 * (installed as the global Worker constructor before the service module is
 * imported); the bounded-no-reply case uses fake timers advanced past the
 * bound. At base the pending promises NEVER settle, so each test fails via
 * its explicit (short) per-test timeout.
 *
 * RED at base, GREEN after the fix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Worker stub: replies to `init` synchronously (so initialize() resolves
 * under fake timers too) and deliberately NEVER replies to encode/encodeBatch
 * unless the test answers explicitly - "no reply ever posted" is exactly the
 * stall class under test (R4).
 */
class LivenessWorkerStub {
  static instances: LivenessWorkerStub[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: Array<Record<string, unknown>> = [];

  constructor() {
    LivenessWorkerStub.instances.push(this);
  }

  postMessage(msg: Record<string, unknown>): void {
    this.messages.push(msg);
    if (msg.kind === 'init') {
      this.onmessage?.({ data: { kind: 'ready', dimensions: 768 } } as MessageEvent);
    }
    // encode/encodeBatch: no reply (the stall).
  }

  /** Test hook: answer the most recent encode request with a 768-dim vector. */
  answerLastEncode(): void {
    const encodeMsg = [...this.messages]
      .reverse()
      .find((m) => m.kind === 'encode') as { kind: 'encode'; id: number } | undefined;
    if (!encodeMsg) throw new Error('stub: no encode request to answer');
    this.onmessage?.({
      data: {
        kind: 'encode-result',
        id: encodeMsg.id,
        vector: new Float32Array(768),
      },
    } as MessageEvent);
  }

  /** Test hook: the browser terminated the worker (error escapes the handler). */
  fireError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void {
    /* no-op */
  }
}

type RetrievalHealthModule = {
  getRetrievalHealth: () => { status: string; cause?: string };
  resetRetrievalHealth: () => void;
};

async function freshService(): Promise<{
  svc: { initialize(): Promise<void>; isReady(): boolean; encode(text: string): Promise<Float32Array> };
  health: RetrievalHealthModule;
}> {
  vi.resetModules();
  LivenessWorkerStub.instances = [];
  (globalThis as { Worker: unknown }).Worker = LivenessWorkerStub;
  // resetModules re-evaluates every import below, so the health module the
  // test resets IS the instance the (fresh) service module reports into.
  const health = (await import('../rag/retrieval-health')) as RetrievalHealthModule;
  health.resetRetrievalHealth();
  const mod = await import('./embedding-service');
  const svc = mod.EmbeddingService.getInstance();
  await svc.initialize();
  return { svc, health };
}

describe('EmbeddingService worker liveness (C13)', () => {
  beforeEach(() => {
    LivenessWorkerStub.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    'worker error after init rejects pending requests, drops readiness, allows a retry, and reports keyword-only with a cause',
    async () => {
      const { svc, health } = await freshService();
      expect(svc.isReady()).toBe(true);
      const firstWorker = LivenessWorkerStub.instances[LivenessWorkerStub.instances.length - 1];

      // A request is in flight when the worker dies post-init. The outcome
      // is tracked explicitly so an unsettled promise fails THIS test fast
      // (a never-settling encode is exactly the base defect).
      let rejected = false;
      const pending = svc.encode('liveness probe');
      const tracked = pending.catch((error: unknown) => {
        rejected = true;
        throw error;
      });
      // Amendment (CHECK_WRONG, path repair of the same class as C3's):
      // `tracked` rethrows, so it is REJECTED before its only consumer
      // attaches (the expect below runs a macrotask later) — Node fires
      // unhandledRejection, vitest reports "Errors 1" and exits 1 even with
      // both tests green, and the check could never pass with a correct
      // implementation. The synchronous no-op catch is a handler for that
      // window; the expect still observes the rejection.
      tracked.catch(() => {});

      firstWorker.fireError('worker died (uncaught outside handler)');
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (!rejected) {
        throw new Error(
          'C13: the pending request was not rejected after a post-init worker error'
        );
      }
      await expect(tracked).rejects.toThrow();

      // Not ready: the dead worker was cleared.
      expect(svc.isReady()).toBe(false);

      // The failure is visible in the health store with a cause.
      const state = health.getRetrievalHealth();
      expect(state.status).toBe('keyword-only');
      expect(typeof state.cause).toBe('string');
      expect((state.cause ?? '').length).toBeGreaterThan(0);

      // A later initialize() retries with a NEW worker and serves again.
      await svc.initialize();
      expect(svc.isReady()).toBe(true);
      const secondWorker = LivenessWorkerStub.instances[LivenessWorkerStub.instances.length - 1];
      expect(secondWorker).not.toBe(firstWorker);

      const retry = svc.encode('after retry');
      secondWorker.answerLastEncode();
      await expect(retry).resolves.toBeInstanceOf(Float32Array);
    },
    8000
  );

  it(
    'a request with no reply within a bounded time rejects instead of hanging forever',
    async () => {
      vi.useFakeTimers();
      const { svc } = await freshService();
      expect(svc.isReady()).toBe(true);

      // The stub never replies: only the service's own bound can settle this.
      const pending = svc.encode('stalled request');
      let rejection: Error | undefined;
      let settled = false;
      pending.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          rejection = error instanceof Error ? error : new Error(String(error));
          settled = true;
        }
      );

      // Advance a generous window past any sane no-reply bound (R4 leaves
      // the exact value to the implementer; 120s is the ceiling this check
      // accepts), then drain any chained timers and microtasks.
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.runAllTimersAsync();
      await new Promise((resolve) => {
        vi.useRealTimers();
        setTimeout(resolve, 0);
      });

      if (!settled) {
        throw new Error(
          'C13: the stalled request never settled within the 120s bound (no bounded no-reply path)'
        );
      }
      expect(rejection).toBeInstanceOf(Error);
      expect(svc.isReady()).toBe(false);
    },
    8000
  );
});
