/**
 * inactivity-clear lock-faithful integration (review 08b findings F1/F2):
 * the REAL inactivity watch + REAL session-clear bus (its REAL persisted
 * clear — conv-protocol clearAllConversationsInDb, Web Locks arbitration
 * included) against the in-memory Dexie stand-in, driven through a
 * queue-based fake LockManager installed on navigator whose semantics match
 * real Web Locks: shared holders coexist; exclusive requires zero holders on
 * the name; ifAvailable requests that cannot be granted resolve the callback
 * with null immediately; and there is NO reentrancy — a second exclusive
 * ifAvailable on a name already held (even by the caller's own earlier
 * acquisition) resolves null, exactly as the reviewer verified in Chromium.
 *
 * This is the falsifier the review demanded for F1: it proves the idle fire
 * itself completes the persisted clear at the threshold (not one 30 s re-arm
 * poll late) when the workstation is quiet, and that a deferred clear (a
 * colleague's shared hold) completes on the poll once the workstation goes
 * quiet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/index')>();
  const fake = await import('../../test/fake-dexie');
  // Issue #367: only migrationReady is re-routed (its real closure targets
  // the real Dexie singleton); migrateUnderLock / requireKeyForWrite and the
  // key-state matrix stay REAL over the fake tables.
  const { fakeDbIndexModule } = await import('../../test/fake-db-gates');
  return fakeDbIndexModule(actual, new fake.FakeDocQADatabase());
});

import { readClearRecord, readConversationEpoch } from '../../db/conv-protocol';
import * as convProtocol from '../../db/conv-protocol';
import { createConversation } from '../../db/conversations';
import { startInactivityWatch, type InactivityWatchOptions } from './inactivity';
import { anyHandlerBusy, registerClearHandler, resetSessionClearBusForTests } from './session-clear';
import * as sessionClear from './session-clear';
import { conversationsOf, resetFakeDexie } from '../../test/fake-dexie';
import { CONVERSATIONS_CLEARED_KEY, PROFILE_KEY } from '../storage/persisted-keys';
import type { Conversation } from '../../db/conversations';

vi.stubGlobal('indexedDB', {});

const PREFIX = 'locktab';
const DB_NAME = `${PREFIX}-doc-qa-conversations`;
const MIN = 60_000;
const SESSION_LOCK = 'docqa-session-active';

type Mode = 'shared' | 'exclusive';
interface FakeLockHandle {
  name: string;
  mode: Mode;
}

/** Queue-based fake LockManager — real Web Locks semantics, no reentrancy. */
class FakeLockManager {
  private readonly holders: Array<{ name: string; mode: Mode }> = [];
  private readonly waiters: Array<() => void> = [];

  private canGrant(name: string, mode: Mode): boolean {
    if (mode === 'exclusive') return !this.holders.some((h) => h.name === name);
    return !this.holders.some((h) => h.name === name && h.mode === 'exclusive');
  }

  private releaseOne(name: string, mode: Mode): void {
    const idx = this.holders.findIndex((h) => h.name === name && h.mode === mode);
    if (idx >= 0) this.holders.splice(idx, 1);
    // Wake every waiter once; one that still cannot grant re-queues itself.
    for (const waiter of this.waiters.splice(0)) queueMicrotask(waiter);
  }

