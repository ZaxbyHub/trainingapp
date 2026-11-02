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
    options: { mode?: 'shared' | 'exclusive' },
    callback: (lock: unknown) => Promise<T>
  ): Promise<T>;
}

/** In-tab fallback chains: one per lock name, always settled. */
const localChains = new Map<string, Promise<unknown>>();

/**
 * Run `work` under an exclusive named store lock.
 *
 * With Web Locks available, exclusion is cross-tab. Without them, work calls
 * are chained per name within this tab (second critical section starts only
 * after the first settles, even when the first rejects).
 */
export function withStoreLock<T>(
  name: string,
  work: () => Promise<T>,
  opts?: { lockManager?: LockManagerLike | null }
): Promise<T> {
  const locks =
    opts && 'lockManager' in opts
      ? opts.lockManager
      : typeof navigator !== 'undefined'
        ? (navigator as { locks?: LockManagerLike }).locks
        : undefined;

  if (locks && typeof locks.request === 'function') {
    return locks.request(name, { mode: 'exclusive' }, () => work());
  }

  // In-tab fallback: chain per name. The chain itself swallows errors so a
  // rejected run neither blocks later runs nor produces unhandled rejections;
  // the CALLER's promise (`run`) still rejects.
  const prev = localChains.get(name) ?? Promise.resolve();
  const run = prev.then(work, work);
  localChains.set(
    name,
    run.catch(() => undefined)
  );
  return run;
}
