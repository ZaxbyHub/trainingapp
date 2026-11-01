/**
 * conversation-clear stale-tab (PR #264 review, PRR-103): a tab loaded under
 * profile A keeps its module-bound conversations-db singleton bound to A's
 * database name even after ANOTHER tab switches the shared PROFILE_KEY to B
 * (real Dexie fixes the name at construction; only the reload re-derives
 * it). When that stale tab then invokes the clear — reading the LIVE prefix
 * (B), exactly as useConversations.clearAllConversations does — the old
 * `isCurrent ? db : openProfileDb(profile)` selection destroyed A's
 * database (the singleton) while booking the pending record against B, and
 * the boot replay then cleared B as well: BOTH profiles wiped.
 *
 * The fix resolves the destructive target BY NAME from the PASSED prefix.
 * This suite reproduces the stale tab faithfully: the mocked `db` singleton
 * is constructed with a FIXED name (like a real stale tab), unlike the
 * dynamic-name singleton the other integration suites use.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index')>();
  const fake = await import('../test/fake-dexie');
  return {
    ...actual,
    DocQADatabase: fake.FakeDocQADatabase,
    // The STALE TAB: its singleton was bound at import under profile A.
    db: new fake.FakeDocQADatabase('staletab1-doc-qa-conversations'),
  };
});

import { db } from '../db/index';
import { clearAllConversationsInDb, readClearRecord } from '../db/conv-protocol';
import { conversationsOf, resetFakeDexie } from '../test/fake-dexie';
import { CONVERSATIONS_CLEARED_KEY, PROFILE_KEY } from '../lib/storage/persisted-keys';

vi.stubGlobal('indexedDB', {});

const STALE_PROFILE = 'staletab1'; // the profile the stale tab loaded under
const LIVE_PROFILE = 'livenew1'; // the profile another tab switched to
const STALE_DB = `${STALE_PROFILE}-doc-qa-conversations`;
const LIVE_DB = `${LIVE_PROFILE}-doc-qa-conversations`;

function seedDirect(name: string, id: string): void {
  const database = new (db.constructor as new (n: string) => typeof db)(name);
  void database.conversations.put({
    id,
    title: `Conversation of ${name}`,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    mode: 'wllama',
    modelUsed: 'test',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeDexie();
  localStorage.clear();
  // The stale tab's singleton really is bound to the stale profile's name.
  expect(db.name).toBe(STALE_DB);
});

describe('clearAllConversationsInDb stale-tab routing (PRR-103)', () => {
  it("a stale tab's clear destroys ONLY the profile it was invoked for — never the singleton's bound profile", async () => {
    // Both profiles have history.
    seedDirect(STALE_DB, 'stale-conv');
    seedDirect(LIVE_DB, 'live-conv');
    expect(conversationsOf(STALE_DB)).toHaveLength(1);
    expect(conversationsOf(LIVE_DB)).toHaveLength(1);

    // Another tab switched the shared prefix to the live profile; the stale
    // tab reads it when invoking the clear (as clearAllConversations does).
    localStorage.setItem(PROFILE_KEY, LIVE_PROFILE);
    expect(db.name).toBe(STALE_DB); // the singleton is STILL bound to A

    const result = await clearAllConversationsInDb(LIVE_PROFILE);
    expect(result).toEqual({ cleared: true });

    // The LIVE profile's db (the passed prefix's OWN db) is the one cleared…
    expect(conversationsOf(LIVE_DB)).toHaveLength(0);
    // …and the STALE profile's history survives: the singleton's bound
    // database is never the destructive target by virtue of isCurrent alone.
    expect(conversationsOf(STALE_DB)).toHaveLength(1);
    // The pending record resolved to completed against the PASSED profile.
    expect(readClearRecord()).toEqual({
      pending: null,
      completed: { epochGoal: 1, profile: LIVE_PROFILE },
    });
  });

  it('the boot replay of that stale-tab clear also targets only the recorded profile (not the singleton)', async () => {
    seedDirect(STALE_DB, 'stale-conv');
    seedDirect(LIVE_DB, 'live-conv');
    localStorage.setItem(PROFILE_KEY, LIVE_PROFILE);
    // Crash window: the pending record was written, the transaction never ran.
    localStorage.setItem(
      CONVERSATIONS_CLEARED_KEY,
      JSON.stringify({ pending: { epochGoal: 1, profile: LIVE_PROFILE }, completed: null }),
    );

    const { replayPendingConversationClear } = await import('../db/conv-protocol');
    const { replayed } = await replayPendingConversationClear();
    expect(replayed).toBe(true);
    // The replay cleared the RECORDED profile's db…
    expect(conversationsOf(LIVE_DB)).toHaveLength(0);
    // …and left the stale profile's history (the singleton's db) untouched.
    expect(conversationsOf(STALE_DB)).toHaveLength(1);
    expect(readClearRecord().completed).toEqual({ epochGoal: 1, profile: LIVE_PROFILE });
  });

  it('a clear invoked for the singleton-bound profile still works (name match reuses the singleton)', async () => {
    seedDirect(STALE_DB, 'stale-conv');
    const result = await clearAllConversationsInDb(STALE_PROFILE);
    expect(result).toEqual({ cleared: true });
    expect(conversationsOf(STALE_DB)).toHaveLength(0);
  });
});
