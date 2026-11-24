// frozen-check C2 (rev 2, critic-mandated amendment 2) — #372 AC2:
// deleteConversation advances the stored conversation epoch in the SAME
// transaction, so (i) a first-open migration racing the delete is superseded
// instead of resurrecting the row, (ii) a failed epoch-advance write aborts
// the whole delete transaction, and (iii) stale-captured deletes abort while
// re-read-epoch deletes land.
//
// FROZEN SPEC — authored by the independent check author at base
// 54107572c092febc00beff17f719ff631a2215ac, before any implementation
// exists. The implementer must make this pass WITHOUT editing it; the
// canonical copy lives in the issue trace and is dropped into the repo
// byte-identical at web_ui/src/db/__tests__/conversations.delete-epoch.test.ts.
//
// RED at base, GREEN after the fix — per leg:
//   (a) control (delete applies, row removed): GREEN at base AND after.
//   (b) epoch advanced: RED at base (delete commits no epoch write,
//       02-reproduction.md R1), GREEN after.
//   (c1) withEpochGate resurrection refusal: RED at base (the gate still
//       matches the unmoved epoch and re-puts the row), GREEN after.
//   (c2) new-epoch writes apply / pre-delete stale writes abort: RED at
//       base (nothing stales), GREEN after.
//   (d) REAL migration interleave: RED at base (the stalled migration's
//       phase-3 epoch guard still matches, so it RESURRECTS the deleted
//       row), GREEN after (the delete-advanced epoch supersedes the
//       migration — it aborts).
//   (e) same-transaction failure witness: RED at base (the delete
//       transaction never writes meta, so the forced failure never fires
//       and the delete commits), GREEN after (the failed epoch write aborts
//       the whole tx: row present, epoch unchanged).
//   (f) sequential-delete semantics: RED at base (a delete captured before
//       the first delete still applies), GREEN after (stale abort + rebind
//       lands).
//
// Harness contract (mirrors web_ui/src/db/__tests__/conversations.at-rest-
// encryption.test.ts): real IndexedDB semantics via the `fake-indexeddb`
// devDependency (`import 'fake-indexeddb/auto'` installs the global before
// any Dexie open), per-test UNIQUE profile prefix + vi.resetModules + dynamic
// import AFTER the prefix is pinned (the db singleton captures its NAME at
// import time). Web Locks are absent under jsdom — exactly the non-Web-Locks
// deployment class where the migration-vs-delete race is reachable: the
// conv-write lock degrades to per-module-instance in-tab chains
// (exclusive-lock.ts localChains), so TWO freshly-imported module instances
// have INDEPENDENT lock chains — which is how leg (d) models two tabs.
//
// Leg (d) mechanism (the REAL interleave): vi.doMock wraps db-crypto's
// encryptRow with a one-shot manual barrier, so the MIGRATING module
// instance's migrateUnderLock (web_ui/src/db/index.ts) stalls between its
// phase-1 read and its phase-3 write (the await sits inside encryptRow —
// the crypto gap migrateUnderLock itself requires). While stalled, a SECOND
// freshly-imported instance (an independent lock chain, i.e. the other tab)
// runs deleteConversation to completion. The barrier releases and the
// migration's OWN phase-3 epoch guard decides: superseded (the fixed
// behavior — the deleted row stays deleted) or resurrect (the base defect).
// Declared write surface for leg (e): the fix's advancing write must go
// through the meta TABLE's put or add (db.meta.put / db.meta.add) — the
// natural Dexie write shapes the witness spies.
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { PROFILE_KEY } from '../../lib/storage/persisted-keys';
import type { Conversation } from '../conversations';

let prefixCounter = 0;

/** Prefixes satisfy the base shape regex ^[a-z0-9]{3,8}$. */
function nextPrefix(): string {
  prefixCounter += 1;
  return 'c2' + String(prefixCounter).padStart(6, '0');
}

