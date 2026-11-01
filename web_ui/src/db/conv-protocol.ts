/**
 * conv-protocol — the shared-workstation conversation protocol (issue #34
 * item 6p; plan REVISIONs 3-7: R3-1/R4-2/R4-3/R5-2/R5-3/R5-6/R6-1/R6-3/R6-4/
 * R7-1/R7-2).
 *
 * Four coordinated mechanisms replace the naive "each tab writes whenever"
 * model:
 *
 *  1. Web Locks wrappers — origin-wide arbitration. `docqa-conv-write`
 *     serializes every conversation mutation across tabs; `docqa-session-
 *     active` (SHARED holders = active/busy tabs, EXCLUSIVE ifAvailable
 *     acquisition = the workstation is quiet) arbitrates clears and boot
 *     replays so an idle tab can never clear under an active colleague.
 *     Web Locks auto-release on tab death, so a crashed holder cannot wedge
 *     arbitration (R6-3). Without Web Locks the wrappers degrade to
 *     single-tab passthrough and the features that REQUIRE cross-tab
 *     arbitration (auto legacy adoption, inactivity auto-clear) disable
 *     themselves (R5-2/R5-4).
 *
 *  2. Database epoch — the per-profile conversations db carries a `meta`
 *     table with a monotonic `epoch`. A clear bumps the epoch and empties the
 *     conversations table in ONE rw transaction. Every mutation re-reads the
 *     epoch inside its own rw transaction and aborts (no-op) unless it
 *     matches the epoch the caller's state was loaded under — an
 *     IndexedDB-atomic stale-write gate (R4-3/R5-3).
 *
 *  3. Pending-clear record + boot replay — a clear first writes
 *     {pending: {epochGoal, profile}} to localStorage (this write IS the
 *     cross-tab storage event), then clears, then writes {completed}. A boot
 *     (or the 30 s re-arm poll) replays a still-pending record to its goal,
 *     arbitrated by the exclusive active-lock and bound to the RECORDED
 *     profile's db (R5-6/R6-4/R7-2).
 *
 *  4. Legacy adoption claim — the pre-profile SHARED db `docqa_conversations`
 *     is adopted by exactly one profile, arbitrated by an IndexedDB-atomic
 *     claim row inside the legacy db itself (version-bumped `meta` store);
 *     localStorage is only a done-marker fast path (R7-1).
 */

import {
  CONVERSATIONS_CLEARED_KEY,
  LEGACY_CONV_MIGRATION_DONE_KEY,
} from '../lib/storage/persisted-keys';
import { getProfilePrefix } from '../lib/storage/profile';
import { db, DocQADatabase, LEGACY_CONVERSATIONS_DB_NAME } from './index';

// ============================================================================
// Web Locks wrappers
// ============================================================================

interface LockLike {
  name: string;
  mode: 'exclusive' | 'shared';
}

type LockManagerLike = {
  request<T>(
    name: string,
    options: { mode?: 'shared' | 'exclusive'; ifAvailable?: boolean },
    callback: (lock: LockLike | null) => T | PromiseLike<T>,
  ): Promise<T>;
};

function locksManager(): LockManagerLike | undefined {
  try {
    if (typeof navigator !== 'undefined') {
      const locks = (navigator as { locks?: LockManagerLike }).locks;
      if (locks !== undefined && typeof locks.request === 'function') return locks;
    }
  } catch {
    /* navigator unavailable */
  }
  return undefined;
}

/** Web Locks availability (secure-context only). Governs every feature here. */
export function hasWebLocks(): boolean {
  return locksManager() !== undefined;
}

/**
 * Origin-wide write serialization (R4-3): every conversation mutation (and
 * the clear itself) runs inside this. Without Web Locks it degrades to a
 * direct call (single-tab semantics).
 */
export function withConversationWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const locks = locksManager();
  if (locks === undefined) return Promise.resolve(fn());
  return locks.request('docqa-conv-write', {}, () => fn());
}

/** A held lock handle; release() is idempotent. */
export interface HeldLock {
  release(): void;
}

const NOOP_HELD: HeldLock = {
  release() {},
};

