// frozen-check C3 — #367 AC3: existing plaintext rows migrate to encrypted
// form on first open; public reads return the originals.
//
// FROZEN SPEC — authored by the independent check author at base
// 1cfde07b73b52fa906da7bd3f316d7805b638e2f. The implementer must make this
// pass WITHOUT editing it; canonical copy dropped byte-identical at
// web_ui/src/db/__tests__/conversations.encryption-migration.test.ts.
//
// Harness contract (declared for the implementer):
//   - The spec SEEDS a plaintext version-2 conversations database by hand,
//     through the RAW indexedDB API only (no Dexie, no public API): object
//     store `conversations` (keyPath `id`, indexes updatedAt/createdAt/
//     title) and `meta` (keyPath `key`) — exactly the schema the base tree
//     declares at Dexie version(2) (web_ui/src/db/index.ts). The seeded
//     rows are the plain JSON objects a pre-encryption build wrote.
//   - It then imports the public conversations API fresh (which opens the
//     SAME named database) and asserts the migration observable.
//
// Observable contract pinned (issue #367 AC3):
//   1. The first public open migrates EVERY stored row to encrypted form:
//      after the first public read, the RAW rows contain no plaintext of
//      title / messages[].content / citation filenames. (Migration on
//      first open — not on first write: no write happens before the raw
//      re-read in test 1.)
//   2. Public reads return the ORIGINAL values byte-identically after
//      migration.
//   3. Ordering/index behavior survives: listConversations returns the
//      rows newest-first by updatedAt.
//   4. Post-migration writes through the public API store encrypted too.
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { PROFILE_KEY } from '../../lib/storage/persisted-keys';
import { getStorageDbNames } from '../../lib/storage/profile';
import type { Conversation } from '../conversations';

const TITLE_A = 'Hd3mOLDTITLEqZ7';
const TITLE_B = 'Kw5pOLDTITLEbR9';
const MSG_A = 'Qe8tOLDMSGsN4';
const MSG_B = 'Ux6yOLDMSGcV2';
const SRC_A = 'Od1rOLDSRCgT5';
const NEW_TITLE = 'Af9sNEWTITLEhK3';
const NEW_MSG = 'Bg7wNEWMSGjL6';

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

function plaintextConversation(
  id: string,
  title: string,
  content: string,
  source: string,
  createdAt: number,
  updatedAt: number,
): Conversation {
  return {
    id,
    title,
    messages: [
      { id: `${id}-m1`, role: 'user', content, timestamp: createdAt, sources: [source] },
    ],
    createdAt,
    updatedAt,
    mode: 'server',
    modelUsed: 'legacy-model',
  } as Conversation;
}

/**
 * Seed a plaintext version-2 conversations database exactly as the
 * pre-encryption build declared it: `conversations` (keyPath id; indexes
 * updatedAt, createdAt, title) and `meta` (keyPath key), DB version 2.
 */
function seedPlaintextV2(dbName: string, conversations: Conversation[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 2);
    req.onupgradeneeded = () => {
      const conn = req.result;
      const store = conn.createObjectStore('conversations', { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt', { unique: false });
      store.createIndex('createdAt', 'createdAt', { unique: false });
      store.createIndex('title', 'title', { unique: false });
      conn.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const conn = req.result;
      const tx = conn.transaction('conversations', 'readwrite');
      const store = tx.objectStore('conversations');
      for (const conv of conversations) {
        store.put(JSON.parse(JSON.stringify(conv)) as unknown as Record<string, unknown>);
      }
      tx.oncomplete = () => {
        conn.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error('seed put failed'));
      tx.onabort = () => reject(tx.error ?? new Error('seed tx aborted'));
    };
    req.onerror = () => reject(req.error ?? new Error('seed open failed'));
    req.onblocked = () => reject(new Error('seed open blocked'));
  });
}

