/**
 * Shared named exclusive-lock helper (#275-C, trace collated-275-268 U4).
 *
 * One helper bounds acquisition on BOTH paths: the Web-Locks acquisition
 * (bounded by an abort signal) and the in-tab promise-chain fallback (same
 * bound, entry cleanup). It replaces the three hand-rolled per-store lock
 * implementations (`cross-tab.ts` `withStoreLock`, `pack-store-opfs.ts`
 * `withPackLock`) while `db/conv-protocol.ts` `withConversationWriteLock`
 * keeps its documented direct-call degrade contract — annotated divergent
 * in place (see that file's docstring note).
 *
 * The bound covers ACQUISITION only — a legitimately acquired critical
 * section (a long merge) runs to completion, never cancelled mid-section.
 * Without Web Locks (non-secure-context serving), cross-tab exclusion is
 * degraded to in-tab serialization only; that disclose is in cross-tab.ts's
 * module docstring and stays true for this helper.
 */

/** Minimal structural type of the Web Locks API surface we use. */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode?: 'shared' | 'exclusive'; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
}

/** Default bound on WAITING for the lock (PRR-014): a holder frozen in a
 * background tab must not hang the caller's save/delete forever. */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 60_000;

function acquireTimeoutError(name: string, timeoutMs: number): Error {
  return new Error(
    `Store lock "${name}" was not acquired within ${timeoutMs}ms ` +
      `(another tab may be holding it); the operation did not run - try again.`
  );
}

/** In-tab fallback chains: one per lock name, always settled. */
const localChains = new Map<string, Promise<unknown>>();

/**
 * Run `work` under a named exclusive lock.
 *
 * Lock-manager selection is PROPERTY-PRESENCE: `opts.lockManager` is used
 * only when the property is explicitly present on the options object;
 * explicit `null` forces the in-tab fallback even when Web Locks exist;
 * when the property is absent, `navigator.locks` is auto-detected.
 *
 * With Web Locks, exclusion is cross-tab (acquisition bounded by an
 * AbortSignal timeout). Without them, work calls are chained per name
 * within this tab (second critical section starts only after the first
 * settles, even when the first rejects); a stuck predecessor trips the same
 * bound. Chain entries are dropped once their run settles, so an idle lock
 * name never accumulates state and a fresh caller starts without a queue
 * hop.
 */
export function withExclusiveLock<T>(
  name: string,
  work: () => T | Promise<T>,
  opts?: { lockManager?: LockManagerLike | null; acquireTimeoutMs?: number },
): Promise<T> {
  const locks =
    opts && 'lockManager' in opts
      ? opts.lockManager
      : typeof navigator !== 'undefined'
        ? (navigator as { locks?: LockManagerLike }).locks
        : undefined;

  const timeoutMs = opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;

  if (locks && typeof locks.request === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Acquisition bound: the helper itself rejects when the lock is not
    // granted within acquireTimeoutMs — a manager that ignores the abort
    // signal and never settles (or a wedged holder) cannot hang the caller
    // past the bound. The bound covers WAITING only: it is disarmed the
    // moment the manager grants the lock (invokes the callback).
    let boundTimer: ReturnType<typeof setTimeout> | undefined;
    const acquisitionBound = new Promise<never>((_, reject) => {
      boundTimer = setTimeout(() => reject(acquireTimeoutError(name, timeoutMs)), timeoutMs);
    });
    const acquired = locks
      .request<T>(name, { mode: 'exclusive', signal: controller.signal }, async () => {
        // Granted: disarm the acquisition bound — the critical section runs
        // to completion, never cancelled mid-section.
        if (boundTimer !== undefined) clearTimeout(boundTimer);
        clearTimeout(timer);
        return work();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          throw acquireTimeoutError(name, timeoutMs);
        }
        throw error;
      });
    return Promise.race([acquired, acquisitionBound]).finally(() => {
      if (boundTimer !== undefined) clearTimeout(boundTimer);
      clearTimeout(timer);
    });
  }

  // In-tab fallback: chain per name. The chain itself swallows errors so a
  // rejected run neither blocks later runs nor produces unhandled
  // rejections; the CALLER's promise (`run`) still rejects.
  const track = (run: Promise<T>): Promise<T> => {
    const wrapped = run.catch(() => undefined);
    localChains.set(name, wrapped);
    void wrapped.then(() => {
      // Drop the entry once settled: an idle name starts fresh (no queue hop
      // for the next caller) and the map never accumulates settled chains.
      if (localChains.get(name) === wrapped) localChains.delete(name);
    });
    return run;
  };

  const prev = localChains.get(name);
  if (prev === undefined) {
    // Nothing queued: no acquisition to bound — start immediately (the
    // async-IIFE body runs synchronously up to work()'s first await, so the
    // first critical section begins without an extra microtask hop).
    return track((async () => work())());
  }

  // A predecessor exists: bound the WAIT for it (PRR-014) — only a stuck
  // predecessor trips the timeout; the predecessor's own outcome never does.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'__timeout__'>((resolve) => {
    timer = setTimeout(() => resolve('__timeout__'), timeoutMs);
  });
  const run = Promise.race([
    prev.then(
      () => '__ready__' as const,
      () => '__ready__' as const
    ),
    timeout,
  ]).then((signal) => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal === '__timeout__') {
      throw acquireTimeoutError(name, timeoutMs);
    }
    return work();
  });
  // PR #285 review (PRR-005): a TIMED-OUT WAITER must NOT be tracked. Its
  // rejection settles quickly, and track()'s settle-time cleanup would then
  // delete the name's chain entry while the PREDECESSOR's critical section
  // is still running — the next caller would start concurrently with it
  // (mutual exclusion lost). The chain entry belongs to the predecessor's
  // run until THAT settles; a waiter only races against it and owns no
  // queue slot. (A caller arriving after a timeout still chains on the
  // predecessor and gets its own bounded wait.)
  return run;
}
