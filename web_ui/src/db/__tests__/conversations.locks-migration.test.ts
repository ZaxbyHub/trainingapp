// RC4-01 lock-stack battery + RC3-02 migration legs (issue #367 plan item 6,
// implementation-side checks — NOT frozen). Real modules over fake-indexeddb;
// navigator.locks is stubbed where the leg needs a REAL serialization
// (reacquisition, stale-snapshot) and absent where the leg needs the in-tab
// chain. Mutant matrix executed in 08a: reacquisition wedge (T1), no-retry /
// stale-merge retry (T2), silent-conflict (T3), unlocked migration (T4),
// double-encryption (T5), memoized rejection (T6), shared migration state
// (T7); guard mutant: raw write outside the db layer (guard spec).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROFILE_KEY, PROFILE_SECRET_KEY } from '../../lib/storage/persisted-keys';

// UNIQUE db-name prefix PER TEST: Dexie caches open connections per name in
// a static registry that vi.resetModules does NOT clear, so a reused name
// splits writes and raw reads across test-scoped IDBFactory instances
// (observed: T1's envelope row leaked into T2's empty factory).
const P = {
  t1: 'lockmat1',
  t2: 'lockmat2',
  t3: 'lockmat3',
  t4: 'lockmat4',
  t5: 'lockmat5',
  t6: 'lockmat6',
  t7: 'lockmat7',
  t7other: 'lockmat8',
};
const OTHER_DB = `${P.t7other}-doc-qa-conversations`;

function dbNameFor(prefix: string): string {
  return `${prefix}-doc-qa-conversations`;
}

interface SimpleRow {
  id: string;
  title: string;
}

function plainRow(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    messages: [{ id: `${id}-u1`, role: 'user' as const, content: `question ${id}`, timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
    mode: 'wllama' as const,
    modelUsed: 'test',
  };
}

async function freshModules(): Promise<{
  db: import('../../db/index').DocQADatabase;
  migrationReady: (name?: string) => Promise<void>;
  requireKeyForWrite: (target: import('../../db/index').DocQADatabase) => Promise<void>;
  __resetMigrationStatesForTests: () => void;
  DocQADatabase: typeof import('../../db/index').DocQADatabase;
}> {
  // Fresh module state per test (the frozen C-suite recipe): resetModules +
  // a per-test unique prefix against the file-scoped fake-indexeddb factory.
  vi.resetModules();
  const index = await import('../../db/index');
  return index;
}

async function rawRowsOf(name: string): Promise<Array<Record<string, unknown>>> {
  // Raw getAll through fake-indexeddb (independent of Dexie connections). A
  // version-less open CREATES a missing db — provision its stores so the
  // read returns [] instead of throwing (the assertions still fail on the
  // empty result when the migration never ran).
  const conn = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(name);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('conversations')) {
        r.result.createObjectStore('conversations', { keyPath: 'id' });
      }
      if (!r.result.objectStoreNames.contains('meta')) {
        r.result.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const rows = await new Promise<unknown[]>((res, rej) => {
    const t = conn.transaction('conversations', 'readonly');
    const g = t.objectStore('conversations').getAll();
    g.onsuccess = () => res(g.result ?? []);
    g.onerror = () => rej(g.error);
  });
  conn.close();
  return rows as Array<Record<string, unknown>>;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.removeItem(PROFILE_SECRET_KEY);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'locks');
});

