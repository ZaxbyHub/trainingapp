import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { EmbeddingProgressCallback } from '../../types/embedding';

/**
 * Frozen check C14 (trace collated-270-273, AC8 of issue #273): the
 * embedding-service forwards worker batch-progress messages to the
 * onProgress callback of the MATCHING request only — a progress message for
 * another (or unknown) request id invokes neither the wrong nor a completed
 * request's callback (per-request-id isolation with cleanup on result).
 *
 * The setup.ts WorkerStub only replies with encodeBatch-result, so this spec
 * installs its own Worker stub that emits batch-progress (right id, wrong
 * id, and late-after-settlement) and asserts the routing.
 *
 * RED/ERROR at base (spec absent), GREEN after the fix.
 */

class ProgressWorkerStub {
  static last: ProgressWorkerStub | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private seenIds: number[] = [];

  constructor() {
    ProgressWorkerStub.last = this;
  }

  postMessage(msg: {
    kind: string;
    id?: number;
    texts?: string[];
    dimensions?: number;
  }): void {
    setTimeout(() => {
      if (msg.kind === 'init') {
        this.onmessage?.({ data: { kind: 'ready', dimensions: 768 } } as unknown as MessageEvent);
        return;
      }
      if (msg.kind === 'encodeBatch') {
        const id = msg.id as number;
        this.seenIds.push(id);
        const total = (msg.texts ?? []).length;
        // Progress for the RIGHT request id.
        this.onmessage?.({
          data: { kind: 'batch-progress', id, processed: 1, total },
        } as unknown as MessageEvent);
        // Progress for a WRONG id (not a pending request).
        this.onmessage?.({
          data: { kind: 'batch-progress', id: id + 500, processed: 9, total: 9 },
        } as unknown as MessageEvent);
        // The result retires the request (and its progress callback).
        this.onmessage?.({
          data: {
            kind: 'encodeBatch-result',
            id,
            vectors: (msg.texts ?? []).map(() => new Float32Array(768)),
          },
        } as unknown as MessageEvent);
      }
    });
  }

  /** Emit a late progress message for an already-settled request id. */
  emitLateProgress(id: number): void {
    this.onmessage?.({
      data: { kind: 'batch-progress', id, processed: 99, total: 99 },
    } as unknown as MessageEvent);
  }

  recordedIds(): number[] {
    return this.seenIds;
  }
}

async function freshService() {
  vi.resetModules();
  (globalThis as { Worker: unknown }).Worker = ProgressWorkerStub;
  const mod = await import('./embedding-service');
  const svc = mod.EmbeddingService.getInstance();
  await svc.initialize();
  return svc;
}

describe('embedding-service batch-progress routing (C14)', () => {
  beforeEach(() => {
    ProgressWorkerStub.last = null;
  });

  it('forwards batch-progress to the matching request callback only (two overlapping requests)', async () => {
    const svc = await freshService();
    const cb1: Array<[number, number]> = [];
    const cb2: Array<[number, number]> = [];
    const on1: EmbeddingProgressCallback = (d, t) => cb1.push([d, t]);
    const on2: EmbeddingProgressCallback = (d, t) => cb2.push([d, t]);

    const p1 = svc.encodeBatch(['a', 'b'], on1);
    const p2 = svc.encodeBatch(['c'], on2);
    await Promise.all([p1, p2]);

    expect(cb1).toEqual([[1, 2]]);
    expect(cb2).toEqual([[1, 1]]);
  });

  it('a completed request receives no further progress (cleanup on result)', async () => {
    const svc = await freshService();
    const cb: Array<[number, number]> = [];
    await svc.encodeBatch(['x', 'y'], (d, t) => cb.push([d, t]));
    expect(cb).toEqual([[1, 2]]);

    // A late progress message for the settled request id finds no pending
    // entry and must be dropped silently.
    const stub = ProgressWorkerStub.last;
    expect(stub).not.toBeNull();
    const settledId = stub!.recordedIds()[0];
    stub!.emitLateProgress(settledId);
    expect(cb).toEqual([[1, 2]]);
  });

  it('progress for an unknown id invokes nothing and does not throw', async () => {
    const svc = await freshService();
    const cb: Array<[number, number]> = [];
    await svc.encodeBatch(['z'], (d, t) => cb.push([d, t]));
    const stub = ProgressWorkerStub.last!;
    stub.emitLateProgress(424242);
    expect(cb).toEqual([[1, 1]]);
  });
});
