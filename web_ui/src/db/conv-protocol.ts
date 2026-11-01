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
 *  3. Pending-clear record + boot replay — a clear ARBITRATES FIRST (the
 *     exclusive session-active lock; a busy/active colleague defers with
 *     NOTHING persisted, so other tabs never see a deferred clear), then
 *     writes {pending: {epochGoal, profile}} to localStorage (this write IS
 *     the cross-tab storage event), then clears, then writes {completed}. A
 *     boot (or the 30 s re-arm poll) replays a still-pending record to its
 *     goal, arbitrated by the same exclusive lock and bound to the RECORDED
 *     profile's db (R5-6/R6-4/R7-2, review F4).
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
  /**
   * Reviewer round 2 F3: the target profile db's epoch BOUND AT (RE)CLAIM
   * TIME. Every copy page re-reads the epoch inside its own transaction and
   * aborts when it moved — a clear that raced the adoption can never be
   * resurrected (pages that landed pre-clear are wiped BY the clear; pages
   * that would land post-clear are blocked by their own in-transaction
   * check, since IndexedDB serializes rw transactions on the same stores).
   * Absent only on claim rows written before this field existed; a resume
   * re-binds it to the current epoch.
   */
  epoch?: number;
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
 * resurrect cleared history. Returns true when the mutation was applied,
 * false ONLY for a genuine epoch mismatch (the gate aborting a stale write).
 * A genuine write failure (IndexedDB error, quota, transaction abort)
 * PROPAGATES to the caller (PRR-105, PR #264 review): the old catch-all
 * flattened every real error into a benign `false`, regressing base's
 * user-visible save/delete/rename failure banners.
 */
export async function withEpochGate(
  stateEpoch: number,
  mutate: () => unknown,
): Promise<boolean> {
  let applied = false;
  await db.transaction('rw', db.conversations, db.meta, async () => {
    const current = await readEpochOf(db);
    if (current !== stateEpoch) return;
    await mutate();
    applied = true;
  });
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
  /**
   * Reviewer round 2 F2 (on PRR-104): PER-PROFILE completed goals — a map of
   * profile prefix → highest completed clear goal. The record is origin-wide
   * storage, so any single origin-wide goal is wrong in both directions: a
   * profile-less value suppressed EVERY profile's crashed pending replay,
   * and a max-goal relabelled with the caller's profile let profile Q's
   * earlier goal-5 completed suppress profile P's later goal-2 pending. Each
   * profile's marker is independent. Legacy records ({epochGoal}, with or
   * without a round-1 `profile` field) are migrated on read; a profile-less
   * legacy value never suppresses anything.
   */
  completed: { [profile: string]: number } | null;
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
    const completedRaw =
      record.completed !== null && typeof record.completed === 'object'
        ? (record.completed as { epochGoal?: unknown; profile?: unknown; [key: string]: unknown })
        : null;
    let completed: { [profile: string]: number } | null = null;
    if (completedRaw !== null) {
      if (typeof completedRaw.epochGoal === 'number') {
        // Legacy single-goal shapes. A round-1 record carries the profile the
        // goal belongs to; the older profile-less value is attributable to no
        // profile and never suppresses a replay (falling through is safe:
        // the replay is idempotent).
        completed =
          typeof completedRaw.profile === 'string' ? { [completedRaw.profile]: completedRaw.epochGoal } : null;
      } else {
        const map: { [profile: string]: number } = {};
        for (const [key, value] of Object.entries(completedRaw)) {
          if (typeof value === 'number') map[key] = value;
        }
        completed = map;
      }
    }
    return {
      pending:
        pending !== null && typeof pending.epochGoal === 'number' && typeof pending.profile === 'string'
          ? { epochGoal: pending.epochGoal, profile: pending.profile }
          : null,
      completed,
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

function markCompleted(epochGoal: number, profile: string): void {
  const record = readClearRecord();
  const previous = record.completed ?? {};
  writeClearRecord({
    pending: null,
    completed: {
      ...previous,
      // Only THIS profile's goal moves; every other profile's marker stays.
      [profile]: Math.max(epochGoal, previous[profile] ?? 0),
    },
  });
}

export type ClearAllResult = { cleared: boolean } | { deferred: true };

/**
 * The full clear protocol (R5-6/R6-4), LOCKS-FIRST (review F4 — the same
 * order the boot replay uses): arbitrate the workstation via the EXCLUSIVE
 * session-active lock FIRST; a busy or active colleague defers the clear
 * WITHOUT writing anything — a deferred clear must be invisible to other
 * tabs, because the pending record's localStorage write IS the cross-tab
 * storage event that resets them (an un-arbitrated write would cancel a
 * colleague's in-flight stream and wipe their in-memory state for a clear
 * that never ran). Only after acquisition: write the pending record, then
 * under the origin-wide write lock run ONE epoch transaction — bump the
 * epoch to the goal (only when the db is still behind it — idempotent) and
 * empty the conversations table — then resolve the record to completed.
 * Crash windows are unchanged in substance: a crash before the pending
 * write leaves nothing persisted (nothing cleared, nothing to replay); a
 * crash between the pending write and the transaction replays harmlessly
 * at boot (R7-2's currentEpoch >= goal → mark completed arm).
 */
export async function clearAllConversationsInDb(
  profile: string = getProfilePrefix(),
): Promise<ClearAllResult> {
  // PRR-103 (PR #264 review): resolve the destructive target BY NAME from
  // the PASSED prefix — never the module-bound `db` singleton. The singleton
  // fixes its name at import under whatever profile was live then, so a
  // stale tab (loaded under profile A, while another tab switched the shared
  // PROFILE_KEY to B) computed isCurrent=true and destroyed A's database
  // while booking the pending record against B — replay then cleared B too.
  // The singleton is reused only when its ACTUAL name matches the passed
  // profile's derived name; the pending record, the epoch transaction and
  // the completed marker all target the passed profile's own database.
  const targetName = conversationsDbNameFor(profile);
  const target = targetName === db.name ? db : openProfileDb(profile);
  const targetIsSingleton = target === db;
  // LOCKS FIRST: a deferred clear persists NOTHING (review F4).
  const exclusive = await tryAcquireSessionActiveExclusive();
  if (!exclusive.acquired) {
    if (!targetIsSingleton) target.close();
    return { deferred: true };
  }
  try {
    const epochGoal = (await readEpochOf(target)) + 1;
    writeClearRecord({ pending: { epochGoal, profile }, completed: readClearRecord().completed });
    await withConversationWriteLock(async () => {
      await target.transaction('rw', target.conversations, target.meta, async () => {
        const current = await readEpochOf(target);
        if (current < epochGoal) {
          await target.meta.put({ key: EPOCH_META_KEY, value: epochGoal });
          await target.conversations.clear();
        }
      });
      markCompleted(epochGoal, profile);
    });
    return { cleared: true };
  } finally {
    if (!targetIsSingleton) target.close();
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
  // Reviewer round 2 F2: only the PENDING PROFILE'S OWN completed goal may
  // suppress its replay, and only when it covers the pending goal. The
  // record is origin-wide storage; every other profile's marker (and any
  // legacy profile-less value) is irrelevant here — falling through is safe:
  // the replay is idempotent (epoch-goal check).
  const completedGoal = record.completed?.[pending.profile];
  if (completedGoal !== undefined && completedGoal >= pending.epochGoal) {
    return { replayed: false, deferred: false };
  }
  const exclusive = await tryAcquireSessionActiveExclusive();
  if (!exclusive.acquired) return { replayed: false, deferred: true };
  try {
    await withConversationWriteLock(async () => {
      // PRR-103: resolve the replay target by the RECORDED profile's derived
      // name (never the module-bound singleton's name).
      const targetName = conversationsDbNameFor(pending.profile);
      const target = targetName === db.name ? db : openProfileDb(pending.profile);
      const targetIsSingleton = target === db;
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
        markCompleted(pending.epochGoal, pending.profile);
      } finally {
        if (!targetIsSingleton) target.close();
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
      reason: 'profile-not-empty' | 'in-flight' | 'superseded';
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

/** Legacy copy page size (PRR-121): bounds peak memory during adoption. */
const LEGACY_ADOPT_PAGE = 500;

/**
 * Copy every legacy conversation into the profile db, one
 * {@link LEGACY_ADOPT_PAGE}-row page at a time (PRR-121: peak memory stays
 * bounded instead of holding the whole legacy store in one array), under the
 * origin-wide conversation write lock (PRR-106) so the copy serializes with
 * every other conversation mutation.
 *
 * Reviewer round 2 F3 (on PRR-106): the mid-copy EMPTINESS re-check is GONE —
 * after a crash between pages the retry's own page-1 rows made the target
 * non-empty and wedged the resume forever. The supersede guard is now the
 * EPOCH, bound at (re)claim time: every page re-reads the target db's epoch
 * INSIDE its own rw transaction and the adoption aborts ('superseded') when
 * it moved. Proof: a clear is one rw transaction that bumps the epoch and
 * empties the table; a copy page is another rw transaction on the same
 * stores; IndexedDB serializes them — every page that landed before the
 * clear is wiped by the clear itself, and every page that would land after
 * it is blocked by its own in-transaction epoch check. No resurrection is
 * possible, and a resume-after-crash never mistakes its own partial copy for
 * a superseding write. Each page's transaction spans BOTH profile stores
 * (conversations + meta) so the epoch read is atomic with the bulkPut — a
 * clear transaction cannot interleave between the check and the write.
 * Idempotent by row id (bulkPut), so re-copying pages a
 * crashed run already wrote is safe. Returns the number of rows copied.
 */
async function copyLegacyRowsIntoProfile(
  legacy: DocQaDb,
  profileDb: DocQaDb,
  boundEpoch: number,
): Promise<number> {
  return withConversationWriteLock(async () => {
    let offset = 0;
    let copied = 0;
    for (;;) {
      const page = await legacy.conversations
        .orderBy('id')
        .offset(offset)
        .limit(LEGACY_ADOPT_PAGE)
        .toArray();
      if (page.length === 0) break;
      await profileDb.transaction('rw', [profileDb.conversations, profileDb.meta], async () => {
        const now = await readEpochOf(profileDb);
        if (now !== boundEpoch) {
          // A clear moved the target db during the adoption: superseded.
          throw new AdoptRefusal('superseded');
        }
        await profileDb.conversations.bulkPut(page);
      });
      offset += page.length;
      copied += page.length;
    }
    return copied;
  });
}

/**
 * PRR-111 (PR #264 review): the done-marker fast path used to delete a
 * surviving legacy db without inspecting it — rows written by a mixed-build
 * or rolled-back tab AFTER the adoption completed were lost unrecoverably
 * (and the PR's rollback claim was false). Before deleting, re-run the
 * (idempotent, by-id) adoption copy when rows remain, then delete. A failed
 * copy skips the delete so the rows survive for a later attempt.
 */
async function deleteLegacyDbAfterReadopt(target: string): Promise<void> {
  const legacy = new DocQADatabase(LEGACY_CONVERSATIONS_DB_NAME);
  try {
    const remaining = await legacy.conversations.count();
    if (remaining > 0) {
      const targetName = conversationsDbNameFor(target);
      const profileDb = targetName === db.name ? db : openProfileDb(target);
      try {
        // Reviewer round 2 F3: the re-adopt copy is epoch-bound too (a clear
        // racing the re-adopt aborts it instead of resurrecting rows); the
        // binding is read fresh here — the target legitimately holds rows of
        // its own at this point, so emptiness is no signal at all.
        const boundEpoch = await readEpochOf(profileDb);
        await copyLegacyRowsIntoProfile(legacy, profileDb, boundEpoch);
      } finally {
        if (profileDb !== db) profileDb.close();
      }
    }
  } catch (error) {
    // Keep the legacy db (and its rows) for a later retry.
    console.warn('[conv-protocol] legacy re-adoption before delete failed:', error);
    legacy.close();
    return;
  }
  await legacy.delete().catch(() => {
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
 * The claim transaction is scoped over BOTH legacy stores (PRR-101, PR #264
 * review): it reads legacy.conversations.count() inside, and a Dexie/IndexedDB
 * transaction only has the stores it was opened with — a meta-only scope made
 * the conversations read throw NotFoundError in a real browser (the adoption
 * NEVER succeeded there; the in-memory fake's scope-ignoring transactions
 * masked it, and the fake now enforces scope too).
 * Then: copy the legacy rows page-by-page into the profile db (PRR-121) under
 * the origin-wide write lock, EPOCH-BOUND to the claim (reviewer round 2 F3:
 * the mid-copy emptiness re-check is replaced by a per-page in-transaction
 * epoch check — see copyLegacyRowsIntoProfile), flip the claim to 'done',
 * write the localStorage done-marker (fast path only), delete the legacy db.
 * The legacy db is deleted only after the done phase.
 */
export async function adoptLegacyConversations(target: string): Promise<AdoptResult> {
  if (legacyDoneMarkerSet()) {
    // Fast path: a previous adoption completed; clean up a legacy db that
    // survived a crash between the marker write and the delete (R4-2) —
    // re-adopting any rows a mixed-build/rollback tab wrote after the
    // adoption before deleting them for good (PRR-111).
    await deleteLegacyDbAfterReadopt(target);
    return { outcome: 'already-done' };
  }

  const legacy = new DocQADatabase(LEGACY_CONVERSATIONS_DB_NAME);
  // Reviewer round 2 F-b (same class as PRR-103): resolve the target by
  // NAME — never the module-bound singleton's import-time binding.
  const profileDb = conversationsDbNameFor(target) === db.name ? db : openProfileDb(target);
  try {
    // ONE rw transaction over BOTH legacy stores decides the claim (PRR-101)
    // and resolves to the epoch the copy is bound to.
    const boundEpoch = await legacy.transaction(
      'rw',
      [legacy.conversations, legacy.meta],
      async (): Promise<number> => {
        const claimRow = await legacy.meta.get(LEGACY_CLAIM_META_KEY);
        const claim = claimRow?.value;
        if (claim !== undefined && typeof claim === 'object' && claim !== null && 'target' in claim) {
          const existing = claim as LegacyAdoptClaim;
          if (existing.target !== target) {
            throw new AdoptRefusal('in-flight', existing.target);
          }
          // Same target: RESUME the protocol (the copy below is idempotent —
          // reviewer round 2 F3: the adoption's own partial rows are not a
          // refusal). Bind the epoch: a pre-F3 claim row has none, so re-bind
          // it to the current epoch; rows a crashed run wrote before any clear
          // are safe to re-copy over.
          if (typeof existing.epoch === 'number') return existing.epoch;
          const rebound = await readEpochOf(profileDb);
          await legacy.meta.put({
            key: LEGACY_CLAIM_META_KEY,
            value: { ...existing, epoch: rebound },
          });
          return rebound;
        }
        // Fresh claim: the emptiness guards run INSIDE this transaction, so a
        // racing adopter cannot pass them and write a claim of its own.
        const legacyCount = await legacy.conversations.count();
        if (legacyCount === 0) {
          throw new AdoptRefusal('nothing');
        }
        const profileCount = await profileDb.conversations.count();
        if (profileCount > 0) {
          throw new AdoptRefusal('profile-not-empty');
        }
        const epoch = await readEpochOf(profileDb);
        await legacy.meta.put({
          key: LEGACY_CLAIM_META_KEY,
          value: { target, phase: 'copying', epoch },
        });
        return epoch;
      },
    );

    // Copy (PRR-106/PRR-121 + reviewer round 2 F3): under the write lock,
    // page-by-page, every page gated on the claim-bound epoch.
    const copied = await copyLegacyRowsIntoProfile(legacy, profileDb, boundEpoch);

    // Flip the claim to done, then marker, then delete.
    await legacy.transaction('rw', legacy.meta, async () => {
      await legacy.meta.put({ key: LEGACY_CLAIM_META_KEY, value: { target, phase: 'done' } });
    });
    setLegacyDoneMarker();
    await legacy.delete();
    return { outcome: 'adopted', count: copied };
  } catch (error) {
    if (error instanceof AdoptRefusal) {
      if (error.reason === 'nothing') {
        // The legacy db is absent (our open created an empty shell) or has
        // nothing to adopt: mark done and remove the empty shell (R4-2).
        setLegacyDoneMarker();
        await legacy.delete().catch(() => {});
        return { outcome: 'nothing-to-adopt' };
      }
      if (error.reason === 'superseded') {
        // A clear raced the copy. Drop the claim so a later adopt can
        // re-claim under the post-clear epoch instead of wedging on a stale
        // binding; the legacy db survives for that retry.
        await legacy.meta.delete(LEGACY_CLAIM_META_KEY).catch(() => {});
        return { outcome: 'refused', reason: 'superseded' };
      }
      return { outcome: 'refused', reason: error.reason, inFlightTarget: error.inFlightTarget };
    }
    console.warn('[conv-protocol] legacy adoption failed (retryable):', error);
    return { outcome: 'refused', reason: 'in-flight', inFlightTarget: undefined };
  } finally {
    if (profileDb !== db) profileDb.close();
  }
}

class AdoptRefusal extends Error {
  reason: 'profile-not-empty' | 'in-flight' | 'nothing' | 'superseded';
  inFlightTarget?: string;
  constructor(
    reason: 'profile-not-empty' | 'in-flight' | 'nothing' | 'superseded',
    inFlightTarget?: string,
  ) {
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
    await deleteLegacyDbAfterReadopt(getProfilePrefix());
    return;
  }
  const locks = locksManager();
  if (locks === undefined) return;
  try {
    await locks.request('docqa-conv-migration', {}, async () => {
      // Re-check inside the lock: another tab may have completed.
      if (legacyDoneMarkerSet()) {
        await deleteLegacyDbAfterReadopt(getProfilePrefix());
        return;
      }
      await adoptLegacyConversations(getProfilePrefix());
    });
  } catch (error) {
    console.warn('[conv-protocol] automatic legacy migration failed:', error);
  }
}