/**
 * Hold the session-active lock in SHARED mode (R6-3): every active OR busy
 * tab holds one; the clear/replay may only proceed when none is held.
 * Resolves null when the lock was not immediately available (should not
 * happen for shared mode unless an exclusive holder exists).
 */
export async function holdSessionActiveShared(): Promise<HeldLock | null> {
  const locks = locksManager();
  if (locks === undefined) return NOOP_HELD; // degraded: always "held"
  let released!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    released = resolve;
  });
  let grant!: (held: HeldLock | null) => void;
  const granted = new Promise<HeldLock | null>((resolve) => {
    grant = resolve;
  });
  let settleRelease: (() => void) | null = null;
  void locks
    .request('docqa-session-active', { mode: 'shared', ifAvailable: true }, (lock) => {
      if (lock === null) {
        grant(null);
        return undefined;
      }
      settleRelease = released;
      grant({
        release: () => {
          settleRelease?.();
        },
      });
      // Hold the shared lock until release().
      return releasePromise;
    })
    .catch(() => grant(null));
  return granted;
}

export interface ExclusiveAcquisition {
  acquired: boolean;
  release(): void;
}

const NOT_ACQUIRED: ExclusiveAcquisition = { acquired: false, release() {} };

/**
 * Try to acquire the session-active lock EXCLUSIVELY, without waiting
 * (R6-3): succeeds only when NO tab is active or busy — the workstation is
 * quiet. Without Web Locks it reports acquired (single-tab semantics; the
 * callers that require real arbitration disable themselves via
 * hasWebLocks()).
 */
export async function tryAcquireSessionActiveExclusive(): Promise<ExclusiveAcquisition> {
  const locks = locksManager();
  if (locks === undefined) return { acquired: true, release() {} };
  return new Promise<ExclusiveAcquisition>((resolve) => {
    let settleRelease: (() => void) | null = null;
    void locks
      .request('docqa-session-active', { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(NOT_ACQUIRED);
          return undefined;
        }
        let released!: () => void;
        const releasePromise = new Promise<void>((res) => {
          released = res;
        });
        settleRelease = released;
        resolve({ acquired: true, release: () => settleRelease?.() });
        return releasePromise;
      })
      .catch(() => resolve(NOT_ACQUIRED));
  });
}

// ============================================================================
// Database epoch (R4-3)
// ============================================================================

const EPOCH_META_KEY = 'epoch';
const LEGACY_CLAIM_META_KEY = 'legacy-adopt-claim';

export interface LegacyAdoptClaim {
  target: string;
  phase: 'copying' | 'done';
}

type DocQaDb = DocQADatabase;

async function readEpochOf(target: DocQaDb): Promise<number> {
  try {
    // Fast guard: without IndexedDB (jsdom test environments) the epoch is
    // unreadable — resolve 0 immediately instead of waking Dexie's open
    // machinery (which can involve timers and would slow every gated call).
    if (typeof indexedDB === 'undefined') return 0;
    const row = await target.meta.get(EPOCH_META_KEY);
    const value = row?.value;
    return typeof value === 'number' ? value : 0;
  } catch {
    return 0;
  }
}

/** The active profile's conversations-db epoch (0 when unreadable/fresh). */
export async function readConversationEpoch(): Promise<number> {
  return readEpochOf(db);
}

/**
 * Run `mutate` in ONE Dexie rw transaction over conversations+meta, gated on
 * the epoch still equaling `stateEpoch` (R4-3/R5-3): the epoch is re-read
 * INSIDE the transaction and the mutation is skipped (transaction commits
 * nothing) when it moved — a save enqueued before a clear can never
 * resurrect cleared history. Returns true when the mutation was applied.
 */
export async function withEpochGate(
  stateEpoch: number,
  mutate: () => unknown,
): Promise<boolean> {
  let applied = false;
  try {
    await db.transaction('rw', db.conversations, db.meta, async () => {
      const current = await readEpochOf(db);
      if (current !== stateEpoch) return;
      await mutate();
      applied = true;
    });
  } catch (error) {
    console.warn('[conv-protocol] epoch-gated mutation aborted:', error);
    return false;
  }
  return applied;
}

