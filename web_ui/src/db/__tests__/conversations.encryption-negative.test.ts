// frozen-check C2 — #367 AC2: reading the stored DB without the profile key
// yields ciphertext (no plaintext recovery; garbage-decrypt fails closed).
//
// FROZEN SPEC — authored by the independent check author at base
// 1cfde07b73b52fa906da7bd3f316d7805b638e2f. The implementer must make this
// pass WITHOUT editing it; canonical copy dropped byte-identical at
// web_ui/src/db/__tests__/conversations.encryption-negative.test.ts.
//
// Harness contract (declared for the implementer — the key-unavailable
// simulation this spec relies on):
//   - A conversation is written through the public API under profile
//     prefix P (localStorage-pinned), against real IndexedDB semantics
//     via the `fake-indexeddb` devDependency.
//   - The "profile key unavailable" state is produced by: keep ONLY the
//     public profile prefix entry (doc-qa-profile-id), clear EVERY OTHER
//     localStorage key (and sessionStorage), then reset the module
//     registry (vi.resetModules) and re-import the public API fresh.
//     Consequence (frozen): the profile-derived encryption key must be
//     obtainable ONLY from per-profile secret material stored OUTSIDE the
//     public profile prefix — i.e. clearing localStorage minus the prefix
//     must make the key genuinely unavailable. An implementation that
//     derives the key from the public prefix value, or that stores key
//     material inside the (unencrypted) IndexedDB database itself, FAILS
//     this spec because decryption still succeeds and plaintext leaks.
//   - FROZEN KEY-CUSTODY CONTRACT (PC-08, declared so the wrong-key leg is
//     executable): the per-profile secret lives in localStorage under the
//     registered key `doc-qa-profile-secret`, value = JSON object mapping
//     profile prefix -> base64(32 random bytes). The wrong-key leg installs
//     a DIFFERENT known secret for the same prefix and asserts reads cannot
//     recover plaintext — a trivial-obfuscation or prefix-derived "key"
//     fails this leg.
//
// Observable contract pinned (issue #367 AC2):
//   1. After the simulation, a public read of the stored conversation
//      through the fresh module must NOT return the plaintext: it either
//      fails closed (throws / resolves undefined) or returns an object
//      that contains none of the plaintext markers and is not the
//      original conversation.
//   2. The ciphertext envelope persists: the RAW IndexedDB row is still
//      present (exactly one row, under its id) and still contains no
//      plaintext markers — data was neither deleted nor left in the
//      clear.
//   3. The fresh module still addresses the SAME database (count is 1 or
//      the count read fails closed) — an implementation that silently
//      opens a different, empty database to "pass" is caught by the raw
//      row plus count checks.
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { PROFILE_KEY } from '../../lib/storage/persisted-keys';
import { getStorageDbNames } from '../../lib/storage/profile';
import type { Conversation } from '../conversations';

const TITLE_MARKER = 'Pz9kNEGTITLEwQ4';
const MSG_MARKER = 'Ls2mNEGMSGrT8y5';
const SRC_MARKER = 'Yh7bNEGSRCdF3j6';

function pinProfilePrefix(prefix: string): void {
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, prefix);
}

async function freshConversationsModule(prefix: string) {
  pinProfilePrefix(prefix);
  vi.resetModules();
  return import('../conversations');
}

function rawRows(dbName: string, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const conn = req.result;
      if (!conn.objectStoreNames.contains(storeName)) {
        conn.close();
        resolve([]);
        return;
      }
      const tx = conn.transaction(storeName, 'readonly');
      const getAll = tx.objectStore(storeName).getAll();
      getAll.onsuccess = () => {
        conn.close();
        resolve(getAll.result ?? []);
      };
      getAll.onerror = () => {
        conn.close();
        reject(getAll.error ?? new Error('raw getAll failed'));
      };
    };
    req.onerror = () => reject(req.error ?? new Error('raw open failed'));
  });
}

function conversationFixture(): Conversation {
  return {
    id: 'conv-c2-001',
    title: `secret ${TITLE_MARKER} plan`,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: `confidential ${MSG_MARKER} instructions`,
        timestamp: 1730000100000,
        sources: [`${SRC_MARKER}-chart.pdf`],
      },
    ],
    createdAt: 1730000100000,
    updatedAt: 1730000100000,
    mode: 'wllama',
    modelUsed: 'test-model',
  } as Conversation;
}

/** Run fn, capturing a throw as { threw: true } (fail-closed is allowed). */
async function attempt<T>(fn: () => Promise<T>): Promise<{ threw: boolean; value?: T }> {
  try {
    return { threw: false, value: await fn() };
  } catch {
    return { threw: true };
  }
}

