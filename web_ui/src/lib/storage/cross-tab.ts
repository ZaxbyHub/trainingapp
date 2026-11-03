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
 *
 * The lock machinery itself (both paths, both bounds) now lives in the
 * shared `exclusive-lock.ts` helper (#275-C); `withStoreLock` is a thin
 * behavior-preserving wrapper over it.
 */

import {
  withExclusiveLock,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  type LockManagerLike,
} from './exclusive-lock';

export { DEFAULT_ACQUIRE_TIMEOUT_MS };
export type { LockManagerLike };

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
  return withExclusiveLock<T>(name, work, opts);
}