/** Open (or reuse) the conversations db for an arbitrary profile prefix. */
function conversationsDbNameFor(profile: string): string {
  return `${profile}-doc-qa-conversations`;
}

function openProfileDb(profile: string): DocQaDb {
  return new DocQADatabase(conversationsDbNameFor(profile));
}

// ============================================================================
// Pending-clear record + cross-tab reset propagation (R5-6/R6-4)
// ============================================================================

export interface ClearRecord {
  pending: { epochGoal: number; profile: string } | null;
  completed: { epochGoal: number } | null;
}

const EMPTY_RECORD: ClearRecord = { pending: null, completed: null };

export function readClearRecord(): ClearRecord {
  try {
    if (typeof localStorage === 'undefined') return EMPTY_RECORD;
    const raw = localStorage.getItem(CONVERSATIONS_CLEARED_KEY);
    if (raw === null) return EMPTY_RECORD;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return EMPTY_RECORD;
    const record = parsed as { pending?: unknown; completed?: unknown };
    const pending =
      record.pending !== null && typeof record.pending === 'object'
        ? (record.pending as { epochGoal?: unknown; profile?: unknown })
        : null;
    const completed =
      record.completed !== null && typeof record.completed === 'object'
        ? (record.completed as { epochGoal?: unknown })
        : null;
    return {
      pending:
        pending !== null && typeof pending.epochGoal === 'number' && typeof pending.profile === 'string'
          ? { epochGoal: pending.epochGoal, profile: pending.profile }
          : null,
      completed:
        completed !== null && typeof completed.epochGoal === 'number'
          ? { epochGoal: completed.epochGoal }
          : null,
    };
  } catch {
    return EMPTY_RECORD;
  }
}

function writeClearRecord(record: ClearRecord): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CONVERSATIONS_CLEARED_KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable — the epoch gate still protects the db */
  }
}

function markCompleted(epochGoal: number): void {
  const record = readClearRecord();
  writeClearRecord({
    pending: null,
    completed: { epochGoal: Math.max(epochGoal, record.completed?.epochGoal ?? 0) },
  });
}

export type ClearAllResult = { cleared: boolean } | { deferred: true };

/**
 * The full clear protocol (R5-6/R6-4): write the pending record (this
 * localStorage write IS the cross-tab storage event that resets other tabs),
 * arbitrate the workstation via the EXCLUSIVE session-active lock (busy or
 * active colleagues defer the clear), then under the origin-wide write lock
 * run ONE epoch transaction: bump the epoch to the goal (only when the db is
 * still behind it — idempotent) and empty the conversations table. The
 * pending record resolves to completed either way, so a crash between the
 * pending write and the transaction replays harmlessly at boot (R7-2's
 * currentEpoch >= goal → mark completed arm).
 */
export async function clearAllConversationsInDb(
  profile: string = getProfilePrefix(),
): Promise<ClearAllResult> {
  const isCurrent = profile === getProfilePrefix();
  const target = isCurrent ? db : openProfileDb(profile);
  const epochGoal = (await readEpochOf(target)) + 1;
  writeClearRecord({ pending: { epochGoal, profile }, completed: readClearRecord().completed });
  const exclusive = await tryAcquireSessionActiveExclusive();
  if (!exclusive.acquired) {
    if (!isCurrent) target.close();
    // Pending stays recorded: the boot replay / re-arm poll retries it once
    // the workstation is quiet.
    return { deferred: true };
  }
  try {
    await withConversationWriteLock(async () => {
      await target.transaction('rw', target.conversations, target.meta, async () => {
        const current = await readEpochOf(target);
        if (current < epochGoal) {
          await target.meta.put({ key: EPOCH_META_KEY, value: epochGoal });
          await target.conversations.clear();
        }
      });
      markCompleted(epochGoal);
    });
    return { cleared: true };
  } finally {
    if (!isCurrent) target.close();
    exclusive.release();
  }
}

/**
 * Boot replay (R6-4/R7-2): resolve a still-pending clear before any
 * conversation load. Arbitrated — a busy/active tab defers the replay (the
 * caller's re-arm poll retries). Profile-bound: the RECORDED profile's db is
 * opened by name, so a profile switch cannot misdirect the replay. The tx
 * runs only while the db's epoch is below the goal; a goal already met is
 * just marked completed (crash-after-commit never strands the boot).
 */
