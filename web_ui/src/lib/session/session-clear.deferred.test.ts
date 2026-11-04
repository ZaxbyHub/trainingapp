/**
 * session-clear.deferred (issue #279 AC2, check C9): the all-or-nothing
 * session clear under REAL Web-Locks arbitration (the queue-based fake
 * LockManager from the integration suite — shared holders coexist,
 * exclusive requires zero holders, no reentrancy) against the REAL
 * session-clear bus with its REAL default persisted clear (conv-protocol
 * clearAllConversationsInDb over the in-memory Dexie stand-in).
 *
 * RED at base, GREEN after the fix (#279 B1/PC-4/PC2-2): at base
 * requestSessionClear ran the handlers BEFORE the persisted clear's own
 * arbitration, so a deferred clear (a colleague tab holding the shared
 * session-active lock) had already wiped this tab's in-memory state — the
 * deferred-zero leg asserts the handler reset never runs; the success-order
 * leg asserts the handlers run INSIDE the exclusive section (before the
 * persisted write) and the persisted clear completes; the conv-protocol
 * legs pin the beforeClear seam directly (after acquisition + before the
 * pending-record write when the lock is free; never when it is held).
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

import { clearAllConversationsInDb, readClearRecord, readConversationEpoch } from '../../db/conv-protocol';
import { createConversation } from '../../db/conversations';
import { registerClearHandler, requestSessionClear, resetSessionClearBusForTests } from './session-clear';
import { conversationsOf, resetFakeDexie } from '../../test/fake-dexie';
import { CONVERSATIONS_CLEARED_KEY, PROFILE_KEY } from '../storage/persisted-keys';
import type { Conversation } from '../../db/conversations';

vi.stubGlobal('indexedDB', {});

const PREFIX = 'deferred';
const DB_NAME = `${PREFIX}-doc-qa-conversations`;
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
  vi.clearAllMocks();
  resetFakeDexie();
  resetSessionClearBusForTests();
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, PREFIX);
  // jsdom ships no IndexedDB: re-stub so conv-protocol's epoch fast-guard
  // never bypasses the in-memory fake.
  vi.stubGlobal('indexedDB', {});
  locks = new FakeLockManager();
  vi.stubGlobal('navigator', { ...navigator, locks });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSessionClearBusForTests();
});

describe('requestSessionClear under REAL lock arbitration (deferred-zero + success-order)', () => {
  it('deferred-zero: a colleague holding the shared lock defers the clear with ZERO handler invocations', async () => {
    for (let i = 0; i < 3; i++) await createConversation(conv(i));
    const onClear = vi.fn();
    registerClearHandler({ isBusy: () => false, onClear });
    const releaseColleague = await holdSharedAsOtherTab();

    const result = await requestSessionClear();

    // The clear is deferred AND invisible: the handler reset never ran (at
    // base it had already emptied this tab's in-memory state), nothing was
    // persisted, and the conversations survive.
    expect(result).toEqual({ deferred: true });
    expect(onClear).not.toHaveBeenCalled();
    expect(conversationsOf(DB_NAME)).toHaveLength(3);
    expect(readClearRecord()).toEqual({ pending: null, completed: null });
    releaseColleague();
  });

  it('success-order: on a quiet workstation the handlers run INSIDE the exclusive section, then the persisted clear completes', async () => {
    for (let i = 0; i < 3; i++) await createConversation(conv(i));
    const modesDuringHandler: Array<Mode[]> = [];
    const sequence: string[] = [];
    registerClearHandler({
      isBusy: () => false,
      onClear: () => {
        modesDuringHandler.push([...locks.heldModes(SESSION_LOCK)]);
        sequence.push('handler');
      },
    });
    // A pass-through spy: the sequence pin observes the pending-record write
    // without replacing localStorage behavior.
    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key: string, value: string) => {
        if (key === CONVERSATIONS_CLEARED_KEY) sequence.push('pending-record-write');
        return originalSetItem.call(localStorage, key, value);
      });

    const result = await requestSessionClear();

    expect(result).toEqual({ cleared: true });
    // The handler ran exactly once — and while the EXCLUSIVE session-active
    // lock was held (inside the locked section, before the persisted write).
    expect(modesDuringHandler).toEqual([['exclusive']]);
    expect(sequence.indexOf('handler')).toBeLessThan(sequence.indexOf('pending-record-write'));
    // The persisted clear completed after the handlers.
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(await readConversationEpoch()).toBe(1);
    expect(readClearRecord()).toEqual({ pending: null, completed: { [PREFIX]: 1 } });
    setItemSpy.mockRestore();
  });
});

describe('conv-protocol beforeClear seam (spy-based, real lock manager)', () => {
  it('lock free: beforeClear runs AFTER exclusive acquisition and BEFORE the pending-record write + persisted clear', async () => {
    for (let i = 0; i < 3; i++) await createConversation(conv(i));
    const capturedModes: Array<Mode[]> = [];
    const capturedRows: number[] = [];
    const capturedRecordWrites: number[] = [];
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const beforeClear = vi.fn(async () => {
      // Both pinned at hook time: the exclusive session-active lock is held,
      // and NOTHING has been persisted yet (no pending record, data intact).
      capturedModes.push([...locks.heldModes(SESSION_LOCK)]);
      capturedRows.push(conversationsOf(DB_NAME).length);
      capturedRecordWrites.push(
        setItemSpy.mock.calls.filter(([key]) => key === CONVERSATIONS_CLEARED_KEY).length,
      );
    });

    const result = await clearAllConversationsInDb(PREFIX, { beforeClear });

    expect(result).toEqual({ cleared: true });
    expect(beforeClear).toHaveBeenCalledTimes(1);
    // After acquisition (exclusive held), before the persisted write (data
    // still present, zero cleared-record writes so far).
    expect(capturedModes).toEqual([['exclusive']]);
    expect(capturedRows).toEqual([3]);
    expect(capturedRecordWrites).toEqual([0]);
    // And the clear itself completed afterwards.
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(await readConversationEpoch()).toBe(1);
    setItemSpy.mockRestore();
  });

  it('lock held: a deferred clear never invokes beforeClear and persists nothing', async () => {
    for (let i = 0; i < 3; i++) await createConversation(conv(i));
    const beforeClear = vi.fn();
    const releaseColleague = await holdSharedAsOtherTab();
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    const result = await clearAllConversationsInDb(PREFIX, { beforeClear });

    expect(result).toEqual({ deferred: true });
    expect(beforeClear).not.toHaveBeenCalled();
    expect(
      setItemSpy.mock.calls.filter(([key]) => key === CONVERSATIONS_CLEARED_KEY),
    ).toEqual([]);
    expect(conversationsOf(DB_NAME)).toHaveLength(3);
    releaseColleague();
    setItemSpy.mockRestore();
  });
});
