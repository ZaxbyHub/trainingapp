/**
 * inactivity-replay-reset (issue #279 AC3, check C10): the inactivity
 * watch's REPLAY branch runs the full post-clear path. Integration-style
 * two-fire setup — the REAL watch + REAL session-clear bus (REAL persisted
 * clear, conv-protocol over the in-memory Dexie stand-in) under the
 * queue-based fake LockManager — where the SECOND fire (no shared hold
 * racing the release) resolves a fresh pending record through the replay
 * branch itself.
 *
 * RED at base, GREEN after the fix (#279 B2): at base the replay branch
 * surfaced only the banner — the handler reset and the onSessionCleared
 * subscribers (the conversation list reload) never ran, and this spec's
 * second-fire assertions fail. After the fix the replay fire runs handlers
 * AND subscribers, raises the banner, re-arms the full threshold, and never
 * triggers a second persisted clear (the epoch lands exactly at the pending
 * goal — a requestSessionClear replay would have bumped it once more).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/index')>();
  const fake = await import('../../test/fake-dexie');
  return {
    ...actual,
    DocQADatabase: fake.FakeDocQADatabase,
    db: new fake.FakeDocQADatabase(),
  };
});

import { readClearRecord, readConversationEpoch } from '../../db/conv-protocol';
import { createConversation } from '../../db/conversations';
import { startInactivityWatch, INACTIVITY_REARM_POLL_MS, type InactivityWatchOptions } from './inactivity';
import {
  anyHandlerBusy,
  onSessionCleared,
  registerClearHandler,
  resetSessionClearBusForTests,
} from './session-clear';
import { conversationsOf, resetFakeDexie } from '../../test/fake-dexie';
import { CONVERSATIONS_CLEARED_KEY, PROFILE_KEY } from '../storage/persisted-keys';
import type { Conversation } from '../../db/conversations';

vi.stubGlobal('indexedDB', {});

const PREFIX = 'replay';
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
            void Promise.resolve(callback(null)).then(resolve, reject);
            return;
          }
          this.waiters.push(attempt);
          return;
        }
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

/** Seed a crashed tab's still-pending clear record for the given goal. */
function seedPendingRecord(epochGoal: number): void {
  localStorage.setItem(
    CONVERSATIONS_CLEARED_KEY,
    JSON.stringify({ pending: { epochGoal, profile: PREFIX }, completed: null }),
  );
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSessionClearBusForTests();
});

describe('the replay branch runs the full post-clear path (issue #279 B2)', () => {
  it('the second (replay) fire runs onClear + an onSessionCleared subscriber, raises the banner, re-arms the threshold — with no second persisted clear', async () => {
    // A crashed tab's pending record for goal 1.
    for (let i = 0; i < 3; i++) await createConversation(conv(i));
    seedPendingRecord(1);

    const onClear = vi.fn();
    registerClearHandler({ isBusy: () => false, onClear });
    const subscriber = vi.fn();
    onSessionCleared(subscriber);
    const banner = vi.fn();
    const options: InactivityWatchOptions = {
      getThresholdMin: () => 15,
      isBusy: () => anyHandlerBusy(),
      onCleared: banner,
      warn: () => {},
    };
    const watch = startInactivityWatch(options);
    watches.push(() => watch.stop());
    activity();

    // FIRST fire: resolves the pending goal 1 — via the replay branch or the
    // bus clear (the watch's own shared-hold release is asynchronous, so the
    // replay's arbitration can lose the race; PRR-114(e) pins that either
    // path resolves the pending exactly once). Either way the full post-clear
    // path runs: handler + subscriber + banner.
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(await readConversationEpoch()).toBe(1);
    expect(banner).toHaveBeenCalledTimes(1);
    const handlersAfterFirstFire = onClear.mock.calls.length;
    const subscribersAfterFirstFire = subscriber.mock.calls.length;
    expect(handlersAfterFirstFire).toBeGreaterThanOrEqual(1);
    expect(subscribersAfterFirstFire).toBeGreaterThanOrEqual(1);

    // SECOND fire with NO activity in between: nothing races the watch's
    // shared-hold release, so the REPLAY BRANCH itself resolves a fresh
    // pending record — and (the fix) runs the full post-clear path.
    for (let i = 10; i < 13; i++) await createConversation(conv(i));
    expect(conversationsOf(DB_NAME)).toHaveLength(3);
    seedPendingRecord(2);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    // The handler reset ran on the replay fire too...
    expect(onClear.mock.calls.length).toBe(handlersAfterFirstFire + 1);
    // ...and the onSessionCleared subscriber (the conversation list reload).
    expect(subscriber.mock.calls.length).toBe(subscribersAfterFirstFire + 1);
    // Banner raised by the replay branch.
    expect(banner).toHaveBeenCalledTimes(2);
    // NO second persisted clear: the epoch lands exactly AT the pending goal
    // (a requestSessionClear replay would have bumped it to 3) and the
    // record resolves to completed for this profile.
    expect(await readConversationEpoch()).toBe(2);
    expect(readClearRecord()).toEqual({ pending: null, completed: { [PREFIX]: 2 } });

    // Re-armed with the FULL threshold (not the 30 s poll): the poll window
    // passes with no fire, and the next fire lands one threshold later.
    await vi.advanceTimersByTimeAsync(INACTIVITY_REARM_POLL_MS);
    expect(banner).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15 * MIN - INACTIVITY_REARM_POLL_MS);
    expect(banner).toHaveBeenCalledTimes(3);
    expect(await readConversationEpoch()).toBe(3);
  });
});