  request<T>(
    name: string,
    options: { mode?: Mode; ifAvailable?: boolean },
    callback: (lock: FakeLockHandle | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const mode = options.mode ?? 'exclusive';
    return new Promise<T>((resolve, reject) => {
      const attempt = (): void => {
        if (!this.canGrant(name, mode)) {
          if (options.ifAvailable === true) {
            // Real Web Locks: the callback runs with a null lock and the
            // request resolves with whatever it returns — no queueing.
            void Promise.resolve(callback(null)).then(resolve, reject);
            return;
          }
          this.waiters.push(attempt);
          return;
        }
        // Held from callback invocation until its returned promise settles.
        this.holders.push({ name, mode });
        void Promise.resolve(callback({ name, mode })).then(
          (value) => {
            this.releaseOne(name, mode);
            resolve(value as T);
          },
          (error) => {
            this.releaseOne(name, mode);
            reject(error);
          },
        );
      };
      attempt();
    });
  }

  /** Test oracle: is the name held right now (and by which modes)? */
  heldModes(name: string): Mode[] {
    return this.holders.filter((h) => h.name === name).map((h) => h.mode);
  }
}

let locks: FakeLockManager;
const watches: Array<() => void> = [];

function conv(i: number): Conversation {
  return {
    id: `conv-${i}`,
    title: `Conversation ${i}`,
    messages: [],
    createdAt: i,
    updatedAt: i,
    mode: 'wllama',
    modelUsed: 'test',
  };
}

function activity(): void {
  window.dispatchEvent(new Event('keydown'));
}

/** Start the real watch around the real bus. */
function startWatch(hooks: { threshold(): number; onCleared(): void }): ReturnType<typeof startInactivityWatch> {
  const options: InactivityWatchOptions = {
    getThresholdMin: hooks.threshold,
    isBusy: () => anyHandlerBusy(),
    onCleared: hooks.onCleared,
    warn: () => {},
  };
  const watch = startInactivityWatch(options);
  watches.push(() => watch.stop());
  return watch;
}

/** Hold the session-active lock in SHARED mode as if a colleague's tab. */
async function holdSharedAsOtherTab(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void locks.request(SESSION_LOCK, { mode: 'shared' }, () => held);
  await Promise.resolve();
  return () => release();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetFakeDexie();
  resetSessionClearBusForTests();
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, PREFIX);
  // jsdom ships no IndexedDB: re-stub after afterEach's unstubAllGlobals so
  // conv-protocol's epoch fast-guard never bypasses the in-memory fake.
  vi.stubGlobal('indexedDB', {});
  locks = new FakeLockManager();
  vi.stubGlobal('navigator', { ...navigator, locks });
});

afterEach(() => {
  for (const stop of watches.splice(0)) stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSessionClearBusForTests();
});

describe('the fake LockManager matches real Web Locks (harness oracle)', () => {
  it('shared holders coexist; exclusive requires zero holders; no reentrancy', async () => {
    const firstRelease = await holdSharedAsOtherTab();
    expect(locks.heldModes(SESSION_LOCK)).toEqual(['shared']);
    // A second shared holder coexists.
    const secondRelease = await holdSharedAsOtherTab();
    expect(locks.heldModes(SESSION_LOCK)).toEqual(['shared', 'shared']);
    // exclusive ifAvailable while shared holders exist -> null lock.
    const refused = await locks.request(SESSION_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => lock);
    expect(refused).toBeNull();
    firstRelease();
    await Promise.resolve();
    expect(locks.heldModes(SESSION_LOCK)).toEqual(['shared']);
    // Still one shared holder: exclusive keeps being refused.
    expect(
      await locks.request(SESSION_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => lock),
    ).toBeNull();
    secondRelease();
    await Promise.resolve();
    expect(locks.heldModes(SESSION_LOCK)).toEqual([]);
    // Quiet now: exclusive ifAvailable grants — and while it is held, a
    // SECOND exclusive ifAvailable (same tab, no reentrancy) gets null.
    let releaseExclusive!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseExclusive = resolve;
    });
    void locks.request(SESSION_LOCK, { mode: 'exclusive' }, () => held);
    await Promise.resolve();
    expect(locks.heldModes(SESSION_LOCK)).toEqual(['exclusive']);
    expect(
      await locks.request(SESSION_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => lock),
    ).toBeNull();
    releaseExclusive();
    await Promise.resolve();
    expect(locks.heldModes(SESSION_LOCK)).toEqual([]);
  });
});

