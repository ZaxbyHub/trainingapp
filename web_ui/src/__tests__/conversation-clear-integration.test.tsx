/**
 * conversation-clear integration (issue #34 item 6p, plan R4-3/R5-3/R5-6/
 * R6-2): the clear protocol end-to-end against the in-memory Dexie stand-in
 * (src/test/fake-dexie.ts — the repo carries no fake-indexeddb): the REAL
 * db/conv-protocol, REAL db/conversations CRUD, REAL session-clear bus and
 * the REAL useConversations hook. Web Locks are absent in jsdom, so the lock
 * wrappers degrade to single-tab passthrough — exactly the single-tab
 * interleavings asserted here; the cross-tab gates ride the epoch and the
 * storage event.
 *
 * Covered: full-table clear beyond the 50-row page; the busy guard defers;
 * stale-save resurrection is blocked (delayed storage-event interleaving);
 * new-chat saves after a clear are no-ops; post-reset saves land; the
 * two-tab storage-event reset; the cross-tab epoch gate.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index')>();
  const fake = await import('../test/fake-dexie');
  return {
    ...actual,
    DocQADatabase: fake.FakeDocQADatabase,
    db: new fake.FakeDocQADatabase(),
  };
});

import { db } from '../db/index';
import {
  clearAllConversationsInDb,
  readClearRecord,
  readConversationEpoch,
  replayPendingConversationClear,
  withEpochGate,
} from '../db/conv-protocol';
import { createConversation, listConversations, updateConversation } from '../db/conversations';
import { useConversations } from '../hooks/useConversations';
import {
  registerClearHandler,
  requestSessionClear,
  resetSessionClearBusForTests,
} from '../lib/session/session-clear';
import { conversationsOf, metaOf, resetFakeDexie } from '../test/fake-dexie';
import type { Conversation } from '../db/conversations';
import type { ChatMessage } from '../types/chat';
import { CONVERSATIONS_CLEARED_KEY, PROFILE_KEY } from '../lib/storage/persisted-keys';

const PREFIX = 'cleartab';

function conv(i: number): Conversation {
  const messages: ChatMessage[] = [
    { id: `m${i}`, role: 'user', content: `question ${i}`, timestamp: i },
    { id: `a${i}`, role: 'assistant', content: `answer ${i}`, timestamp: i },
  ];
  return {
    id: `conv-${String(i).padStart(3, '0')}`,
    title: `Conversation ${i}`,
    messages,
    createdAt: i,
    updatedAt: i,
    mode: 'wllama',
    modelUsed: 'test',
  };
}

const DB_NAME = `${PREFIX}-doc-qa-conversations`;

async function seed(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await createConversation(conv(i));
}

function fireClearStorageEvent(): void {
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: CONVERSATIONS_CLEARED_KEY,
        newValue: JSON.stringify({ pending: null, completed: { epochGoal: 1 } }),
      }),
    );
  });
}

// jsdom ships no IndexedDB; the epoch reader's fast guard would otherwise
// bypass the in-memory fake. The stub is never read by the fake itself.
vi.stubGlobal('indexedDB', {});

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeDexie();
  resetSessionClearBusForTests();
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, PREFIX);
});

afterEach(() => {
  resetSessionClearBusForTests();
  vi.restoreAllMocks();
});

describe('clearAllConversationsInDb (full protocol)', () => {
  it('clears EVERY conversation, beyond the 50-row loaded page (>50 seeded)', async () => {
    await seed(60);
    expect(conversationsOf(DB_NAME)).toHaveLength(60);
    const result = await clearAllConversationsInDb(PREFIX);
    expect(result).toEqual({ cleared: true });
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(metaOf(DB_NAME).get('epoch')?.value).toBe(1);
    // The pending record resolved to completed (R5-6/R7-2) — naming the
    // profile whose clear finished (PRR-104).
    expect(readClearRecord()).toEqual({ pending: null, completed: { epochGoal: 1, profile: PREFIX } });
  });

  it('is idempotent: a second clear re-arms and stays clear', async () => {
    await seed(3);
    await clearAllConversationsInDb(PREFIX);
    await clearAllConversationsInDb(PREFIX);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(await readConversationEpoch()).toBe(2);
  });

  it('the boot replay resolves a crash-pending clear before any load (R7-2)', async () => {
    await seed(5);
    // Crash simulation: the pending record was written, the tx never ran.
    localStorage.setItem(
      CONVERSATIONS_CLEARED_KEY,
      JSON.stringify({ pending: { epochGoal: 1, profile: PREFIX }, completed: null }),
    );
    const { replayed } = await replayPendingConversationClear();
    expect(replayed).toBe(true);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(readClearRecord().completed).toEqual({ epochGoal: 1, profile: PREFIX });
  });

  it('PRR-104: a completed marker from ANOTHER profile never suppresses this profile\'s pending replay', async () => {
    // Profile A's clear completed long ago (epochGoal 5 — far ahead).
    localStorage.setItem(
      CONVERSATIONS_CLEARED_KEY,
      JSON.stringify({
        pending: { epochGoal: 1, profile: PREFIX },
        completed: { epochGoal: 5, profile: 'otherp1' },
      }),
    );
    await seed(3);
    const { replayed } = await replayPendingConversationClear();
    // Cross-profile completed values must not silence the pending replay —
    // the record is origin-wide storage, the clears are per-profile.
    expect(replayed).toBe(true);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(readClearRecord().completed).toEqual({ epochGoal: 5, profile: PREFIX });
  });

  it('PRR-104: a pre-fix completed marker without a profile never suppresses a pending replay', async () => {
    // A record written before the profile field existed.
    localStorage.setItem(
      CONVERSATIONS_CLEARED_KEY,
      JSON.stringify({
        pending: { epochGoal: 1, profile: PREFIX },
        completed: { epochGoal: 9 },
      }),
    );
    await seed(2);
    const { replayed } = await replayPendingConversationClear();
    expect(replayed).toBe(true);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
  });

  it('PRR-104: the SAME profile\'s covering completed marker still suppresses the replay (no double clear)', async () => {
    localStorage.setItem(
      CONVERSATIONS_CLEARED_KEY,
      JSON.stringify({
        pending: { epochGoal: 1, profile: PREFIX },
        completed: { epochGoal: 1, profile: PREFIX },
      }),
    );
    await seed(4);
    const { replayed } = await replayPendingConversationClear();
    expect(replayed).toBe(false);
    expect(conversationsOf(DB_NAME)).toHaveLength(4);
  });

  it('the boot replay marks an already-satisfied goal completed without a tx (crash after commit)', async () => {
    await seed(2);
    await clearAllConversationsInDb(PREFIX); // epoch 1, completed
    // Crash simulation: pending stuck at the same goal as completed.
    localStorage.setItem(
      CONVERSATIONS_CLEARED_KEY,
      JSON.stringify({ pending: { epochGoal: 1, profile: PREFIX }, completed: null }),
    );
    const { replayed } = await replayPendingConversationClear();
    expect(replayed).toBe(true);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    expect(await readConversationEpoch()).toBe(1);
  });

  it('the busy guard DEFERS the clear through the bus (no partial clear)', async () => {
    await seed(4);
    const unregister = registerClearHandler({ isBusy: () => true, onClear: () => {} });
    const result = await requestSessionClear();
    expect(result).toEqual({ deferred: true });
    expect(conversationsOf(DB_NAME)).toHaveLength(4);
    unregister();
    // The re-arm path (the inactivity poll / a later request) completes it.
    const second = await requestSessionClear();
    expect(second).toEqual({ cleared: true });
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
  });
});

describe('epoch gate (cross-tab stale writes)', () => {
  it('withEpochGate aborts a mutation captured under a stale epoch (the GATE aborts — mutate never runs)', async () => {
    await seed(1);
    // PRR-114(c): seed a real meta epoch row so the epoch is 1 — the gate
    // itself (not an error swallow) must abort the stateEpoch-0 mutation.
    // Before this seeding, the epoch read 0 and the "must not run" mutate
    // RAN, its throw swallowed by the old catch-all: the assertion passed
    // via the error path, not the gate.
    await db.meta.put({ key: 'epoch', value: 1 });
    const appliedStale = await withEpochGate(0, () => {
      throw new Error('must not run');
    });
    expect(appliedStale).toBe(false);
    await clearAllConversationsInDb(PREFIX);
    const staleSave = await updateConversation('conv-000', { title: 'resurrected' }, { stateEpoch: 0 });
    expect(staleSave).toBe(false);
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
  });

  it('PRR-105: withEpochGate PROPAGATES a genuine mutation error (false is reserved for the gate)', async () => {
    await seed(1);
    // The epoch matches, so the mutate body really runs — its genuine error
    // must reach the caller (the old catch-all flattened it to false).
    const epoch = await readConversationEpoch();
    await expect(
      withEpochGate(epoch, () => {
        throw new Error('genuine write failure');
      }),
    ).rejects.toThrow('genuine write failure');
  });

  it('PRR-105: a genuine CRUD write failure rejects instead of resolving false', async () => {
    await seed(1);
    const conversationsTable = db.conversations;
    const spy = vi.spyOn(conversationsTable, 'update').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      await expect(
        updateConversation('conv-000', { title: 'x' }, { stateEpoch: await readConversationEpoch() }),
      ).rejects.toThrow('quota exceeded');
    } finally {
      spy.mockRestore();
    }
  });

  it('a fresh-epoch mutation lands', async () => {
    await clearAllConversationsInDb(PREFIX);
    const applied = await createConversation(conv(1), { stateEpoch: await readConversationEpoch() });
    expect(applied).toBe(true);
    expect(conversationsOf(DB_NAME)).toHaveLength(1);
  });
});

describe('useConversations against the clear protocol', () => {
  it('clearAllConversations resets list/current/search state with a fresh epoch', async () => {
    await seed(55);
    const { result } = renderHook(() => useConversations());
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(50);
    });
    expect(result.current.hasMore).toBe(true);
    await act(async () => {
      const clearResult = await result.current.clearAllConversations();
      expect(clearResult).toEqual({ cleared: true });
    });
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(0);
    });
    expect(result.current.hasMore).toBe(false);
    expect(result.current.currentConversationId).toBeUndefined();
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    // The next save lands under the fresh epoch (post-reset state).
    await act(async () => {
      result.current.newChat();
      await result.current.saveMessages('conv-900', [
        { id: 'm1', role: 'user', content: 'fresh start', timestamp: 1 },
      ], 'wllama', 'test');
    });
    await waitFor(() => {
      expect(conversationsOf(DB_NAME)).toHaveLength(1);
    });
  });

  it('a save bound to a pre-clear state is a silent no-op (no resurrection), even before its tab sees the event', async () => {
    await seed(1);
    const { result } = renderHook(() => useConversations());
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });
    // Tab B selected a conversation (state bound at epoch 0)…
    await act(async () => {
      await result.current.selectConversation('conv-000');
    });
    // …tab A clears (epoch bump). Tab B has NOT received the storage event yet.
    await clearAllConversationsInDb(PREFIX);
    expect(await readConversationEpoch()).toBe(1);
    // Tab B's delayed save: still bound to epoch 0 (the pre-clear state; no
    // rebind happened since the select) → aborted, nothing resurrected.
    await act(async () => {
      await result.current.saveMessages(undefined, [
        { id: 'm1', role: 'user', content: 'stale', timestamp: 1 },
      ], 'wllama', 'test');
    });
    expect(conversationsOf(DB_NAME)).toHaveLength(0);
    // The storage event finally arrives: the in-tab reset runs.
    fireClearStorageEvent();
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(0);
    });
    expect(result.current.currentConversationId).toBeUndefined();
  });

  it('a new-chat save after the reset lands (post-reset state binds the current epoch)', async () => {
    await seed(1);
    const { result } = renderHook(() => useConversations());
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });
    await clearAllConversationsInDb(PREFIX);
    fireClearStorageEvent();
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(0);
    });
    await act(async () => {
      result.current.newChat();
      await result.current.saveMessages(undefined, [
        { id: 'm1', role: 'user', content: 'after reset', timestamp: 2 },
      ], 'wllama', 'test');
    });
    await waitFor(() => {
      expect(conversationsOf(DB_NAME)).toHaveLength(1);
    });
  });

  it('the two-tab storage event runs the in-tab reset (streams cancelled via the bus)', async () => {
    await seed(2);
    const onClear = vi.fn();
    registerClearHandler({ isBusy: () => false, onClear });
    const { result } = renderHook(() => useConversations());
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(2);
    });
    act(() => {
      result.current.setSearchQuery('conversation');
    });
    fireClearStorageEvent();
    await waitFor(() => {
      expect(onClear).toHaveBeenCalledTimes(1);
      expect(result.current.conversations).toHaveLength(0);
      expect(result.current.searchResults).toBeNull();
    });
  });

  it('PRR-114(f): a stale select is discarded by the EPOCH VERIFICATION even though the row still exists at select time', async () => {
    await seed(2);
    const { result } = renderHook(() => useConversations());
    await waitFor(() => {
      expect(result.current.currentConversationId).toBe('conv-001');
    });
    // A concurrent clear bumps the epoch WITHOUT deleting the row (a clear
    // that raced the select's fetch): the row is still readable, so only the
    // epoch-verification branch can discard the payload. The bump lands
    // mid-fetch — after the select bound the (pre-bump) epoch, before the
    // completion verify. (The old test deleted the row, so it passed via
    // row-gone, never exercising the epoch check.)
    const tableView = db.conversations as unknown as {
      get(key: string): Promise<Conversation | undefined>;
    };
    const originalGet = tableView.get.bind(tableView);
    let bumped = false;
    const spy = vi.spyOn(tableView, 'get').mockImplementation(async (key: string) => {
      if (!bumped) {
        bumped = true;
        // The clear lands while this fetch is in flight.
        await db.meta.put({ key: 'epoch', value: (await readConversationEpoch()) + 1 });
      }
      return originalGet(key);
    });
    try {
      // The select binds the pre-bump epoch, fetches (row EXISTS), completes:
      // the verify sees the bumped epoch and discards.
      await act(async () => {
        await result.current.selectConversation('conv-000');
      });
    } finally {
      spy.mockRestore();
    }
    // The discarded select changed NOTHING: the previously-selected state
    // (restored at init) stays, and conv-000's CONTENT never appears even
    // though its row existed at select time.
    expect(result.current.currentConversationId).toBe('conv-001');
    const rendered = result.current.currentMessages.map((m) => m.content).join('|');
    expect(rendered).not.toContain('question 0');
    expect(rendered).toContain('question 1');
    // ...and the row really was there the whole time (the discard was the
    // epoch check, not a missing payload).
    expect(conversationsOf(DB_NAME).some((c) => c.id === 'conv-000')).toBe(true);
    expect((await listConversations(0, 50)).length).toBe(2);
  });

  it('a stale select that raced a ROW-DELETING clear also discards its payload', async () => {
    await seed(2);
    const { result } = renderHook(() => useConversations());
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(2);
    });
    // Let the mount init finish (restores the newest conversation) BEFORE
    // the clear — the select below is then the only stale reader.
    await waitFor(() => {
      expect(result.current.currentConversationId).toBe('conv-001');
    });
    await clearAllConversationsInDb(PREFIX);
    fireClearStorageEvent();
    await waitFor(() => {
      expect(result.current.currentConversationId).toBeUndefined();
    });
    // A delayed select of a now-cleared conversation: its payload is gone,
    // the epoch verify at completion discards, nothing is restored.
    await act(async () => {
      await result.current.selectConversation('conv-000');
    });
    expect(result.current.currentConversationId).toBeUndefined();
    expect(result.current.currentMessages).toHaveLength(0);
    expect((await listConversations(0, 50)).length).toBe(0);
  });
});

describe('db singleton name', () => {
  it('resolves the active profile-prefixed conversations database', () => {
    expect(db.name).toBe(DB_NAME);
  });
});