describe('encryption-negative (#367 AC2): without the profile key the stored rows are not plaintext-recoverable', () => {
  it('clearing the profile secret (prefix kept) yields no plaintext via the public API, and the ciphertext envelope persists (encryption-negative)', async () => {
    const PREFIX = 'c2neg001';
    const conv = conversationFixture();

    // Phase 1: write through the public API under profile PREFIX.
    const withKey = await freshConversationsModule(PREFIX);
    const dbName = getStorageDbNames().conversations;
    expect(dbName).toBe(`${PREFIX}-doc-qa-conversations`);
    expect(await withKey.createConversation(conv)).toBe(true);

    // The row is stored (ciphertext) at rest.
    let rows = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(conv.id);
    expect(JSON.stringify(rows)).not.toContain(TITLE_MARKER);
    expect(JSON.stringify(rows)).not.toContain(MSG_MARKER);
    expect(JSON.stringify(rows)).not.toContain(SRC_MARKER);

    // Phase 2: key-unavailable simulation. Preserve ONLY the public prefix;
    // every other localStorage key (the profile secret entry, whatever its
    // registered name) is removed. sessionStorage is cleared defensively.
    const keptPrefix = localStorage.getItem(PROFILE_KEY);
    localStorage.clear();
    sessionStorage.clear();
    if (keptPrefix !== null) localStorage.setItem(PROFILE_KEY, keptPrefix);
    expect(localStorage.getItem(PROFILE_KEY)).toBe(PREFIX);

    // Fresh module registry: no in-memory key or row cache survives.
    vi.resetModules();
    const withoutKey = await import('../conversations');

    // (1) Public reads fail closed or return non-plaintext.
    const direct = await attempt(() => withoutKey.getConversation(conv.id));
    if (!direct.threw && direct.value !== undefined) {
      const json = JSON.stringify(direct.value);
      expect(json, 'getConversation without the key must not return the plaintext title').not.toContain(TITLE_MARKER);
      expect(json, 'getConversation without the key must not return the plaintext message').not.toContain(MSG_MARKER);
      expect(json, 'getConversation without the key must not return the plaintext citation filename').not.toContain(SRC_MARKER);
      expect(json, 'getConversation without the key must not return the original conversation').not.toBe(JSON.stringify(conv));
    }

    const listed = await attempt(() => withoutKey.listConversations());
    if (!listed.threw && Array.isArray(listed.value)) {
      const json = JSON.stringify(listed.value);
      expect(json, 'listConversations without the key must not leak the plaintext title').not.toContain(TITLE_MARKER);
      expect(json, 'listConversations without the key must not leak the plaintext message').not.toContain(MSG_MARKER);
      expect(json, 'listConversations without the key must not leak the plaintext citation filename').not.toContain(SRC_MARKER);
    }

    // (3) The fresh module still addresses the SAME database: the stored
    // row is still countable (fail-closed throw also accepted), never 0.
    const counted = await attempt(() => withoutKey.countConversations());
    if (!counted.threw) {
      expect(counted.value, 'the ciphertext row must still be countable in the same database').not.toBe(0);
    }

    // (2) The ciphertext envelope persists at rest, undestroyed.
    rows = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown>>;
    expect(rows.length, 'the stored row must survive the key-unavailable read attempts').toBe(1);
    expect(rows[0]?.id).toBe(conv.id);
    const rawJson = JSON.stringify(rows);
    expect(rawJson).not.toContain(TITLE_MARKER);
    expect(rawJson).not.toContain(MSG_MARKER);
    expect(rawJson).not.toContain(SRC_MARKER);
  });

  it('a DIFFERENT known secret does not decrypt the envelope: explicit wrong-key install reads stay ciphertext (encryption-negative)', async () => {
    const PREFIX = 'c2neg002';
    const SECRET_KEY = 'doc-qa-profile-secret';
    const conv = conversationFixture();
    const withKey = await freshConversationsModule(PREFIX);
    const dbName = getStorageDbNames().conversations;
    expect(await withKey.createConversation(conv)).toBe(true);

    // PC-08: this leg must install a KNOWN DIFFERENT secret (not merely
    // clear one) so a prefix-derived or trivial-obfuscation "cipher" fails
    // here even if the clearing leg above would pass for it.
    const stored = localStorage.getItem(SECRET_KEY);
    expect(stored, 'a per-profile secret must exist after the first write (frozen custody contract)').not.toBeNull();
    const parsed = JSON.parse(stored!) as Record<string, string>;
    expect(Object.keys(parsed), 'the secret map must be keyed by profile prefix').toContain(PREFIX);

    // Replace the profile's secret with fresh, unrelated 32 bytes.
    const other = new Uint8Array(32);
    crypto.getRandomValues(other);
    parsed[PREFIX] = Buffer.from(other).toString('base64');
    localStorage.setItem(SECRET_KEY, JSON.stringify(parsed));

    vi.resetModules();
    const reKeyed = await import('../conversations');

    const direct = await attempt(() => reKeyed.getConversation(conv.id));
    if (!direct.threw && direct.value !== undefined) {
      const json = JSON.stringify(direct.value);
      expect(json, 'a different profile key must not decrypt the stored envelope').not.toContain(TITLE_MARKER);
      expect(json).not.toContain(MSG_MARKER);
      expect(json).not.toContain(SRC_MARKER);
    }

    // A wrong key must fail CLOSED (throw / undefined), never silently mint a
    // new secret and serve an empty-looking success for an existing row.
    expect(
      direct.threw || direct.value === undefined,
      'wrong-key read must fail closed (reject or undefined), not return a fabricated success',
    ).toBe(true);

    const rows = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(TITLE_MARKER);
  });
});