describe('inactivity fire -> persisted clear through REAL locks (review F1)', () => {
  it('a quiet workstation: the fire itself completes the persisted clear and the notice — no 30 s poll needed', async () => {
    for (let i = 0; i < 3; i++) await createConversation(conv(i));
    expect(conversationsOf(DB_NAME)).toHaveLength(3);

    const onClear = vi.fn();
    registerClearHandler({ isBusy: () => false, onClear });
    const onCleared = vi.fn();
    let threshold = 15;
    startWatch({ threshold: () => threshold, onCleared });
    activity();

    // Advance EXACTLY the threshold — no re-arm poll advance. Before the F1
    // fix this left the data on disk (the outer exclusive deadlocked the
    // clear's own arbitration) and the clear landed only +30 s later.
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(await readConversationEpoch()).toBe(1);
    expect(readClearRecord()).toEqual({ pending: null, completed: { [PREFIX]: 1 } });
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onCleared).toHaveBeenCalledTimes(1);

    // And the watch re-armed for the next idle period (the full threshold,
    // not stuck on a 30 s poll): the next fire lands one threshold later.
    threshold = 15;
    await vi.advanceTimersByTimeAsync(15 * MIN - 1);
    expect(onCleared).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onCleared).toHaveBeenCalledTimes(2);
    expect(await readConversationEpoch()).toBe(2);
  });

  it('a colleague tab holding the session-active lock DEFERS the clear INVISIBLY; the poll completes it once the workstation is quiet (review F4)', async () => {
    for (let i = 0; i < 3; i++) await createConversation(conv(i));
    const releaseColleague = await holdSharedAsOtherTab();

    const onClear = vi.fn();
    registerClearHandler({ isBusy: () => false, onClear });
    const onCleared = vi.fn();
    startWatch({ threshold: () => 15, onCleared });
    activity();

    // Idle fire under the colleague's shared hold: the persisted clear's OWN
    // exclusive arbitration (LOCKS-FIRST, review F4) refuses, so the clear
    // defers WITHOUT writing any record — the colleague's tab receives no
    // storage event (their stream and in-memory state stay untouched), the
    // data stays, and no notice surfaces.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(conversationsOf(DB_NAME)).toHaveLength(3);
    expect(onCleared).not.toHaveBeenCalled();
    expect(readClearRecord()).toEqual({ pending: null, completed: null });
    // No cleared-at write happened at all during the deferred fire: nothing
    // for another tab's storage-event listener to observe.
    expect(setItemSpy.mock.calls.filter(([key]) => key === CONVERSATIONS_CLEARED_KEY)).toEqual([]);

    // The colleague closes their tab; the 30 s re-arm poll retries and the
    // ARBITRATED clear completes: the pending record (the cross-tab event)
    // exists from this moment, resolves to completed, and the notice lands.
    releaseColleague();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(await readConversationEpoch()).toBe(1);
    expect(readClearRecord()).toEqual({ pending: null, completed: { [PREFIX]: 1 } });
    expect(onCleared).toHaveBeenCalledTimes(1);
    const recordWrites = setItemSpy.mock.calls
      .filter(([key]) => key === CONVERSATIONS_CLEARED_KEY)
      .map(([, value]) => JSON.parse(value as string) as { pending: unknown; completed: unknown });
    expect(recordWrites.length).toBeGreaterThanOrEqual(2);
    expect(recordWrites[0]?.pending).toEqual({ epochGoal: 1, profile: PREFIX });
    expect(recordWrites.at(-1)).toEqual({ pending: null, completed: { [PREFIX]: 1 } });
    setItemSpy.mockRestore();
  });

  it('the watch holds its own shared session-active lock while armed, and releases it at the fire', async () => {
    for (let i = 0; i < 2; i++) await createConversation(conv(i));
    registerClearHandler({ isBusy: () => false, onClear: () => {} });
    const onCleared = vi.fn();
    startWatch({ threshold: () => 15, onCleared });
    activity();
    // Armed and active: the tab holds a shared lock (plus nothing else).
    await vi.waitFor(() => expect(locks.heldModes(SESSION_LOCK)).toEqual(['shared']));
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    // After the fire the watch re-arms only on ACTIVITY — until then the
    // session-active lock is free for any colleague.
    expect(locks.heldModes(SESSION_LOCK)).toEqual([]);
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it('PRR-114(e): a pending clear from a crashed tab is resolved by the idle fire (notice, no double clear) — and the replay branch itself executes when no shared hold is racing the release', async () => {
    for (let i = 0; i < 3; i++) await createConversation(conv(i));
    // A crashed tab's pending record: the pending stamp was written, the
    // epoch transaction never ran. The epoch (0) is below the goal (1).
    localStorage.setItem(
      CONVERSATIONS_CLEARED_KEY,
      JSON.stringify({ pending: { epochGoal: 1, profile: PREFIX }, completed: null }),
    );
    const onClear = vi.fn();
    registerClearHandler({ isBusy: () => false, onClear });
    const onCleared = vi.fn();
    startWatch({ threshold: () => 15, onCleared });
    activity();

    // FIRST fire: the watch's own shared-hold release is asynchronous, so
    // the replay's exclusive-ifAvailable arbitration can lose the race and
    // defer — the fire then falls through to requestSessionClear, whose own
    // arbitration completes the clear and resolves the pending. Either way
    // the pending is resolved exactly once (epoch lands AT the goal — no
    // double clear) and the notice surfaces.
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(await readConversationEpoch()).toBe(1);
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(readClearRecord()).toEqual({ pending: null, completed: { [PREFIX]: 1 } });
    const clearsAfterFirstFire = onClear.mock.calls.length;

    // SECOND fire with NO activity in between: the watch released its shared
    // hold at the first fire and re-acquires it only on activity, so nothing
    // races the release — the REPLAY BRANCH itself executes (a fresh pending
    // is resolved by replayPendingConversationClear, not by the bus clear:
    // the bus handler count does not move).
    for (let i = 10; i < 13; i++) await createConversation(conv(i));
    expect(conversationsOf(DB_NAME)).toHaveLength(3);
    localStorage.setItem(
      CONVERSATIONS_CLEARED_KEY,
      JSON.stringify({ pending: { epochGoal: 2, profile: PREFIX }, completed: null }),
    );
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(await readConversationEpoch()).toBe(2);
    expect(onCleared).toHaveBeenCalledTimes(2);
    // The replay branch, proven: it now runs the FULL post-clear path itself
    // (#279 B2 fix) — the bus handler reset runs on the replay fire too, so
    // a replayed clear resets this tab's in-memory state instead of leaving
    // it stale beside a wiped store.
    expect(onClear.mock.calls.length).toBe(clearsAfterFirstFire + 1);
    expect(readClearRecord()).toEqual({ pending: null, completed: { [PREFIX]: 2 } });
  });

  it('re-arms without a destructive clear when repair replay remains deferred', async () => {
    await createConversation(conv(99));
    const replay = vi.spyOn(convProtocol, 'replayPendingConversationClear')
      .mockResolvedValue({ replayed: false, deferred: true });
    const requestClear = vi.spyOn(sessionClear, 'requestSessionClear');
    const onCleared = vi.fn();
    startWatch({ threshold: () => 15, onCleared });
    activity();

    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(conversationsOf(DB_NAME)).toHaveLength(1);
    expect(await readConversationEpoch()).toBe(0);
    expect(requestClear).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledTimes(1);

    // The deferred repair is re-armed rather than falling through to the
    // destructive session-clear bus on the same idle tick.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replay).toHaveBeenCalledTimes(2);
    expect(requestClear).not.toHaveBeenCalled();
    expect(conversationsOf(DB_NAME)).toHaveLength(1);
  });

  it('catches an idle replay rejection, preserves rows, and retries on the re-arm poll', async () => {
    await createConversation(conv(100));
    const replay = vi.spyOn(convProtocol, 'replayPendingConversationClear')
      .mockRejectedValueOnce(new Error('transient replay rejection'))
      .mockResolvedValueOnce({ replayed: false, deferred: false });
    const requestClear = vi.spyOn(sessionClear, 'requestSessionClear');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startWatch({ threshold: () => 15, onCleared: () => {} });
    activity();

    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(warn).toHaveBeenCalledWith('[inactivity] pending-clear replay failed:', expect.any(Error));
    expect(requestClear).not.toHaveBeenCalled();
    expect(conversationsOf(DB_NAME)).toHaveLength(1);
    expect(await readConversationEpoch()).toBe(0);
    expect(replay).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(replay).toHaveBeenCalledTimes(2);
    expect(requestClear).toHaveBeenCalledTimes(1);
  });

  it('does not let an obsolete replay rejection replace a newer activity timer', async () => {
    let rejectReplay!: (error: Error) => void;
    const pendingReplay = new Promise<{ replayed: boolean; deferred: boolean }>((_resolve, reject) => {
      rejectReplay = reject;
    });
    const replay = vi.spyOn(convProtocol, 'replayPendingConversationClear').mockReturnValueOnce(pendingReplay);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startWatch({ threshold: () => 15, onCleared: () => {} });
    activity();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(replay).toHaveBeenCalledTimes(1);

    // Newer activity arms a fresh full-threshold decision while the old replay
    // is still in flight. Its later rejection must not install a 30s poll.
    activity();
    expect(vi.getTimerCount()).toBe(1);
    rejectReplay(new Error('obsolete replay rejection'));
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('reconciles a successful replay after newer activity without replacing its timer', async () => {
    let resolveReplay!: (value: { replayed: boolean; deferred: boolean }) => void;
    const pendingReplay = new Promise<{ replayed: boolean; deferred: boolean }>((resolve) => {
      resolveReplay = resolve;
    });
    const replay = vi.spyOn(convProtocol, 'replayPendingConversationClear').mockReturnValueOnce(pendingReplay);
    const onCleared = vi.fn();
    startWatch({ threshold: () => 15, onCleared });
    activity();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(replay).toHaveBeenCalledTimes(1);

    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    activity();
    expect(vi.getTimerCount()).toBe(1);
    const timersAfterActivity = timerSpy.mock.calls.length;
    // Resolve at a strictly later virtual instant. Without the generation
    // guard, armThreshold would create a replacement timer here.
    await vi.advanceTimersByTimeAsync(1_000);
    resolveReplay({ replayed: true, deferred: false });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(timerSpy).toHaveBeenCalledTimes(timersAfterActivity);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('notifies after an ordinary clear succeeds following newer activity without replacing its timer', async () => {
    await createConversation(conv(101));
    let resolveClear!: (value: { cleared: true }) => void;
    const pendingClear = new Promise<{ cleared: true }>((resolve) => {
      resolveClear = resolve;
    });
    const requestClear = vi.spyOn(sessionClear, 'requestSessionClear').mockReturnValueOnce(pendingClear);
    const onCleared = vi.fn();
    startWatch({ threshold: () => 15, onCleared });
    activity();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(requestClear).toHaveBeenCalledTimes(1);

    // Newer activity owns the timer while the ordinary clear is still in
    // flight. Its later commit must still surface the required notice.
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    activity();
    expect(vi.getTimerCount()).toBe(1);
    const timersAfterActivity = timerSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    resolveClear({ cleared: true });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(timerSpy).toHaveBeenCalledTimes(timersAfterActivity);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestClear).toHaveBeenCalledTimes(1);
  });

  it('does not install a poll when an obsolete replay resolves deferred', async () => {
    let resolveReplay!: (value: { replayed: boolean; deferred: boolean }) => void;
    const pendingReplay = new Promise<{ replayed: boolean; deferred: boolean }>((resolve) => {
      resolveReplay = resolve;
    });
    const replay = vi.spyOn(convProtocol, 'replayPendingConversationClear').mockReturnValueOnce(pendingReplay);
    const requestClear = vi.spyOn(sessionClear, 'requestSessionClear');
    startWatch({ threshold: () => 15, onCleared: () => {} });
    activity();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(replay).toHaveBeenCalledTimes(1);

    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    activity();
    const timersAfterActivity = timerSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    resolveReplay({ replayed: false, deferred: true });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(timerSpy).toHaveBeenCalledTimes(timersAfterActivity);
    expect(vi.getTimerCount()).toBe(1);
    expect(requestClear).not.toHaveBeenCalled();
  });

  it('does not notify when stopped before an in-flight ordinary clear succeeds', async () => {
    await createConversation(conv(102));
    let resolveClear!: (value: { cleared: true }) => void;
    const pendingClear = new Promise<{ cleared: true }>((resolve) => {
      resolveClear = resolve;
    });
    const requestClear = vi.spyOn(sessionClear, 'requestSessionClear').mockReturnValueOnce(pendingClear);
    const onCleared = vi.fn();
    const watch = startWatch({ threshold: () => 15, onCleared });
    activity();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(requestClear).toHaveBeenCalledTimes(1);

    watch.stop();
    resolveClear({ cleared: true });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(onCleared).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
