/**
 * profile integration (issue #34 item 6p; plan R3-1/R3-5/R4-2/R4-5/R5-2/
 * R5-9/R7-1): per-profile conversations isolation via the REAL name
 * derivation, the fail-closed profile registry, the registry reset recovery,
 * non-enumerating-browser discovery, the IndexedDB-atomic legacy-adoption
 * claim protocol (racing adopters, retry after a claim crash, deletion only
 * after the done phase) and the ensureCurrentProfileRegistered bootstrap.
 *
 * Runs against the in-memory Dexie stand-in (src/test/fake-dexie.ts); jsdom
 * ships no indexedDB.databases(), which is itself the non-enumerating
 * browser this suite must keep working on.
 */
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

import { DocQADatabase, LEGACY_CONVERSATIONS_DB_NAME } from '../db/index';
import {
  adoptLegacyConversations,
  maybeAutoMigrateLegacyConversations,
} from '../db/conv-protocol';
import { createConversation, listConversations } from '../db/conversations';
import {
  ensureCurrentProfileRegistered,
  getProfilePrefix,
  getStorageDbNames,
  listRegisteredProfiles,
  listStalePrefixes,
  registerProfile,
  resetProfileRegistry,
} from '../lib/storage/profile';
import { switchProfile } from '../lib/storage/profile-switch';
import { conversationsOf, resetFakeDexie } from '../test/fake-dexie';
import type { Conversation } from '../db/conversations';
import {
  LEGACY_CONV_MIGRATION_DONE_KEY,
  PROFILE_KEY,
  REGISTERED_PROFILES_KEY,
} from '../lib/storage/persisted-keys';

vi.stubGlobal('indexedDB', {});

const PROFILE_A = 'isola1';
const PROFILE_B = 'isola2';
const DB_A = `${PROFILE_A}-doc-qa-conversations`;
const DB_B = `${PROFILE_B}-doc-qa-conversations`;

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

/** Seed the legacy SHARED db (its version-1 shape: only conversations). */
async function seedLegacy(n: number): Promise<void> {
  const legacy = new DocQADatabase(LEGACY_CONVERSATIONS_DB_NAME);
  for (let i = 0; i < n; i++) await legacy.conversations.add(conv(i));
}

