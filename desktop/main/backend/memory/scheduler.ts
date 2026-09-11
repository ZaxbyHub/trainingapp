// memory/scheduler.ts — generation/ingestion serialization (issue #66, S3).
//
// ConcurrencyScheduler formalizes what B4 left implicit: a FIFO mutex around
// LLM generation with observability, PLUS the ingestion-pause seam the B6
// embed phase awaits. Excess generations queue (never 503) — the same
// semantics as the per-engine queue in inference/llama-engine.ts, but
// engine-independent (it holds for the CI StubEngine too) and observable.
//
// Observability contract (b8-wiring C9 pins the exact values): with one
// generation running and one queued, (generationInFlight, queueDepth,
// activeGenerations) reads (true, 1, 1); drained it reads (false, 0, 0).
// The host checks the drained triple before clearing a pressure override.
export interface ConcurrencySchedulerOptions {
  /** Default 1 (concurrency.maxConcurrentGenerations, S3). */
  maxConcurrentGenerations?: number;
}

interface QueuedJob {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

export class ConcurrencyScheduler {
  private readonly max: number;
  private queue: QueuedJob[] = [];
  private waiters: Array<() => void> = [];
  private active = 0;

  constructor(options: ConcurrencySchedulerOptions = {}) {
    const requested = options.maxConcurrentGenerations ?? 1;
    this.max = Number.isInteger(requested) && requested >= 1 ? requested : 1;
  }

  /**
   * Serialized execution: at most maxConcurrentGenerations fn()s run at once;
   * excess generations queue FIFO. Resolves with fn's value, rejects with
   * fn's error — one failing generation never breaks the queue.
   */
  runGeneration<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  /**
   * Resolves the next time the scheduler has NO generation in flight
   * (immediately when idle). The ingestion-pause seam: the B6 embed phase
   * awaits this before embed-heavy work (AC4).
   */
  waitForGenerationEnd(): Promise<void> {
    if (!this.generationInFlight) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** True while a generation executes. */
  get generationInFlight(): boolean {
    return this.active > 0;
  }

  /** Generations waiting to START. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Currently executing generations (0..max). */
  get activeGenerations(): number {
    return this.active;
  }

  /** Host shutdown: reject every QUEUED (not yet started) generation. */
  rejectQueued(err: Error): void {
    const queued = this.queue.splice(0, this.queue.length);
    for (const job of queued) job.reject(err);
  }

  private pump(): void {
    while (this.active < this.max && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job === undefined) break;
      this.active += 1;
      void job
        .fn()
        .finally(() => {
          // Cleanup BEFORE the consumer's promise settles: after `await
          // runGeneration(...)` returns, generationInFlight must already be
          // false (the frozen C3 spec reads it synchronously right after the
          // await) and a queued next generation must already have started.
          this.active -= 1;
          if (this.active === 0) {
            const waiters = this.waiters.splice(0, this.waiters.length);
            for (const waiter of waiters) waiter();
          }
          this.pump();
        })
        .then(job.resolve, job.reject);
    }
  }
}