/**
 * Fresh module graph for a pinned profile (the repo recipe). Returns the
 * REAL public API plus the REAL protocol/db modules from the same
 * post-reset registry, so every leg drives production functions.
 */
async function freshDb(prefix: string) {
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, prefix);
  vi.resetModules();
  const conversations = await import('../conversations');
  const convProtocol = await import('../conv-protocol');
  const dbIndex = await import('../index');
  return { conversations, convProtocol, dbIndex };
}

function seededConversation(id: string, title: string): Conversation {
  return {
    id,
    title,
    messages: [
      { id: `${id}-m1`, role: 'user', content: `question in ${title}`, timestamp: 1730000000000 },
      { id: `${id}-m2`, role: 'assistant', content: `answer in ${title}`, timestamp: 1730000001000 },
    ],
    createdAt: 1730000000000,
    updatedAt: 1730000001000,
    mode: 'wllma',
    modelUsed: 'test-model',
  } as unknown as Conversation;
}

/** RAW plaintext seed of one row into a named conversations store (the
 *  pre-#367 rollout shape — the first-open migration's input), bypassing
 *  Dexie entirely. */
function rawPutConversation(dbName: string, row: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('conversations')) {
        req.result.createObjectStore('conversations', { keyPath: 'id' });
      }
      if (!req.result.objectStoreNames.contains('meta')) {
        req.result.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const conn = req.result;
      const tx = conn.transaction('conversations', 'readwrite');
      tx.objectStore('conversations').put(row);
      tx.oncomplete = () => {
        conn.close();
        resolve();
      };
      tx.onerror = () => {
        conn.close();
        reject(tx.error ?? new Error('raw put failed'));
      };
    };
    req.onerror = () => reject(req.error ?? new Error('raw open failed'));
  });
}

