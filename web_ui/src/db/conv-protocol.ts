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
import { encryptRow, getOrCreateSecret, prefixOfDbName } from '../lib/storage/db-crypto';
import {
  db,
  DocQADatabase,
  LEGACY_CONVERSATIONS_DB_NAME,
  migrationReady,
  readEpochOf,
  requireKeyForWrite,
} from './index';
import { withExclusiveLock } from '../lib/storage/exclusive-lock';

/** The shared conv-write lock name (must equal index.ts's CONV_WRITE_LOCK). */
const CONV_WRITE_LOCK_NAME = 'docqa-conv-write';

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
 * the clear itself) runs inside this — through the shared exclusive-lock
 * helper since #367 RC6-01 (Web-Locks preferred; the in-tab chain is the
 * no-Web-Locks fallback, with the helper's 60 s acquisition bound).
 *
 * #367 RC6-01: routes through the shared `exclusive-lock.ts` helper — the
 * no-Web-Locks fallback is the in-tab promise chain (previously this
 * function degraded to a direct call; the approved plan supersedes that
 * #275-C divergence so every migration-serialized path shares one
 * serializer in both modes).
 */
export function withConversationWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  // #367 RC6-01 (approved plan): NO migration-serialized path keeps the
  // legacy direct-call degrade — every conv-write critical section runs
  // through the shared serializer (Web-Locks preferred, genuine in-tab
  // promise-chain fallback), so create/delete/clear/adoption/migration and
  // update serialize identically with AND without Web Locks. This
  // deliberately supersedes the pre-#367 #275-C divergence note (in-tab
  // serialization is now the documented contract).
  return withExclusiveLock(CONV_WRITE_LOCK_NAME, fn);
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

// #367: readEpochOf moved to index.ts (next to the meta-table accessor it
// reads, and to serve migrateUnderLock without an index->conv-protocol
// import cycle); re-exported here for the public seam conversations.ts uses.
export { readEpochOf };

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

/**
 * Presence-gated delete gate (#372 AC2): re-read the epoch, delete only an
 * existing row, and advance the epoch in the SAME transaction. A missing row
 * is a benign applied no-op and does not advance the epoch.
 */
