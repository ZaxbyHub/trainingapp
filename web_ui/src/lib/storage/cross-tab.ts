/**
 * Cross-tab coordination primitives for the retrieval stores (#270).
 *
 * The document, keyword and vector stores historically had no cross-tab
 * coordination at all: every tab wrote its whole in-memory state over the
 * persisted blobs, so a stale tab's save wiped another tab's work. The pack
 * store (`pack-store-opfs.ts`) already established the exclusive-Web-Lock
 * pattern with an in-tab promise-chain fallback; this module extracts the
 * same shape for the retrieval stores. The conversations store has its own
 * epoch gate + Web Locks (`db/conv-protocol.ts`, PR #264) and is out of scope
 * here.
 *
 * Cross-tab exclusion is WEB-LOCKS-ONLY: when `navigator.locks` is
 * unavailable (non-secure-context serving), callers fall back to an in-tab
 * promise chain, which serializes this tab's critical sections but cannot
 * exclude another tab. The merge algorithms that run inside the lock
 * (change-log merge from a freshly read persisted baseline) keep their
 * single-tab correctness without the lock; the cross-tab guarantee is
 * disclosed as degraded in that environment.
 */

/** Minimal structural type of the Web Locks API surface we use. */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode?: 'shared' | 'exclusive'; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<T>
  ): Promise<T>;
}

/** In-tab fallback chains: one per lock name, always settled. */
const localChains = new Map<string, Promise<unknown>>();

/** Default bound on WAITING for the lock (PRR-014): a holder frozen in a
 * background tab (Chrome freezes background tabs; its IndexedDB callback
 * never runs, so the lock is never released) must not hang the caller's
 * save/delete forever. The timeout covers acquisition only — a legitimately
 * acquired critical section (a long merge) runs to completion. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 60_000;

function acquireTimeoutError(name: string, timeoutMs: number): Error {
  return new Error(
    `Store lock "${name}" was not acquired within ${timeoutMs}ms ` +
      `(another tab may be holding it); the operation did not run - try again.`
  );
}

/**
 * Run `work` under an exclusive named store lock.
 *
 * With Web Locks available, exclusion is cross-tab (acquisition bounded by an
 * AbortSignal timeout). Without them, work calls are chained per name within
 * this tab (second critical section starts only after the first settles,
 * even when the first rejects); a stuck predecessor trips the same bound.
 * Chain entries are dropped once their run settles, so an idle lock name
 * never accumulates state and a fresh caller starts without a queue hop.
 */
export function withStoreLock<T>(
  name: string,
  work: () => Promise<T>,
  opts?: { lockManager?: LockManagerLike | null; acquireTimeoutMs?: number }
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
    return locks
      .request(name, { mode: 'exclusive', signal: controller.signal }, async () => {
        // Acquired: the timeout bounds WAITING only, never the critical
        // section itself.
        clearTimeout(timer);
        return work();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          throw acquireTimeoutError(name, timeoutMs);
        }
        throw error;
      })
      .finally(() => {
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
  return track(run);
}