describe('delete advances the conversation epoch (#372 AC2)', () => {
  it('(a) control: deleteConversation applies and removes exactly the targeted row', async () => {
    const { conversations } = await freshDb(nextPrefix());
    expect(await conversations.createConversation(seededConversation('del-ctl-a', 'Control A'))).toBe(true);
    expect(await conversations.createConversation(seededConversation('del-ctl-b', 'Control B'))).toBe(true);

    const applied = await conversations.deleteConversation('del-ctl-a');
    expect(applied, 'the delete must report applied (the epoch gate was not stale)').toBe(true);

    expect(await conversations.countConversations()).toBe(1);
    expect(await conversations.getConversation('del-ctl-a')).toBeUndefined();
    const kept = await conversations.getConversation('del-ctl-b');
    expect(kept?.title).toBe('Control B');
  });

  it('(b) the stored epoch advances; (c1) a pre-delete-epoch guarded write cannot resurrect the row; (c2) new-epoch writes apply and pre-delete stale writes abort', async () => {
    const { conversations, convProtocol, dbIndex } = await freshDb(nextPrefix());
    const victim = seededConversation('del-race', 'Resurrection victim');
    const neighbor = seededConversation('del-neighbor', 'Surviving neighbor');
    expect(await conversations.createConversation(victim)).toBe(true);
    expect(await conversations.createConversation(neighbor)).toBe(true);

    const preDeleteEpoch = await convProtocol.readConversationEpoch();
    expect(await conversations.deleteConversation(victim.id)).toBe(true);

    // (b) the stored epoch advanced.
    const postDeleteEpoch = await convProtocol.readConversationEpoch();
    expect(
      postDeleteEpoch,
      'delete must advance the conversation epoch (monotonic, like the clear path)',
    ).toBeGreaterThan(preDeleteEpoch);

    // (c1) GATE-LEVEL resurrection leg — the migration's phase-3 write is a
    // conversations.put guarded by an in-transaction epoch-equality recheck;
    // withEpochGate is that same guard idiom (same readEpochOf-equality check
    // inside the same rw transaction scope over conversations+meta), driven
    // here as a REAL module function against the REAL post-delete state.
    const resurrected = await convProtocol.withEpochGate(preDeleteEpoch, async () => {
      await dbIndex.db.conversations.put({
        id: victim.id,
        title: 'resurrected by a superseded writer',
        messages: [],
        createdAt: 1730000000000,
        updatedAt: 1730000009000,
        mode: 'wllma',
        modelUsed: 'test-model',
      } as never);
    });
    expect(resurrected, 'a write captured under the pre-delete epoch must be refused (superseded)').toBe(false);
    expect(await conversations.getConversation(victim.id)).toBeUndefined();
    expect(await conversations.countConversations()).toBe(1);

    // (c2) the advance stales ONLY pre-delete captures, not the gate itself:
    // a public-API write under the POST-delete epoch applies...
    const freshWrite = await conversations.updateConversation(
      neighbor.id,
      { title: 'renamed after the delete' },
      { stateEpoch: postDeleteEpoch },
    );
    expect(freshWrite, 'a write captured under the post-delete epoch must apply').toBe(true);
    expect((await conversations.getConversation(neighbor.id))?.title).toBe('renamed after the delete');
    // ...and a public-API write captured under the PRE-delete epoch (another
    // tab's stale queued save) is aborted with no write.
    const staleWrite = await conversations.updateConversation(
      neighbor.id,
      { title: 'stale save that must be aborted' },
      { stateEpoch: preDeleteEpoch },
    );
    expect(staleWrite, 'a write captured under the pre-delete epoch must be a no-op').toBe(false);
    expect((await conversations.getConversation(neighbor.id))?.title).toBe('renamed after the delete');
  });

  it('(d) REAL interleave: a migration stalled between its phases is superseded by a delete from a second module instance — the deleted row is NOT resurrected', async () => {
    const prefix = nextPrefix();
    const dbName = `${prefix}-doc-qa-conversations`;
    // Seed ONE plaintext row (the migration's input shape), pinned to the
    // profile BEFORE any module import.
    localStorage.clear();
    localStorage.setItem(PROFILE_KEY, prefix);
    await rawPutConversation(dbName, seededConversation('del-inter', 'Interleave victim') as unknown as Record<string, unknown>);

    // The one-shot decrypt barrier: the FIRST encryptRow call (the migrating
    // instance's) stalls until released; later calls pass straight through
    // (the deleting instance's own migration must complete). vi.doMock is
    // not hoisted, so the factory closes over the test-local promises.
    let releaseBarrier!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let stalledOnce = false;
    vi.doMock('../../lib/storage/db-crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../lib/storage/db-crypto')>();
      return {
        ...actual,
        encryptRow: ((row: unknown, secret: unknown, prefixArg: string) => {
          if (!stalledOnce) {
            stalledOnce = true;
            signalEntered();
            return release.then(() => actual.encryptRow(row as Parameters<typeof actual.encryptRow>[0], secret as never, prefixArg));
          }
          return actual.encryptRow(row as Parameters<typeof actual.encryptRow>[0], secret as never, prefixArg);
        }) as typeof actual.encryptRow,
      };
    });

    // INSTANCE A (the migrating "tab"): its migrationReady runs the REAL
    // migrateUnderLock; phase 1 reads the plaintext row + epoch, then the
    // crypto gap stalls on the barrier — deterministically between phase 1
    // and phase 3 (no sleeps: a promise resolved manually).
    vi.resetModules();
    const A = await import('../index');
    const migrationDone = A.migrationReady(dbName);
    await entered; // A is now stalled mid-migration.

    // INSTANCE B (the deleting "tab"): a FRESH module realm — an independent
    // in-tab lock chain (the non-Web-Locks cross-tab condition). Its own
    // migration completes (the barrier is one-shot), then the delete runs.
    // localStorage is deliberately NOT cleared here: instance A already
    // minted the profile secret mid-migration, and B must share it (two tabs
    // of one profile share the storage realm).
    vi.resetModules();
    const B = {
      conversations: await import('../conversations'),
      convProtocol: await import('../conv-protocol'),
    };
    const epochBeforeDelete = await B.convProtocol.readConversationEpoch();
    expect(await B.conversations.deleteConversation('del-inter')).toBe(true);
    expect(await B.conversations.getConversation('del-inter')).toBeUndefined();
    const epochAfterDelete = await B.convProtocol.readConversationEpoch();

    // Release the stalled migration: its phase-3 epoch guard now decides.
    releaseBarrier();
    let migrationRejected = false;
    try {
      await migrationDone;
    } catch {
      migrationRejected = true;
    }
    expect(
      migrationRejected,
      'the stalled migration must be superseded (abort) by the delete that advanced the epoch',
    ).toBe(true);
    expect(
      await B.conversations.getConversation('del-inter'),
      'the deleted row must NOT be resurrected by the migration phase-3 writes',
    ).toBeUndefined();
    expect(epochAfterDelete, 'the delete advanced the epoch (the supersede signal)').toBeGreaterThan(epochBeforeDelete);

    vi.doUnmock('../../lib/storage/db-crypto');
  });

  it('(e) same-transaction failure witness: a forced meta-write failure aborts the WHOLE delete transaction — the row survives and the epoch is unchanged', async () => {
    const { conversations, convProtocol, dbIndex } = await freshDb(nextPrefix());
    const target = seededConversation('del-atomic', 'Atomicity witness');
    expect(await conversations.createConversation(target)).toBe(true);
    const epochBefore = await convProtocol.readConversationEpoch();

    // Force the advancing write to fail INSIDE the delete transaction (the
    // declared write surface: db.meta.put / db.meta.add). mockRejectedValueOnce
    // on each shape: whichever the fix uses rejects exactly once, inside the
    // tx — Dexie aborts the whole transaction.
    const putSpy = vi.spyOn(dbIndex.db.meta, 'put').mockRejectedValueOnce(new Error('epoch write failed'));
    const addSpy = vi.spyOn(dbIndex.db.meta, 'add').mockRejectedValueOnce(new Error('epoch write failed'));
    try {
      await conversations.deleteConversation(target.id).catch(() => {
        /* a genuine write failure may propagate (PRR-105) — the rolled-back
           STATE is what this leg asserts */
      });
    } finally {
      putSpy.mockRestore();
      addSpy.mockRestore();
    }

    expect(
      await conversations.countConversations(),
      'a failed epoch-advance write must abort the whole delete transaction: the row survives',
    ).toBe(1);
    expect(await conversations.getConversation(target.id)).toBeDefined();
    expect(await convProtocol.readConversationEpoch(), 'the epoch must be unchanged (the advance rolled back too)').toBe(epochBefore);
  });

  it('(f) sequential deletes: a stateEpoch captured BEFORE the first delete aborts the second; a re-read epoch (the rebind contract) lands it', async () => {
    const { conversations, convProtocol } = await freshDb(nextPrefix());
    expect(await conversations.createConversation(seededConversation('del-seq-a', 'First deleted'))).toBe(true);
    expect(await conversations.createConversation(seededConversation('del-seq-b', 'Second deleted'))).toBe(true);

    const epochBeforeFirst = await convProtocol.readConversationEpoch();
    expect(await conversations.deleteConversation('del-seq-a')).toBe(true); // the first lands

    // The second delete was captured BEFORE the first delete advanced the
    // epoch (a stale queued delete in another tab): it must abort.
    const staleSecond = await conversations.deleteConversation('del-seq-b', { stateEpoch: epochBeforeFirst });
    expect(staleSecond, 'a delete whose stateEpoch predates the first delete must abort').toBe(false);
    expect(await conversations.getConversation('del-seq-b'), 'the aborted delete leaves its row intact').toBeDefined();

    // The rebind contract: re-read the epoch, then the delete lands.
    const epochRebound = await convProtocol.readConversationEpoch();
    expect(await conversations.deleteConversation('del-seq-b', { stateEpoch: epochRebound })).toBe(true);
    expect(await conversations.getConversation('del-seq-b')).toBeUndefined();
  });
});