export async function replayPendingConversationClear(): Promise<{ replayed: boolean; deferred: boolean }> {
  const record = readClearRecord();
  const pending = record.pending;
  if (pending === null) return { replayed: false, deferred: false };
  if (record.completed !== null && record.completed.epochGoal >= pending.epochGoal) {
    return { replayed: false, deferred: false };
  }
  const exclusive = await tryAcquireSessionActiveExclusive();
  if (!exclusive.acquired) return { replayed: false, deferred: true };
  try {
    await withConversationWriteLock(async () => {
      const isCurrent = pending.profile === getProfilePrefix();
      const target = isCurrent ? db : openProfileDb(pending.profile);
      try {
        const current = await readEpochOf(target);
        if (current < pending.epochGoal) {
          await target.transaction('rw', target.conversations, target.meta, async () => {
            const now = await readEpochOf(target);
            if (now < pending.epochGoal) {
              await target.meta.put({ key: EPOCH_META_KEY, value: pending.epochGoal });
              await target.conversations.clear();
            }
          });
        }
        markCompleted(pending.epochGoal);
      } finally {
        if (!isCurrent) target.close();
      }
    });
    return { replayed: true, deferred: false };
  } catch (error) {
    console.warn('[conv-protocol] pending-clear replay failed:', error);
    return { replayed: false, deferred: false };
  } finally {
    exclusive.release();
  }
}

/**
 * Subscribe to the cross-tab clear notification (the storage event on the
 * cleared-at record). The callback runs in EVERY other tab that has the app
 * open; it must perform that tab's in-memory reset (streams cancelled by the
 * session-clear bus, state reloaded). Returns the unsubscribe function.
 */
export function onConversationsCleared(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: StorageEvent): void => {
    if (event.key !== CONVERSATIONS_CLEARED_KEY) return;
    if (event.newValue === null) return; // removal, not a clear
    try {
      cb();
    } catch (error) {
      console.warn('[conv-protocol] cleared-notification handler failed:', error);
    }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

// ============================================================================
// Legacy shared-conversations adoption (R3-1/R4-2/R5-2/R6-1/R7-1)
// ============================================================================

export type AdoptResult =
  | { outcome: 'adopted'; count: number }
  | { outcome: 'already-done' }
  | { outcome: 'nothing-to-adopt' }
  | {
      outcome: 'refused';
      reason: 'profile-not-empty' | 'in-flight';
      inFlightTarget?: string;
    };

function legacyDoneMarkerSet(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LEGACY_CONV_MIGRATION_DONE_KEY) === '1';
  } catch {
    return false;
  }
}

function setLegacyDoneMarker(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LEGACY_CONV_MIGRATION_DONE_KEY, '1');
  } catch {
    /* flag-write failure: the claim row stays 'done'; the next attempt is a
       bulkPut no-op that re-marks and deletes (R5-2) */
  }
}

function deleteLegacyDb(): Promise<void> {
  const legacy = new DocQADatabase(LEGACY_CONVERSATIONS_DB_NAME);
  return legacy.delete().catch(() => {
    legacy.close();
  });
}

/**
 * Adopt the legacy SHARED conversations db into profile `target` (R7-1).
 * Concurrency authority is the legacy database itself: opened with a
 * version-bumped `meta` claim store, ONE rw transaction decides —
 *   claim exists, different target → REFUSED naming the in-flight target;
 *   claim exists, this target → resume (retry after any crash, bulkPut
 *   idempotent);
 *   no claim → guarded write of {target, phase:'copying'} (refused when the
 *   active profile already has conversations — R6-1).
 * Then: read every legacy conversation, ONE bulkPut transaction into the
 * profile db, flip the claim to 'done', write the localStorage done-marker
 * (fast path only), delete the legacy db. The legacy db is deleted only
 * after the done phase.
 */