export async function withAdvancingDeleteGate(
  stateEpoch: number,
  id: string,
): Promise<boolean> {
  let applied = false;
  await db.transaction('rw', db.conversations, db.meta, async () => {
    const current = await readEpochOf(db);
    if (current !== stateEpoch) return;
    if ((await db.conversations.get(id)) === undefined) {
      applied = true;
      return;
    }
    await db.conversations.delete(id);
    await db.meta.put({ key: EPOCH_META_KEY, value: current + 1 });
    // Permanent adoption tombstone: legacy rows can be recreated by an old or
    // mixed build, so deletion history must outlive the current profile row.
    await db.meta.put({ key: `legacy-tomb:${id}`, value: 1 });
    // M3v10 evidence belongs to the DELETE transaction, not the clear. An old
    // writer can observe this epoch advance, skip its owed clear, and then
    // falsely mark that goal completed. Recording the pending goal here lets
    // repair distinguish that false completion from a true clear.
    const pending = readClearRecord().pendingV2 ?? readClearRecord().pending;
    if (pending !== null && pending.profile === prefixOfDbName(db.name)) {
      await db.meta.put({ key: `${DELETE_POST_PREFIX}${String(pending.epochGoal)}`, value: Date.now() });
    }
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
  /** M3v10: old readers ignore this field; new readers use it for scoped tags. */
  pendingV2?: { epochGoal: number; profile: string } | null;
}

const EMPTY_RECORD: ClearRecord = { pending: null, completed: null };
const DELETE_POST_PREFIX = 'delete-post-';
const CLEARED_GOAL_PREFIX = 'cleared-goal:';

export function readClearRecord(): ClearRecord {
  try {
    if (typeof localStorage === 'undefined') return EMPTY_RECORD;
    const raw = localStorage.getItem(CONVERSATIONS_CLEARED_KEY);
    if (raw === null) return EMPTY_RECORD;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return EMPTY_RECORD;
    const record = parsed as { pending?: unknown; pendingV2?: unknown; completed?: unknown };
    const pending =
      record.pending !== null && typeof record.pending === 'object'
        ? (record.pending as { epochGoal?: unknown; profile?: unknown })
        : null;
    const pendingV2 =
      record.pendingV2 !== null && typeof record.pendingV2 === 'object'
        ? (record.pendingV2 as { epochGoal?: unknown; profile?: unknown })
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
    const normalizedPending =
      pending !== null && typeof pending.epochGoal === 'number' && typeof pending.profile === 'string'
        ? { epochGoal: pending.epochGoal, profile: pending.profile }
        : null;
    const normalizedV2 =
      pendingV2 !== null && typeof pendingV2.epochGoal === 'number' && typeof pendingV2.profile === 'string'
        ? { epochGoal: pendingV2.epochGoal, profile: pendingV2.profile }
        : null;
    return {
      pending: normalizedPending,
      completed,
      // Preserve the legacy observable shape unless v2 actually differs.
      ...(normalizedV2 !== null &&
      (normalizedPending === null ||
        normalizedV2.epochGoal !== normalizedPending.epochGoal ||
        normalizedV2.profile !== normalizedPending.profile)
        ? { pendingV2: normalizedV2 }
        : {}),
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
  const newerPending =
    record.pendingV2 !== null &&
    record.pendingV2 !== undefined &&
    record.pendingV2.profile === profile &&
    record.pendingV2.epochGoal > epochGoal
      ? record.pendingV2
      : null;
  writeClearRecord({
    pending: newerPending,
    ...(newerPending === null ? {} : { pendingV2: newerPending }),
    completed: {
      ...previous,
      // Only THIS profile's goal moves; every other profile's marker stays.
      [profile]: Math.max(epochGoal, previous[profile] ?? 0),
    },
  });
}

export type ClearAllResult = { cleared: boolean } | { deferred: true };

/** Execute one owed clear and its permanent evidence in the same transaction. */
async function executeClearGoal(target: DocQaDb, epochGoal: number): Promise<void> {
  await target.transaction('rw', target.conversations, target.meta, async () => {
    const current = await readEpochOf(target);
    if (current < epochGoal) {
      await target.meta.put({ key: EPOCH_META_KEY, value: epochGoal });
      await target.conversations.clear();
    }
  });
}

/**
 * Repair evidence-backed false completions (M3v10). Discovery is
 * completed[G] + delete-post-G + no cleared-goal >= G. The transaction
 * revalidates live state so a newer true clear supersedes a paused repair.
 */
export async function repairCompletedConversationClears(
  profile: string = getProfilePrefix(),
): Promise<number> {
  const targetName = conversationsDbNameFor(profile);
  const target = targetName === db.name ? db : openProfileDb(profile);
  const targetIsSingleton = target === db;
  try {
    if (typeof target.meta.where !== 'function') return 0;
    const record = readClearRecord();
    const completedGoal = record.completed?.[profile];
    if (completedGoal === undefined) return 0;
    const evidence = await target.meta.where('key').between(`${DELETE_POST_PREFIX}${String(completedGoal)}`, `${DELETE_POST_PREFIX}${String(completedGoal)}\uffff`).toArray();
    if (evidence.length === 0) return 0;
    const cleared = await target.meta.where('key').between(`${CLEARED_GOAL_PREFIX}${profile}`, `${CLEARED_GOAL_PREFIX}${profile}\uffff`).toArray();
    const clearedGoals = cleared.map((r) => typeof r.value === 'number' ? r.value : 0);
    if (clearedGoals.some((g) => g >= completedGoal)) return 0;
    let repaired = 0;
    let applied = false;
    await target.transaction('rw', target.conversations, target.meta, async () => {
      const live = readClearRecord();
      if (live.completed?.[profile] !== completedGoal) return;
      const liveCleared = await target.meta.where('key').between(`${CLEARED_GOAL_PREFIX}${profile}`, `${CLEARED_GOAL_PREFIX}${profile}\uffff`).toArray();
      if (liveCleared.some((r) => typeof r.value === 'number' && r.value >= completedGoal)) return;
      const liveEvidence = await target.meta.get(`${DELETE_POST_PREFIX}${String(completedGoal)}`);
      if (liveEvidence === undefined) return;
      const rows = await target.conversations.toArray();
      for (const row of rows) {
        const r = row as unknown as Record<string, unknown>;
        const keep = r['afterClear'] === completedGoal || r['sawPendingGoal'] === completedGoal;
        if (!keep) {
          await target.conversations.delete(String(r['id']));
          repaired += 1;
        }
      }
      const current = await readEpochOf(target);
      await target.meta.put({ key: EPOCH_META_KEY, value: Math.max(completedGoal, current + 1) });
      await target.meta.put({ key: `${CLEARED_GOAL_PREFIX}${profile}`, value: completedGoal });
      await target.meta.delete(`${DELETE_POST_PREFIX}${String(completedGoal)}`);
      applied = true;
    });
    if (applied) markCompleted(completedGoal, profile);
    return repaired;
  } finally {
    if (!targetIsSingleton) target.close();
  }
}

/**
 * Optional all-or-nothing clear hook (issue #279, plan B1/PC-4/PC2-2):
 * `beforeClear` runs AFTER the exclusive session-active lock is acquired
 * and BEFORE the pending-record write + persisted clear — inside the locked
 * section, so an in-tab reset (the session-clear handlers) can never run
 * for a clear that ends up deferred. On deferral it runs ZERO times.
 */
export interface ClearAllConversationsOptions {
  beforeClear?(): void | Promise<void>;
}

/**
 * The full clear protocol (R5-6/R6-4), LOCKS-FIRST (review F4 — the same
 * order the boot replay uses): arbitrate the workstation via the EXCLUSIVE
 * session-active lock FIRST — truly first: neither the beforeClear hook
 * (#279 B1) nor any other effect runs before the arbitration, so a busy or
 * active colleague defers the clear WITHOUT writing anything and WITHOUT
 * invoking beforeClear — a deferred clear must be invisible to other tabs,
 * because the pending record's localStorage write IS the cross-tab storage
 * event that resets them (an un-arbitrated write would cancel a colleague's
 * in-flight stream and wipe their in-memory state for a clear that never
 * ran). Only after acquisition: run beforeClear (awaited, still inside the
 * exclusive section), write the pending record, then under the origin-wide
 * write lock run ONE epoch transaction — bump the epoch to the goal (only
 * when the db is still behind it — idempotent) and empty the conversations
 * table — then resolve the record to completed. Crash windows are unchanged
 * in substance: a crash before the pending write leaves nothing persisted
 * (nothing cleared, nothing to replay); a crash between the pending write
 * and the transaction replays harmlessly at boot (R7-2's currentEpoch >=
 * goal → mark completed arm).
 */
export async function clearAllConversationsInDb(
  profile: string = getProfilePrefix(),
  options?: ClearAllConversationsOptions,
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
  // LOCKS FIRST: a deferred clear persists NOTHING (review F4) and never
  // invokes beforeClear (#279 B1 — the hook runs only inside the exclusive
  // section, so a deferred clear is a true no-op for this tab too).
  const exclusive = await tryAcquireSessionActiveExclusive();
  if (!exclusive.acquired) {
    if (!targetIsSingleton) target.close();
    return { deferred: true };
  }
  try {
    // #279 B1: the in-tab reset runs AFTER acquisition and BEFORE the
    // pending-record write — the all-or-nothing seam.
    await options?.beforeClear?.();
    let completedGoalValue = (await readEpochOf(target)) + 1;
    const pending = { epochGoal: completedGoalValue, profile };
    writeClearRecord({ pending, pendingV2: pending, completed: readClearRecord().completed });
    await withConversationWriteLock(async () => {
      await executeClearGoal(target, completedGoalValue);
      // Shared-lock interposition: a pending record written while the old
      // clear waited for this lock is owed BEFORE the old writer completes.
      for (;;) {
        const next = readClearRecord().pendingV2 ?? readClearRecord().pending;
        if (next === null || next === undefined || next.profile !== profile || next.epochGoal <= completedGoalValue) break;
        await executeClearGoal(target, next.epochGoal);
        completedGoalValue = next.epochGoal;
      }
      markCompleted(completedGoalValue, profile);
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
  await repairCompletedConversationClears(getProfilePrefix());
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
      // A live old-writer completion is the discovery signal for M3v10
      // repair. Run it before resetting this tab's in-memory state.
      void repairCompletedConversationClears(getProfilePrefix())
        .catch((error: unknown) => console.warn('[conv-protocol] live completion repair failed:', error))
        .finally(() => cb());
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
/**
 * The copy itself, WITHOUT lock acquisition (review round 2 finding 1: the
 * conv-write lock is NON-reentrant — the primary adoption's span already
 * holds it, and a nested same-name request would queue behind itself
 * forever). Callers either hold the lock (primary adoption) or take it here
 * (re-adoption via the public wrapper above).
 */
async function copyLegacyRowsIntoProfileUnlocked(
  legacy: DocQaDb,
  profileDb: DocQaDb,
  boundEpoch: number,
): Promise<number> {
  // #367: the target db post-migration is envelope-only (or empty) — the
  // copied plaintext legacy rows are encrypted under the TARGET profile's
  // key (prefixOfDbName, never the active profile's) with ONE secret minted
  // for the whole copy. Crypto runs OUTSIDE every transaction (PC-06): each
  // page is fully encrypted before its rw transaction opens.
  const targetPrefix = prefixOfDbName(profileDb.name);
  const secret = await getOrCreateSecret(targetPrefix);
  const tombstoneRows = typeof profileDb.meta.where === 'function'
    ? await profileDb.meta.where('key').between('legacy-tomb:', 'legacy-tomb:\uffff').toArray()
    : (await profileDb.meta.toArray()).filter((row) => row.key.startsWith('legacy-tomb:'));
  const tombstones = new Set(
    tombstoneRows.map((row) => row.key.slice('legacy-tomb:'.length)),
  );
  return (async () => {
    let offset = 0;
    let copied = 0;
    for (;;) {
      const page = await legacy.conversations
        .orderBy('id')
        .offset(offset)
        .limit(LEGACY_ADOPT_PAGE)
        .toArray();
      if (page.length === 0) break;
      // Offset advances by RAW page length; only filtered rows count as copied.
      offset += page.length;
      const live = page.filter((row) => !tombstones.has(String((row as { id?: unknown }).id)));
      if (live.length === 0) continue;
      const existing = new Map<string, Record<string, unknown>>();
      await profileDb.transaction('r', profileDb.conversations, async () => {
        for (const row of live) {
          const found = await profileDb.conversations.get(String((row as { id: string }).id));
          if (found !== undefined) existing.set(String((row as { id: string }).id), found as unknown as Record<string, unknown>);
        }
      });
      const record = readClearRecord();
      const envelopes = await Promise.all(
        live.map((row) => {
          const id = String((row as { id: string }).id);
          const prior = existing.get(id);
          const tagged: Record<string, unknown> = { ...(row as unknown as Record<string, unknown>) };
          if (prior !== undefined) {
            if (typeof prior['afterClear'] === 'number') tagged['afterClear'] = prior['afterClear'];
            else delete tagged['afterClear'];
            if (typeof prior['sawPendingGoal'] === 'number') tagged['sawPendingGoal'] = prior['sawPendingGoal'];
            else delete tagged['sawPendingGoal'];
          } else {
            if (record.completed?.[targetPrefix] !== undefined) tagged['afterClear'] = record.completed[targetPrefix];
            if (record.pendingV2?.profile === targetPrefix) tagged['sawPendingGoal'] = record.pendingV2.epochGoal;
          }
          return encryptRow(tagged as { id: string; createdAt: number; updatedAt: number }, secret, targetPrefix);
        }),
      );
      await profileDb.transaction('rw', [profileDb.conversations, profileDb.meta], async () => {
        const now = await readEpochOf(profileDb);
        if (now !== boundEpoch) {
          // A clear moved the target db during the adoption: superseded.
          throw new AdoptRefusal('superseded');
        }
        await profileDb.conversations.bulkPut(envelopes);
      });
      copied += live.length;
    }
    return copied;
  })();
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
      // #367: gate on the target's migration before re-copying (same plan-d
      // sequencing as the primary adoption path).
      await migrationReady(targetName);
      const profileDb = targetName === db.name ? db : openProfileDb(target);
      try {
        // #367 review rounds 2-3: the re-adoption copy gates on a FRESH
        // key-state matrix INSIDE the conversation lock (probe and copy are
        // one serialized operation), then reads the epoch binding.
        await withConversationWriteLock(async () => {
          await requireKeyForWrite(profileDb);
          // Reviewer round 2 F3: the re-adopt copy is epoch-bound too (a
          // clear racing the re-adopt aborts it instead of resurrecting
          // rows); the binding is read fresh here — the target legitimately
          // holds rows of its own at this point, so emptiness is no signal.
          const boundEpoch = await readEpochOf(profileDb);
          return copyLegacyRowsIntoProfileUnlocked(legacy, profileDb, boundEpoch);
        });
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
 * epoch check — see copyLegacyRowsIntoProfileUnlocked), flip the claim to 'done',
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

  const targetDbName = conversationsDbNameFor(target);
  // #367 (plan d): the target's first-open migration completes BEFORE the
  // claim transaction and the copy — the copy encrypts under a key whose
  // state the migration just established, and a claim can never be written
  // for a target that cannot actually receive rows.
  await migrationReady(targetDbName);
  const legacy = new DocQADatabase(LEGACY_CONVERSATIONS_DB_NAME);
  // Reviewer round 2 F-b (same class as PRR-103): resolve the target by
  // NAME — never the module-bound singleton's import-time binding.
  const profileDb = targetDbName === db.name ? db : openProfileDb(target);
  // #367 (PC-06 family, executed probe — see the adoption spec): the claim
  // transaction awaits profileDb reads inside its scope. If the first of
  // those awaits triggers profileDb's OPEN (a v2->v3 upgrade on a fresh
  // target), the macrotask gap lets the legacy IndexedDB transaction
  // auto-commit (TransactionInactiveError) BEFORE the claim decides.
  // Pre-opening both databases makes every in-tx read resolve within the
  // same microtask chain, and the claim keeps its legacy-side atomicity.
  await legacy.open();
  await profileDb.open();
  try {
    // ONE rw transaction over BOTH legacy stores decides the claim (PRR-101)
    // and resolves to the epoch the copy is bound to.
    // #367 (PC-06): the target-db reads (profileCount / epoch) happen BEFORE
    // the claim tx — an await on ANOTHER database inside a transaction scope
    // lets that transaction auto-commit during the foreign open/await gap
    // (executed probe: TransactionInactiveError on a fresh target). The
    // legacy-side atomicity is unchanged: the claim decision (claim row +
    // legacy count + claim write) still runs in ONE transaction over both
    // legacy stores; the profile-side guards keep their own serialization
    // (the copy is still epoch-bound per page, so a clear that lands after
    // these pre-reads supersedes the copy exactly as before).
    // #367 review F4: the target-emptiness decision, the claim and the copy
    // run under the SAME Web-Locks name as every conversation mutation, so a
    // create cannot land between the count and the copy (locks present).
    // Without Web Locks the degrade is the wrapper's documented direct call;
    // the copy's per-page epoch gate plus the legacy-id/uuid collision
    // residual stay disclosed in the PR body.
    const copied = await withConversationWriteLock(async () => {
      await requireKeyForWrite(profileDb); // fresh matrix gate (review F2)
      const profileCount = await profileDb.conversations.count();
      const profileEpoch = await readEpochOf(profileDb);
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
        // Fresh claim: the emptiness guards — legacy emptiness INSIDE the tx
        // (racing adopters cannot pass it and write a claim of their own);
        // profile emptiness/epoch pre-read OUTSIDE (PC-06, re-verified
        // page-by-page by the copy's epoch gate).
        const legacyCount = await legacy.conversations.count();
        if (legacyCount === 0) {
          throw new AdoptRefusal('nothing');
        }
        if (profileCount > 0) {
          throw new AdoptRefusal('profile-not-empty');
        }
        await legacy.meta.put({
          key: LEGACY_CLAIM_META_KEY,
          value: { target, phase: 'copying', epoch: profileEpoch },
        });
        return profileEpoch;
      },
    );

      // Copy (PRR-106/PRR-121 + reviewer round 2 F3): page-by-page, every
      // page gated on the claim-bound epoch.
      return await copyLegacyRowsIntoProfileUnlocked(legacy, profileDb, boundEpoch);
    });

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