describe('RC4-01 lock-stack battery (#367)', () => {
  it('T1: an update completes promptly with navigator.locks PRESENT (no same-name reacquisition)', async () => {
    localStorage.setItem(PROFILE_KEY, P.t1);
    // Serialize per name like a real manager: a NESTED same-name acquisition
    // would queue behind itself forever and stall past the vitest timeout.
    const chains = new Map<string, Promise<unknown>>();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (name: string, _opts: unknown, cb: () => Promise<unknown>): Promise<unknown> => {
          const prev = chains.get(name) ?? Promise.resolve();
          const next = prev.then(cb, cb);
          chains.set(name, next.catch(() => undefined));
          return next;
        },
      },
    });
    const { db, migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    await migrationReady(db.name);
    const { createConversation, updateConversation } = await import('../../db/conversations');
    await createConversation(plainRow('t1', 'before') as never);
    const res = await updateConversation('t1', { title: 'after' }, { stateEpoch: 0 });
    expect(res).toBe(true);
    const { getConversation } = await import('../../db/conversations');
    expect((await getConversation('t1'))?.title).toBe('after');
  });

  it('T2: a conflict between phases restarts from a FRESH read — both changes survive', async () => {
    localStorage.setItem(PROFILE_KEY, P.t2);
    const { db, migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    await migrationReady(db.name);
    const { encryptRow, getOrCreateSecret } = await import('../../lib/storage/db-crypto');
    const secret = await getOrCreateSecret(P.t2);
    const base = plainRow('t2', 'original title');
    const winnerRow = {
      ...base,
      messages: [
        { id: 't2-u1', role: 'user' as const, content: 'question t2', timestamp: 1 },
        { id: 't2-u2', role: 'assistant' as const, content: 'winner appends', timestamp: 2 },
        ],
    };
    const E0 = await encryptRow(base as never, secret, P.t2);
    const E1 = await encryptRow(winnerRow as never, secret, P.t2);
    await db.conversations.bulkPut([E0]);
    const { updateConversation, getConversation } = await import('../../db/conversations');

    let calls = 0;
    const spy = vi.spyOn(db.conversations, 'get').mockImplementation((async () => {
      calls += 1;
      // Call 2 is phase 3's re-read: the winner committed between phases.
      // Calls 3+ (the retry's phase 1 and phase 3) see the winner's row too.
      return calls >= 2 ? E1 : E0;
    }) as never);
    try {
      expect(await updateConversation('t2', { title: 'renamed title' }, { stateEpoch: 0 })).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const final = await getConversation('t2');
    expect(final?.title).toBe('renamed title');
    expect(final?.messages.map((m) => m.id)).toEqual(['t2-u1', 't2-u2']);
  });

  it('T3: conflicts persisting past the retry bound reject with the typed conflict', async () => {
    localStorage.setItem(PROFILE_KEY, P.t3);
    const { db, migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    await migrationReady(db.name);
    const { encryptRow, getOrCreateSecret, ConversationConflictError } = await import(
      '../../lib/storage/db-crypto'
    );
    const secret = await getOrCreateSecret(P.t3);
    await db.conversations.bulkPut([await encryptRow(plainRow('t3', 'x') as never, secret, P.t3)]);
    const { updateConversation } = await import('../../db/conversations');

    let calls = 2;
    // Pre-build a pool of DISTINCT envelopes OUTSIDE every transaction: the
    // spy must never await crypto inside the Dexie tx (PC-06 applies to the
    // harness too - on slower CI runners an in-tx await trips
    // PrematureCommitError instead of the typed conflict).
    const pool = await Promise.all(
      Array.from({ length: 16 }, () => encryptRow(plainRow('t3', 'x') as never, secret, P.t3)),
    );
    const spy = vi.spyOn(db.conversations, 'get').mockImplementation((async () => {
      calls += 1;
      // Every re-read after phase 1 sees a DIFFERENT pre-built envelope:
      // the optimistic guard can never match, so all attempts conflict.
      return pool[calls % pool.length];
    }) as never);
    try {
      await expect(
        updateConversation('t3', { title: 'never lands' }, { stateEpoch: 0 }),
      ).rejects.toThrow(ConversationConflictError);
    } finally {
      spy.mockRestore();
    }
    void calls;
  });

  it('T4: a write landing between lock acquisition and migration is STILL migrated (stale snapshot)', async () => {
    localStorage.setItem(PROFILE_KEY, P.t4);
    const { db, migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    const late: SimpleRow = { id: 'late-row', title: 'Late' };
    const table = db.conversations;
    await table.bulkPut([plainRow('early-1', 'Early one') as never, plainRow('early-2', 'Early two') as never]);
    // The other tab's commit lands AFTER the lock is granted, BEFORE the
    // migration reads rows (the re-read-under-lock contract).
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, _opts: unknown, cb: () => Promise<unknown>): Promise<unknown> =>
          (async () => {
            await table.bulkPut([plainRow(late.id, late.title) as never]);
            return cb();
          })(),
      },
    });
    await migrationReady(db.name);
    const rows = await rawRowsOf(db.name);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row['v'], `row ${String(row['id'])} must be an envelope`).toBe(1);
    }
    const ids = rows.map((r) => String(r['id']));
    expect(ids).toContain(late.id);
  });

  it('T5: concurrent first-opens share ONE migration — no double encryption (double-open idempotence)', async () => {
    localStorage.setItem(PROFILE_KEY, P.t5);
    const { db, migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    await db.conversations.bulkPut([plainRow('d1', 'one') as never, plainRow('d2', 'two') as never]);
    const putSpy = vi.spyOn(db.conversations, 'put');
    // Two boot paths racing the first open (memoized: one migration runs).
    await Promise.all([migrationReady(db.name), migrationReady(db.name)]);
    expect(putSpy.mock.calls.length).toBe(2); // each row written exactly once
    const { getConversation } = await import('../../db/conversations');
    expect((await getConversation('d1'))?.title).toBe('one');
  });

  it('T6: a migration that fails mid-write resumes on the next attempt (rejected state cleared)', async () => {
    localStorage.setItem(PROFILE_KEY, P.t6);
    const { db, migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    await db.conversations.bulkPut([plainRow('c1', 'one') as never, plainRow('c2', 'two') as never]);
    const putSpy = vi.spyOn(db.conversations, 'put').mockImplementationOnce((async () => {
      throw new Error('disk full');
    }) as never);
    await expect(migrationReady(db.name)).rejects.toThrow('disk full');
    putSpy.mockRestore();
    await migrationReady(db.name); // retry completes
    const rows = await rawRowsOf(db.name);
    for (const row of rows) {
      expect(row['v']).toBe(1);
    }
    const { getConversation } = await import('../../db/conversations');
    expect((await getConversation('c1'))?.title).toBe('one');
  });

  it('T7: migration state is isolated per database name (per-dbName isolation)', async () => {
    localStorage.setItem(PROFILE_KEY, P.t7);
    const { db, migrationReady, __resetMigrationStatesForTests, DocQADatabase } = await freshModules();
    __resetMigrationStatesForTests();
    await db.conversations.bulkPut([plainRow('n1', 'active db') as never]);
    const second = new DocQADatabase(OTHER_DB);
    await second.conversations.bulkPut([plainRow('n2', 'other db') as never]);
    await migrationReady(db.name);
    // The OTHER db is untouched by the active db's migration.
    let other = await rawRowsOf(OTHER_DB);
    expect(other).toHaveLength(1);
    expect(other[0]!['v']).toBeUndefined(); // still plaintext
    await migrationReady(OTHER_DB);
    other = await rawRowsOf(OTHER_DB);
    expect(other[0]!['v']).toBe(1);
  });

  it('T9: search composes until+primaryKeys over REAL Dexie and returns decrypted matches newest-first', async () => {
    localStorage.setItem(PROFILE_KEY, 'lockmat9');
    const { db, migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    await migrationReady(db.name);
    const { createConversation, searchConversations } = await import('../../db/conversations');
    // Deliberately unsorted seeding: updatedAt 1,3,2 — the index orders.
    await createConversation(plainRow('s1', 'Alpha needle') as never);
    await createConversation({ ...plainRow('s2', 'Beta needle'), updatedAt: 3 } as never);
    await createConversation({ ...plainRow('s3', 'Gamma needle'), updatedAt: 2 } as never);
    const { matches } = await searchConversations('needle');
    expect(matches.map((c) => c.id)).toEqual(['s2', 's3', 's1']); // updatedAt 3,2,1
  });
});

  it('T8: a clear landing mid-migration is not resurrected (epoch-guarded write)', async () => {
    localStorage.setItem(PROFILE_KEY, 'lockm8t');
    const { db, migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    await db.conversations.bulkPut([plainRow('m1', 'one') as never, plainRow('m2', 'two') as never]);
    const cryptoMod = await import('../../lib/storage/db-crypto');
    const encSpy = vi.spyOn(cryptoMod, 'encryptRow').mockImplementation(async (conv, secret, prefix) => {
      // The clear lands AFTER the phase-1 read tx closed (crypto phase),
      // BEFORE the write tx (review F1). It comes from ANOTHER TAB, so it
      // does NOT share this tab's in-tab serializer: its storage effect is
      // performed directly (clear + epoch bump), bypassing the wrapper.
      encSpy.mockRestore();
      await db.transaction('rw', [db.conversations, db.meta], async () => {
        await db.conversations.clear();
        const epochRow = await db.meta.get('epoch');
        await db.meta.put({ key: 'epoch', value: (((epochRow?.value as number) ?? 0) + 1) });
      });
      return cryptoMod.encryptRow(conv, secret, prefix);
    });
    await expect(migrationReady(db.name)).rejects.toThrow(/superseded/);
    await migrationReady(db.name); // retry: post-clear store -> EMPTY_PROCEED
    expect(await rawRowsOf(db.name)).toHaveLength(0);
    const { getConversation } = await import('../../db/conversations');
    expect(await getConversation('m1')).toBeUndefined();
  });
  it('T10: adoption completes under Web Locks PRESENT (nested conv-write deadlock pin)', async () => {
    localStorage.setItem(PROFILE_KEY, 'lockm10t');
    const chains = new Map<string, Promise<unknown>>();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (name: string, _opts: unknown, cb: () => Promise<unknown>): Promise<unknown> => {
          const prev = chains.get(name) ?? Promise.resolve();
          const next = prev.then(cb, cb);
          chains.set(name, next.catch(() => undefined));
          return next;
        },
      },
    });
    const { adoptLegacyConversations } = await import('../../db/conv-protocol');
    // Seed the legacy shared db (native v2 schema, one plaintext row).
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('docqa_conversations', 2);
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
        tx.objectStore('conversations').put({
          id: 'leg-1', title: 'Legacy one',
          messages: [{ id: 'leg-1-u1', role: 'user', content: 'legacy q', timestamp: 1 }],
          createdAt: 1, updatedAt: 1, mode: 'server', modelUsed: 'legacy',
        });
        tx.oncomplete = () => { conn.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    const result = await adoptLegacyConversations('lockm10t');
    expect(result.outcome).toBe('adopted');
    const rows = await rawRowsOf('lockm10t-doc-qa-conversations');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['v']).toBe(1);
    // Read through the TARGET-named instance (the module-bound singleton
    // resolved its name at import time, before this test pinned the prefix).
    const { DocQADatabase: TargetDb } = await import('../../db/index');
    const target = new TargetDb('lockm10t-doc-qa-conversations');
    const row = await target.conversations.get('leg-1');
    expect(row, 'copied envelope readable via the target db').toBeDefined();
    const { decryptRowOrPlain } = await import('../../lib/storage/db-crypto');
    const conv = (await decryptRowOrPlain(row, 'lockm10t')) as { title: string };
    expect(conv.title).toBe('Legacy one');
  });


  it('T11: create binds the gate and the envelope to the SAME secret (key/operation)', async () => {
    localStorage.setItem(PROFILE_KEY, 'lockm11t');
    const { migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    await migrationReady(dbNameFor('lockm11t'));
    // A manager whose request() swaps the secret map BEFORE the critical
    // section runs: a secret change landing while create waits on the lock.
    const { PROFILE_SECRET_KEY: PSK } = await import('../../lib/storage/persisted-keys');
    const mapA = JSON.stringify({ lockm11t: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') });
    const mapB = JSON.stringify({ lockm11t: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') });
    localStorage.setItem(PSK, mapA);
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (n: string, _o: unknown, cb: () => Promise<unknown>): Promise<unknown> => {
          // Swap ONLY on the conv-write lock: the secret-map lock is taken
          // by the pre-gate encryption path, and swapping there would mask
          // the very race this leg pins.
          if (n === 'docqa-conv-write' && localStorage.getItem(PSK) === mapA) localStorage.setItem(PSK, mapB);
          return cb();
        },
      },
    });
    const { createConversation, getConversation } = await import('../../db/conversations');
    await createConversation(plainRow('k1', 'bound secret') as never);
    const stored = await getConversation('k1');
    expect(stored, 'the persisted envelope must be readable under the post-swap secret').toBeDefined();
    expect(stored?.title).toBe('bound secret');
  });

  it('T12: re-adoption refuses to copy under a swapped secret (wrong-key fail-closed; span placement enforced in-code)', async () => {
    localStorage.setItem(PROFILE_KEY, 'lockm12t');
    const { migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    await migrationReady(dbNameFor('lockm12t'));
    const { PROFILE_SECRET_KEY: PSK } = await import('../../lib/storage/persisted-keys');
    const { encryptRow, getOrCreateSecret } = await import('../../lib/storage/db-crypto');
    const secretA = await getOrCreateSecret('lockm12t');
    const { DocQADatabase } = await import('../../db/index');
    const d = new DocQADatabase('lockm12t-doc-qa-conversations');
    // The target legitimately holds ONE envelope encrypted under secret A.
    await d.conversations.bulkPut([await encryptRow(plainRow('own', 'own row') as never, secretA, 'lockm12t')]);
    // A DIFFERENT valid secret B replaces A in the map.
    const mapB = JSON.stringify({ lockm12t: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') });
    localStorage.setItem(PSK, mapB);
    // A legacy db row waits for re-adoption; the done marker routes to the
    // re-adoption fast path (PRR-111).
    localStorage.setItem('doc-qa-legacy-migration-done', '1');
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('docqa_conversations', 2);
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
        tx.objectStore('conversations').put({
          id: 'leg-x', title: 'Legacy re', messages: [{ id: 'leg-x-u1', role: 'user', content: 'x', timestamp: 1 }],
          createdAt: 1, updatedAt: 1, mode: 'server', modelUsed: 'legacy',
        });
        tx.oncomplete = () => { conn.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    // The key-state gate sees secret B against an A-encrypted store and
    // REFUSES before any copy: the adoption call rejects and the re-adopt
    // copy must NOT have happened. (The probe-inside-the-span placement is
    // enforced by the RC6-01 span in code; this leg pins the OUTCOME.)
    const result = await import('../../db/conv-protocol').then((m) => m.adoptLegacyConversations('lockm12t'));
    expect(['refused', 'failed']).toContain(result.outcome);
    const rows = await rawRowsOf('lockm12t-doc-qa-conversations');
    expect(rows, 're-adopt copy must be refused under the swapped secret').toHaveLength(1);
  });

  it('T13: encrypt refuses when the custody secret changes during acquisition (F-A1, no silent orphan)', async () => {
    localStorage.setItem(PROFILE_KEY, 'lockm13t');
    const { migrationReady, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    await migrationReady(dbNameFor('lockm13t'));
    const { PROFILE_SECRET_KEY: PSK } = await import('../../db/../lib/storage/persisted-keys');
    const { createConversation } = await import('../../db/conversations');
    const secretA = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const secretB = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    localStorage.setItem(PSK, JSON.stringify({ lockm13t: secretA }));
    const origGet = Storage.prototype.getItem;
    let custodyReads = 0;
    const reads: string[] = [];
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: unknown, key: string) {
      const value = origGet.call(this, key);
      if (key === PSK) {
        custodyReads += 1;
        reads.push(`#${custodyReads}:${String(value).length}`);
        if (custodyReads === 3) {
          localStorage.setItem(PSK, JSON.stringify({ lockm13t: secretB }));
          reads.push('SWAPPED-AFTER-3');
        }
      }
      return value;
    });
    let outcome = 'resolved';
    try {
      const res = await createConversation(plainRow('k13', 'stable secret') as never);
      outcome = `resolved ${res}`;
    } catch (e) {
      outcome = `REJECTED ${(e as Error).message.slice(0, 48)}`;
    } finally {
      getSpy.mockRestore();
    }
    console.log('T13-TRACE:', JSON.stringify({ reads, outcome }));
    const { DocQADatabase: TargetDb } = await import('../../db/index');
    const target = new TargetDb('lockm13t-doc-qa-conversations');
    expect(await target.conversations.toArray()).toHaveLength(0);
    expect(await createConversation(plainRow('k13', 'stable secret') as never)).toBe(true);
  });

describe('gate-level key-state matrix (#367 review F5a): requireKeyForWrite drives the REAL gate', () => {
  it('G1 EMPTY+ABSENT resolves without minting; G2 PLAINTEXT+ABSENT mints and resolves', async () => {
    localStorage.setItem(PROFILE_KEY, 'gatet1');
    const { DocQADatabase, requireKeyForWrite, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    const d = new DocQADatabase('gatet1-doc-qa-conversations');
    await requireKeyForWrite(d); // G1
    const { PROFILE_SECRET_KEY } = await import('../../lib/storage/persisted-keys');
    expect(localStorage.getItem(PROFILE_SECRET_KEY)).toBeNull();
    await d.conversations.bulkPut([plainRow('g-row', 'plain') as never]);
    await requireKeyForWrite(d); // G2
    expect(localStorage.getItem(PROFILE_SECRET_KEY)).not.toBeNull();
  });

  it('G3 ENVELOPE+ABSENT refuses (no-key); ENVELOPE+WRONG refuses (wrong-key)', async () => {
    localStorage.setItem(PROFILE_KEY, 'gatet3');
    const { DocQADatabase, requireKeyForWrite, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    const d = new DocQADatabase('gatet3-doc-qa-conversations');
    const { encryptRow, getOrCreateSecret, ConversationDecryptError } = await import('../../lib/storage/db-crypto');
    const real = await getOrCreateSecret('gatet3');
    const wrong = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    await d.conversations.bulkPut([await encryptRow(plainRow('g3', 'x') as never, real, 'gatet3')]);
    localStorage.removeItem(PROFILE_SECRET_KEY);
    await expect(requireKeyForWrite(d)).rejects.toThrow(ConversationDecryptError);
    localStorage.setItem(PROFILE_SECRET_KEY, JSON.stringify({ gatet3: wrong }));
    await expect(requireKeyForWrite(d)).rejects.toThrow(/FAIL_WRONG_KEY/);
  });

  it('G4 MIXED+ABSENT refuses; MIXED+VALID resolves; INVALID refuses', async () => {
    localStorage.setItem(PROFILE_KEY, 'gatet4');
    const { DocQADatabase, requireKeyForWrite, __resetMigrationStatesForTests } = await freshModules();
    __resetMigrationStatesForTests();
    const d = new DocQADatabase('gatet4-doc-qa-conversations');
    const { encryptRow, getOrCreateSecret, ConversationDecryptError } = await import('../../lib/storage/db-crypto');
    const secret = await getOrCreateSecret('gatet4');
    await d.conversations.bulkPut([
      await encryptRow(plainRow('g4-e', 'env') as never, secret, 'gatet4'),
      plainRow('g4-p', 'plain') as never,
    ]);
    localStorage.removeItem(PROFILE_SECRET_KEY);
    await expect(requireKeyForWrite(d)).rejects.toThrow(/FAIL_NO_KEY/); // MIXED+ABSENT
    const { PROFILE_SECRET_KEY: PSK } = await import('../../lib/storage/persisted-keys');
    localStorage.setItem(PSK, JSON.stringify({ gatet4: secret }));
    await requireKeyForWrite(d); // secret restored -> MIXED+VALID resolves
    await d.conversations.bulkPut([{ id: 'bad', v: 9, e: { iv: 'AA', ct: 'BB' }, createdAt: 1, updatedAt: 1 } as never]);
    await expect(requireKeyForWrite(d)).rejects.toThrow(/FAIL_INVALID/);
  });
});