export async function adoptLegacyConversations(target: string): Promise<AdoptResult> {
  if (legacyDoneMarkerSet()) {
    // Fast path: a previous adoption completed; clean up a legacy db that
    // survived a crash between the marker write and the delete (R4-2).
    await deleteLegacyDb();
    return { outcome: 'already-done' };
  }

  const legacy = new DocQADatabase(LEGACY_CONVERSATIONS_DB_NAME);
  const profileDb = target === getProfilePrefix() ? db : openProfileDb(target);
  try {
    let resume = false;
    // ONE rw transaction on the legacy db decides the claim.
    await legacy.transaction('rw', legacy.meta, async () => {
      const claimRow = await legacy.meta.get(LEGACY_CLAIM_META_KEY);
      const claim = claimRow?.value;
      if (claim !== undefined && typeof claim === 'object' && claim !== null && 'target' in claim) {
        const existing = claim as LegacyAdoptClaim;
        if (existing.target !== target) {
          throw new AdoptRefusal('in-flight', existing.target);
        }
        resume = true; // same target: continue the protocol (idempotent)
        return;
      }
      const legacyCount = await legacy.conversations.count();
      if (legacyCount === 0) {
        throw new AdoptRefusal('nothing');
      }
      const profileCount = await profileDb.conversations.count();
      if (profileCount > 0) {
        throw new AdoptRefusal('profile-not-empty');
      }
      await legacy.meta.put({ key: LEGACY_CLAIM_META_KEY, value: { target, phase: 'copying' } });
    });

    if (!resume) {
      // Fresh claim: re-check emptiness outside the tx is unnecessary — the
      // guard above ran inside the claim transaction.
    }

    // Copy: read all legacy rows, ONE bulkPut tx into the profile db.
    const rows = await legacy.conversations.toArray();
    await profileDb.transaction('rw', profileDb.conversations, async () => {
      await profileDb.conversations.bulkPut(rows);
    });

    // Flip the claim to done, then marker, then delete.
    await legacy.transaction('rw', legacy.meta, async () => {
      await legacy.meta.put({ key: LEGACY_CLAIM_META_KEY, value: { target, phase: 'done' } });
    });
    setLegacyDoneMarker();
    await legacy.delete();
    return { outcome: 'adopted', count: rows.length };
  } catch (error) {
    if (error instanceof AdoptRefusal) {
      if (error.reason === 'nothing') {
        // The legacy db is absent (our open created an empty shell) or has
        // nothing to adopt: mark done and remove the empty shell (R4-2).
        setLegacyDoneMarker();
        await legacy.delete().catch(() => {});
        return { outcome: 'nothing-to-adopt' };
      }
      return { outcome: 'refused', reason: error.reason, inFlightTarget: error.inFlightTarget };
    }
    console.warn('[conv-protocol] legacy adoption failed (retryable):', error);
    return { outcome: 'refused', reason: 'in-flight', inFlightTarget: undefined };
  } finally {
    if (target !== getProfilePrefix()) profileDb.close();
  }
}

class AdoptRefusal extends Error {
  reason: 'profile-not-empty' | 'in-flight' | 'nothing';
  inFlightTarget?: string;
  constructor(reason: 'profile-not-empty' | 'in-flight' | 'nothing', inFlightTarget?: string) {
    super(`legacy-adoption refusal: ${reason}`);
    this.reason = reason;
    this.inFlightTarget = inFlightTarget;
  }
}

/**
 * Automatic legacy adoption at boot (R4-2/R5-2): ONLY when Web Locks exist
 * (multi-tab arbitration), guarded by the done-marker fast path, and run
 * under the origin-wide migration lock so simultaneous boots serialize; the
 * second tab sees the marker (or the claim) and refuses.
 */
export async function maybeAutoMigrateLegacyConversations(): Promise<void> {
  if (!hasWebLocks()) return; // R5-2: never touched automatically
  if (legacyDoneMarkerSet()) {
    await deleteLegacyDb();
    return;
  }
  const locks = locksManager();
  if (locks === undefined) return;
  try {
    await locks.request('docqa-conv-migration', {}, async () => {
      // Re-check inside the lock: another tab may have completed.
      if (legacyDoneMarkerSet()) {
        await deleteLegacyDb();
        return;
      }
      await adoptLegacyConversations(getProfilePrefix());
    });
  } catch (error) {
    console.warn('[conv-protocol] automatic legacy migration failed:', error);
  }
}