function stubWebLocks(enabled: boolean): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    locks: enabled
      ? { request: (_name: string, _opts: unknown, cb: (lock: unknown) => unknown) => Promise.resolve(cb({})) }
      : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeDexie();
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, PROFILE_A);
  vi.unstubAllGlobals();
  vi.stubGlobal('indexedDB', {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('two-profile conversations isolation (real name derivation)', () => {
  it('the conversations db name differs per profile and records never cross', async () => {
    const namesA = getStorageDbNames();
    expect(namesA.conversations).toBe(DB_A);
    await createConversation(conv(1));
    expect(conversationsOf(DB_A)).toHaveLength(1);

    localStorage.setItem(PROFILE_KEY, PROFILE_B);
    expect(getStorageDbNames().conversations).toBe(DB_B);
    expect(DB_A).not.toBe(DB_B);
    // Profile B starts EMPTY: never profile A's records.
    expect(await listConversations(0, 50)).toHaveLength(0);
    expect(conversationsOf(DB_B)).toHaveLength(0);
    // Profile A's data is untouched under its own name.
    expect(conversationsOf(DB_A)).toHaveLength(1);
    expect(getProfilePrefix()).toBe(PROFILE_B);
  });
});

describe('registry fail-closed + recovery (R3-5/R4-5/R5-9)', () => {
  it('a corrupt registry yields NO deletion candidates and refuses registration/switch', async () => {
    localStorage.setItem(REGISTERED_PROFILES_KEY, '{corrupt json');
    const registry = listRegisteredProfiles();
    expect(registry.healthy).toBe(false);
    // Non-enumerating discovery stays empty — colleagues' namespaces can
    // never become deletion candidates on a corrupt registry.
    expect(await listStalePrefixes()).toEqual([]);
    expect(registerProfile('newprof')).toBe(false);
    expect(switchProfile(PROFILE_B, { registerIfNew: true })).toEqual({
      switched: false,
      reason: 'registration-failed',
    });
  });

  it('the explicit reset re-registers ONLY the current profile and heals the registry', () => {
    localStorage.setItem(REGISTERED_PROFILES_KEY, 'not-an-array');
    expect(listRegisteredProfiles().healthy).toBe(false);
    expect(resetProfileRegistry()).toBe(true);
    const healed = listRegisteredProfiles();
    expect(healed.healthy).toBe(true);
    expect(healed.profiles).toEqual([PROFILE_A]);
  });

  it('the reset is refused for a HEALTHY registry (not offered)', () => {
    localStorage.setItem(REGISTERED_PROFILES_KEY, JSON.stringify([PROFILE_A]));
    expect(resetProfileRegistry()).toBe(false);
  });

  it('a registered colleague profile is never a stale/orphan candidate', async () => {
    // A colleague's namespace exists in storage and is registered…
    const colleague = new DocQADatabase(`${PROFILE_B}-doc-qa-documents`);
    void colleague;
    localStorage.setItem(REGISTERED_PROFILES_KEY, JSON.stringify([PROFILE_A, PROFILE_B]));
    // …but listStalePrefixes needs databases() enumeration, absent in jsdom:
    // the non-enumerating-browser behavior (empty, never guesses).
    expect(await listStalePrefixes()).toEqual([]);
  });
});

describe('ensureCurrentProfileRegistered bootstrap (R4-5)', () => {
  it('registers the active profile on a healthy empty registry', () => {
    ensureCurrentProfileRegistered();
    expect(listRegisteredProfiles()).toEqual({ profiles: [PROFILE_A], healthy: true });
  });

  it('never touches an unhealthy registry', () => {
    localStorage.setItem(REGISTERED_PROFILES_KEY, '[[[');
    ensureCurrentProfileRegistered();
    expect(listRegisteredProfiles().healthy).toBe(false);
    expect(localStorage.getItem(REGISTERED_PROFILES_KEY)).toBe('[[[');
  });
});

describe('legacy adoption claim protocol (R6-1/R7-1)', () => {
  it('an empty profile adopts the legacy shared history exactly once and deletes the legacy db', async () => {
    await seedLegacy(3);
    const result = await adoptLegacyConversations(PROFILE_A);
    expect(result).toEqual({ outcome: 'adopted', count: 3 });
    expect(conversationsOf(DB_A)).toHaveLength(3);
    expect(conversationsOf(LEGACY_CONVERSATIONS_DB_NAME)).toHaveLength(0);
    expect(localStorage.getItem(LEGACY_CONV_MIGRATION_DONE_KEY)).toBe('1');
    // A second adopt short-circuits on the done-marker (fast path).
    expect(await adoptLegacyConversations(PROFILE_A)).toEqual({ outcome: 'already-done' });
  });

  it('racing adopters: a claim naming another target REFUSES, the claim owner resumes', async () => {
    await seedLegacy(2);
    // Simulate an in-flight adoption by ANOTHER profile: the claim row is
    // committed in the legacy db (IndexedDB-atomic authority, R7-1).
    const legacy = new DocQADatabase(LEGACY_CONVERSATIONS_DB_NAME);
    await legacy.meta.put({
      key: 'legacy-adopt-claim',
      value: { target: PROFILE_A, phase: 'copying' },
    });
    const refused = await adoptLegacyConversations(PROFILE_B);
    expect(refused).toEqual({
      outcome: 'refused',
      reason: 'in-flight',
      inFlightTarget: PROFILE_A,
    });
    // Profile B's db was NOT populated by the refused attempt.
    expect(conversationsOf(DB_B)).toHaveLength(0);
    // The claim owner retries (post-crash resume): copy is idempotent.
    const resumed = await adoptLegacyConversations(PROFILE_A);
    expect(resumed).toEqual({ outcome: 'adopted', count: 2 });
    expect(conversationsOf(DB_A)).toHaveLength(2);
    // Deletion happens only after the done phase.
    expect(conversationsOf(LEGACY_CONVERSATIONS_DB_NAME)).toHaveLength(0);
  });

  it('a profile that already has conversations is refused (R6-1 guard)', async () => {
    await createConversation(conv(9));
    await seedLegacy(2);
    const result = await adoptLegacyConversations(PROFILE_A);
    expect(result).toEqual({ outcome: 'refused', reason: 'profile-not-empty' });
    expect(conversationsOf(DB_A)).toHaveLength(1);
    // The legacy db survives a refused adoption.
    expect(conversationsOf(LEGACY_CONVERSATIONS_DB_NAME)).toHaveLength(2);
  });

  it('an absent legacy db marks done without touching anything (R4-2)', async () => {
    const result = await adoptLegacyConversations(PROFILE_A);
    expect(result).toEqual({ outcome: 'nothing-to-adopt' });
    expect(localStorage.getItem(LEGACY_CONV_MIGRATION_DONE_KEY)).toBe('1');
  });
});

describe('automatic legacy migration (R4-2/R5-2)', () => {
  it('is DISABLED without Web Locks: the legacy db is never touched', async () => {
    stubWebLocks(false);
    await seedLegacy(2);
    await maybeAutoMigrateLegacyConversations();
    expect(conversationsOf(LEGACY_CONVERSATIONS_DB_NAME)).toHaveLength(2);
    expect(conversationsOf(DB_A)).toHaveLength(0);
    expect(localStorage.getItem(LEGACY_CONV_MIGRATION_DONE_KEY)).toBeNull();
  });

  it('adopts under the migration lock when Web Locks exist', async () => {
    stubWebLocks(true);
    await seedLegacy(2);
    await maybeAutoMigrateLegacyConversations();
    expect(conversationsOf(DB_A)).toHaveLength(2);
    expect(localStorage.getItem(LEGACY_CONV_MIGRATION_DONE_KEY)).toBe('1');
    expect(conversationsOf(LEGACY_CONVERSATIONS_DB_NAME)).toHaveLength(0);
  });
});
