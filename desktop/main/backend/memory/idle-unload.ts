// memory/idle-unload.ts — idle ONNX-session unloading (issue #66, S5).
//
// The controller owns ONLY the idle-window policy: construction does not arm
// a window (nothing loaded -> nothing to unload); touch() (re)arms it; after
// idleUnloadMs with no touch, unload fires EXACTLY ONCE for that window; a
// later touch starts a fresh window (the reload-then-idle-again lifecycle).
// Reload itself is lazy at the consumption site (retrieval/reranker.ts
// ResumableReranker): the next request rebuilds the session and reports the
// measured reload latency via recordReload (AC5).
export interface IdleUnloadOptions {
  /** The idle window (memory.idleUnloadMs, S5). */
  idleUnloadMs: number;
  /** Invoked ONCE per elapsed idle window; may be async (fire-and-forget). */
  unload: () => void | Promise<void>;
  /** Clock seam reserved for injected-time tests; the window itself runs on a
   *  real one-shot timer so worker teardown cannot be faked. */
  nowMs?: () => number;
}

export class IdleUnloadController {
  private readonly idleUnloadMs: number;
  private readonly unload: () => void | Promise<void>;
  private readonly nowMs: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fires = 0;
  private reloadMs: number | null = null;
  private disposed = false;

  constructor(options: IdleUnloadOptions) {
    this.idleUnloadMs = options.idleUnloadMs;
    this.unload = options.unload;
    this.nowMs = options.nowMs ?? Date.now;
    void this.nowMs;
  }

  /** Marks use; (re)arms the idle window from NOW. */
  touch(): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fires += 1;
      try {
        void Promise.resolve(this.unload()).catch(() => {
          // The controller owns the policy, not the teardown's failure:
          // an unload error is consumed here (the next use rebuilds anyway).
        });
      } catch {
        // synchronous throw guard — same policy
      }
    }, this.idleUnloadMs);
  }

  /** Stops the timer; unload NEVER fires afterwards; touch() becomes inert. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** How many times unload has fired (>= 0). */
  get unloadCount(): number {
    return this.fires;
  }

  /** The host records a measured reload latency (AC5). */
  recordReload(ms: number): void {
    this.reloadMs = ms;
  }

  /** null until the first recordReload. */
  get lastReloadMs(): number | null {
    return this.reloadMs;
  }
}