describe('encryption-migration (#367 AC3): plaintext v2 rows are encrypted on first open and read back transparently', () => {
  it('first public open migrates every plaintext row to ciphertext while public reads return the originals (encryption-migration)', async () => {
    const PREFIX = 'c3mig001';
    const older = plaintextConversation('conv-c3-a', `legacy ${TITLE_A} note`, `legacy ${MSG_A} body`, `${SRC_A}.pdf`, 1730000000000, 1730000000500);
    const newer = plaintextConversation('conv-c3-b', `legacy ${TITLE_B} note`, `legacy ${MSG_B} body`, `${TITLE_B}.pdf`, 1730000001000, 1730000002000);
    const dbName = `${PREFIX}-doc-qa-conversations`;

    // Seed the plaintext v2 database BEFORE any module import opens it.
    await seedPlaintextV2(dbName, [older, newer]);

    // Seeding sanity: the rows really are plaintext at rest right now
    // (this validates the fixture; a broken seed fails here loudly).
    const seeded = (await rawRows(dbName, 'conversations')) as unknown[];
    expect(seeded.length).toBe(2);
    const seededJson = JSON.stringify(seeded);
    expect(seededJson).toContain(TITLE_A);
    expect(seededJson).toContain(MSG_B);

    // First public open — a READ (no write precedes it).
    const api = await freshConversationsModule(PREFIX);
    expect(getStorageDbNames().conversations).toBe(dbName);
    const count = await api.countConversations();
    expect(count).toBe(2);

    // (1) Migration on first open: every raw row is now ciphertext.
    const rows = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    const ids = rows.map((row) => row.id).sort();
    expect(ids).toEqual(['conv-c3-a', 'conv-c3-b']);
    const rawJson = JSON.stringify(rows);
    for (const marker of [TITLE_A, TITLE_B, MSG_A, MSG_B, SRC_A]) {
      expect(rawJson, `after first open, raw rows must not contain plaintext marker ${marker}`).not.toContain(marker);
    }

    // (1b) PC2-02: migrated rows carry REAL envelope shape, not base64 JSON.
    for (const row of rows as Array<Record<string, unknown> & { e?: Record<string, unknown>; v?: unknown }>) {
      expect(row.v, 'migrated row must carry the v:1 envelope marker').toBe(1);
      expect(row.e, 'migrated row must carry an e envelope').toBeDefined();
      const iv = Buffer.from(String(row.e!['iv']), 'base64');
      expect(iv.length, 'migrated IV must be 12 bytes').toBe(12);
      const ctBytes = Buffer.from(String(row.e!['ct']), 'base64');
      expect(ctBytes.length, 'migrated ct must exceed the plaintext payload size class').toBeGreaterThan(32);
      const ctDecoded = ctBytes.toString('utf8');
      for (const marker of [TITLE_A, TITLE_B, MSG_A, MSG_B, SRC_A]) {
        expect(ctDecoded, `migrated ct decoded must not contain plaintext marker ${marker}`).not.toContain(marker);
      }
      let parses: unknown;
      try {
        parses = JSON.parse(ctDecoded);
      } catch {
        parses = undefined;
      }
      expect((parses as { title?: unknown } | undefined)?.title, 'migrated ct must not parse to a plaintext-bearing object').toBeUndefined();
    }

    // (2) Public reads return the original VALUES byte-identically (deep
    // equality plus exact sensitive-field strings; key order is not part of
    // the contract).
    const readA = await api.getConversation('conv-c3-a');
    const readB = await api.getConversation('conv-c3-b');
    expect(readA).toEqual(older);
    expect(readB).toEqual(newer);
    expect(readA?.title).toBe(older.title);
    expect(readA?.messages[0]?.content).toBe(older.messages[0]!.content);
    expect(readA?.messages[0]?.sources).toEqual(older.messages[0]!.sources);
    expect(readB?.title).toBe(newer.title);
    expect(readB?.messages[0]?.content).toBe(newer.messages[0]!.content);

    // (3) Ordering survives migration: newest-first by updatedAt.
    const listed = await api.listConversations();
    expect(listed.length).toBe(2);
    expect(listed[0]?.id).toBe('conv-c3-b');
    expect(listed[1]?.id).toBe('conv-c3-a');

    // (4) PC2-02 authentic-failure legs on MIGRATED rows (kills the
    // base64-JSON migration mutant that C1's new-write legs do not cover):
    // (4a) flipping a ciphertext byte of a migrated row must make the public
    // read reject — a reversible encoding would still decode fine.
    const rows4 = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown> & { e: Record<string, unknown> }> ;
    const rowA4 = rows4.find((r) => r.id === 'conv-c3-a')!;
    const ct4 = String(rowA4.e['ct']);
    const flip = ct4.length - 5;
    const flipped = ct4[flip] === 'A' ? `${ct4.slice(0, flip)}B${ct4.slice(flip + 1)}` : `${ct4.slice(0, flip)}A${ct4.slice(flip + 1)}`;
    {
      const req = indexedDB.open(dbName);
      await new Promise<void>((res, rej) => {
        req.onsuccess = () => {
          const conn = req.result;
          const tx = conn.transaction('conversations', 'readwrite');
          tx.objectStore('conversations').put({ ...rowA4, e: { ...rowA4.e, ct: flipped } });
          tx.oncomplete = () => {
            conn.close();
            res();
          };
          tx.onerror = () => {
            conn.close();
            rej(tx.error);
          };
        };
        req.onerror = () => rej(req.error);
      });
    }
    vi.resetModules();
    // NOTE: do NOT call pinProfilePrefix here — it clears localStorage (and
    // with it the profile secret), which would make this leg pass vacuously.
    const apiAfterTamper = await import('../conversations');
    await expect(apiAfterTamper.getConversation('conv-c3-a')).rejects.toThrow();

    // (4b) wrong key must not open a MIGRATED row: replace the profile's
    // secret entry with fresh bytes; reads fail closed and raw stays silent.
    const SECRET_KEY = 'doc-qa-profile-secret';
    const stored = localStorage.getItem(SECRET_KEY);
    expect(stored, 'frozen custody contract: secret map present after migration (C2 contract reused)').not.toBeNull();
    const parsed = JSON.parse(stored!) as Record<string, string>;
    const other = new Uint8Array(32);
    crypto.getRandomValues(other);
    parsed[PREFIX] = Buffer.from(other).toString('base64');
    localStorage.setItem(SECRET_KEY, JSON.stringify(parsed));
    vi.resetModules();
    const apiWrongKey = await import('../conversations');
    const wrong = await apiWrongKey.getConversation('conv-c3-b').then(
      (v) => ({ threw: false, v }),
      () => ({ threw: true, v: undefined }),
    );
    if (!wrong.threw && wrong.v !== undefined) {
      const json = JSON.stringify(wrong.v);
      expect(json).not.toContain(TITLE_B);
      expect(json).not.toContain(MSG_B);
    }
    // RC3-06: explicit fail-closed final assertion — a fabricated
    // non-plaintext success object is NOT an accepted outcome for a
    // wrong-key read (mirror of C2's contract).
    expect(
      wrong.threw || wrong.v === undefined,
      'wrong-key read of a migrated row must fail closed (reject or undefined)',
    ).toBe(true);
    // "raw stays silent": post-attempt raw re-read proves nothing was
    // rewritten, decrypted-and-stored, or deleted by the failed attempts.
    const rowsFinal = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown>>;
    expect(rowsFinal.length, 'both rows survive the failed decrypt attempts').toBe(2);
    expect(rowsFinal.map((r) => r.id).sort()).toEqual(['conv-c3-a', 'conv-c3-b']);
    const finalJson = JSON.stringify(rowsFinal);
    for (const marker of [TITLE_A, TITLE_B, MSG_A, MSG_B, SRC_A]) {
      expect(finalJson, `post-attempt raw rows must not leak marker ${marker}`).not.toContain(marker);
    }
  });

  it('post-migration writes through the public API store encrypted and read back transparently (encryption-migration)', async () => {
    const PREFIX = 'c3mig002';
    const legacy = plaintextConversation('conv-c3-c', `legacy ${TITLE_A} chart`, `legacy ${MSG_A} notes`, `${SRC_A}.pdf`, 1730000200000, 1730000200000);
    const dbName = `${PREFIX}-doc-qa-conversations`;

    await seedPlaintextV2(dbName, [legacy]);
    const api = await freshConversationsModule(PREFIX);
    expect(await api.countConversations()).toBe(1);

    const fresh: Conversation = {
      id: 'conv-c3-new',
      title: `fresh ${NEW_TITLE} entry`,
      messages: [
        { id: 'n1', role: 'user', content: `fresh ${NEW_MSG} question`, timestamp: 1730000300000 },
      ],
      createdAt: 1730000300000,
      updatedAt: 1730000300000,
      mode: 'wllama',
      modelUsed: 'test-model',
    } as Conversation;
    expect(await api.createConversation(fresh)).toBe(true);

    const rows = (await rawRows(dbName, 'conversations')) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    const rawJson = JSON.stringify(rows);
    for (const marker of [TITLE_A, MSG_A, SRC_A, NEW_TITLE, NEW_MSG]) {
      expect(rawJson, `post-migration raw rows must not contain plaintext marker ${marker}`).not.toContain(marker);
    }

    const readBack = await api.getConversation('conv-c3-new');
    expect(readBack).toEqual(fresh);
    expect(readBack?.title).toBe(fresh.title);
    expect(readBack?.messages[0]?.content).toBe(fresh.messages[0]!.content);
    const readLegacy = await api.getConversation('conv-c3-c');
    expect(readLegacy).toEqual(legacy);
    expect(readLegacy?.title).toBe(legacy.title);
  });
});
