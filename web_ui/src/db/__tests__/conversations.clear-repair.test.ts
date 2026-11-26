import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { CONVERSATIONS_CLEARED_KEY, PROFILE_KEY } from '../../lib/storage/persisted-keys';
import type { Conversation } from '../conversations';

let prefixCounter = 0;
const nextPrefix = (): string => 'cr' + String(++prefixCounter).padStart(6, '0');

async function freshDb(prefix: string) {
  localStorage.clear();
  localStorage.setItem(PROFILE_KEY, prefix);
  vi.resetModules();
  const conversations = await import('../conversations');
  const convProtocol = await import('../conv-protocol');
  const dbIndex = await import('../index');
  return { conversations, convProtocol, dbIndex };
}

function conversation(id: string): Conversation {
  return {
    id,
    title: id,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    mode: 'wllama',
    modelUsed: 'test',
  };
}

function writeRecord(record: unknown): void {
  localStorage.setItem(CONVERSATIONS_CLEARED_KEY, JSON.stringify(record));
}

async function storedRow(dbIndex: typeof import('../index'), id: string): Promise<Record<string, unknown>> {
  const row = await dbIndex.db.conversations.get(id);
  return row as unknown as Record<string, unknown>;
}

describe('M3v10 clear repair and durable deletion evidence', () => {
  it('a delete records pending-goal evidence; false completion keeps post-skip tagged rows and wipes untagged rows', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    try {
      await conversations.createConversation(conversation('wipe-me'));
      await conversations.createConversation(conversation('delete-me'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, pendingV2: { epochGoal: 1, profile: prefix }, completed: null });

      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeDefined();
      expect(await dbIndex.db.meta.get('legacy-tomb:delete-me')).toEqual({ key: 'legacy-tomb:delete-me', value: 1 });

      // Old-writer schedule: the delete's epoch advance made the old clear skip;
      // a row created after that skip still sees pending G and must survive the
      // later false completion repair.
      await conversations.createConversation(conversation('post-skip-z'));
      expect((await storedRow(dbIndex, 'post-skip-z')).sawPendingGoal).toBe(1);
      writeRecord({ pending: null, completed: { [prefix]: 1 } });

      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(1);
      expect(await dbIndex.db.conversations.get('wipe-me')).toBeUndefined();
      expect(await dbIndex.db.conversations.get('post-skip-z')).toBeDefined();
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeUndefined();
      expect(await dbIndex.db.meta.get(`cleared-goal:${prefix}`)).toEqual({ key: `cleared-goal:${prefix}`, value: 1 });
      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(0);
    } finally {
      dbIndex.db.close();
    }
  });

  it('a base-writer rewrite keeps the authenticated inner pending tag and survives repair without outer metadata (F-001)', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    const dbCrypto = await import('../../lib/storage/db-crypto');
    try {
      await conversations.createConversation(conversation('wipe-me'));
      await conversations.createConversation(conversation('delete-me'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, pendingV2: { epochGoal: 1, profile: prefix }, completed: null });

      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      await conversations.createConversation(conversation('post-skip-z'));
      expect((await storedRow(dbIndex, 'post-skip-z')).sawPendingGoal).toBe(1);

      // Base-writer rewrite: the base build's update path decrypts the row to
      // a Conversation whose scoped tags ride the authenticated plaintext,
      // merges, and re-encrypts with a writer that has no M3v10 knowledge —
      // the inner sawPendingGoal survives the ciphertext while the outer
      // envelope fields are not reproduced (the F-001 defect input).
      const decrypted = await dbCrypto.decryptRowOrPlain<Conversation & Record<string, unknown>>(
        await storedRow(dbIndex, 'post-skip-z'),
        prefix,
      );
      expect(decrypted['sawPendingGoal']).toBe(1);
      const rewritten = await dbCrypto.encryptRow(
        { ...decrypted, title: 'base-rewritten' },
        undefined,
        prefix,
      );
      delete rewritten['afterClear'];
      delete rewritten['sawPendingGoal'];
      await dbIndex.db.conversations.put(rewritten);
      expect((await storedRow(dbIndex, 'post-skip-z')).sawPendingGoal).toBeUndefined();
      const reread = await dbCrypto.decryptRowOrPlain<Record<string, unknown>>(
        await storedRow(dbIndex, 'post-skip-z'),
        prefix,
      );
      expect(reread['sawPendingGoal']).toBe(1);

      writeRecord({ pending: null, completed: { [prefix]: 1 } });
      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(1);
      // The rewritten row must survive on its authenticated inner evidence;
      // the genuinely untagged pre-skip row still wipes.
      expect(await dbIndex.db.conversations.get('post-skip-z')).toBeDefined();
      expect(await dbIndex.db.conversations.get('wipe-me')).toBeUndefined();
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeUndefined();
    } finally {
      dbIndex.db.close();
    }
  });

  it('a base-writer rewrite landing between the decrypt pass and the repair transaction defers with zero deletes and no evidence consumption (F-001 Stage B)', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    const dbCrypto = await import('../../lib/storage/db-crypto');
    try {
      await conversations.createConversation(conversation('wipe-me'));
      await conversations.createConversation(conversation('delete-me'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, pendingV2: { epochGoal: 1, profile: prefix }, completed: null });

      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      await conversations.createConversation(conversation('post-skip-z'));
      expect((await storedRow(dbIndex, 'post-skip-z')).sawPendingGoal).toBe(1);
      writeRecord({ pending: null, completed: { [prefix]: 1 } });

      // Deterministic interleaving: repair's FIRST conversations.toArray() is
      // the pre-transaction snapshot; once it returns (the row is outer-tagged,
      // so the decrypt pass skips it), a base writer re-encrypts the row in
      // the gap — inner sawPendingGoal preserved, outer fields dropped. The
      // rw transaction then reads bytes that match no authenticated snapshot.
      const originalToArray = dbIndex.db.conversations.toArray.bind(dbIndex.db.conversations);
      let first = true;
      vi.spyOn(dbIndex.db.conversations, 'toArray').mockImplementation((async () => {
        const snapshot = await originalToArray();
        if (first) {
          first = false;
          const target = snapshot.find((row) => (row as { id?: string }).id === 'post-skip-z')!;
          const decrypted = await dbCrypto.decryptRowOrPlain<Conversation & Record<string, unknown>>(target, prefix);
          const rewritten = await dbCrypto.encryptRow({ ...decrypted, title: 'base-rewritten' }, undefined, prefix);
          delete rewritten['afterClear'];
          delete rewritten['sawPendingGoal'];
          await dbIndex.db.conversations.put(rewritten);
        }
        return snapshot;
      }) as never);

      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(0);
      // Deferred: nothing deleted; evidence, markers, epoch and record intact.
      expect(await dbIndex.db.conversations.get('post-skip-z')).toBeDefined();
      expect(await dbIndex.db.conversations.get('wipe-me')).toBeDefined();
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeDefined();
      expect(await dbIndex.db.meta.get(`cleared-goal:${prefix}`)).toBeUndefined();
      expect(await dbIndex.db.meta.get('epoch')).toEqual({ key: 'epoch', value: 1 });
      const record = JSON.parse(localStorage.getItem(CONVERSATIONS_CLEARED_KEY)!) as { completed?: Record<string, number> };
      expect(record.completed?.[prefix]).toBe(1);

      // A settled retry snapshots the rewritten bytes, authenticates the inner
      // tag, and completes: the untagged pre-skip row wipes, the survivor stays.
      vi.restoreAllMocks();
      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(1);
      expect(await dbIndex.db.conversations.get('post-skip-z')).toBeDefined();
      expect(await dbIndex.db.conversations.get('wipe-me')).toBeUndefined();
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeUndefined();
      expect(await dbIndex.db.meta.get(`cleared-goal:${prefix}`)).toEqual({ key: `cleared-goal:${prefix}`, value: 1 });
    } finally {
      vi.restoreAllMocks();
      dbIndex.db.close();
    }
  });

  it('replay re-arms a deferred repair automatically and completes without a manual retry (F-001 Stage B follow-up)', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    const dbCrypto = await import('../../lib/storage/db-crypto');
    try {
      await conversations.createConversation(conversation('wipe-me'));
      await conversations.createConversation(conversation('delete-me'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, pendingV2: { epochGoal: 1, profile: prefix }, completed: null });

      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      await conversations.createConversation(conversation('post-skip-z'));
      expect((await storedRow(dbIndex, 'post-skip-z')).sawPendingGoal).toBe(1);
      writeRecord({ pending: null, completed: { [prefix]: 1 } });

      // One-shot interleave + instability observation: toArray call 1 is
      // repair attempt 1's pre-transaction snapshot — the base writer
      // rewrites the tagged row in the gap, so attempt 1 defers. Call 3 is
      // attempt 2's pre-transaction snapshot, taken AFTER the bounded settle
      // delay: the state captured there proves the deferred attempt deleted
      // nothing and consumed no evidence, while its rows let attempt 2
      // authenticate the rewritten row and complete.
      const originalToArray = dbIndex.db.conversations.toArray.bind(dbIndex.db.conversations);
      let calls = 0;
      let deferredAttemptConsumedNothing = false;
      vi.spyOn(dbIndex.db.conversations, 'toArray').mockImplementation((async () => {
        const snapshot = await originalToArray();
        calls += 1;
        if (calls === 1) {
          const target = snapshot.find((row) => (row as { id?: string }).id === 'post-skip-z')!;
          const decrypted = await dbCrypto.decryptRowOrPlain<Conversation & Record<string, unknown>>(target, prefix);
          const rewritten = await dbCrypto.encryptRow({ ...decrypted, title: 'base-rewritten' }, undefined, prefix);
          delete rewritten['afterClear'];
          delete rewritten['sawPendingGoal'];
          await dbIndex.db.conversations.put(rewritten);
        }
        if (calls === 3) {
          deferredAttemptConsumedNothing =
            (await dbIndex.db.conversations.get('post-skip-z')) !== undefined &&
            (await dbIndex.db.conversations.get('wipe-me')) !== undefined &&
            (await dbIndex.db.meta.get('delete-post-1')) !== undefined &&
            (await dbIndex.db.meta.get(`cleared-goal:${prefix}`)) === undefined;
        }
        return snapshot;
      }) as never);

      // The automatic path: ONE replay call performs the interleaved repair
      // (defer), waits the bounded settle delay, retries, and completes —
      // no manual second repair call.
      expect(await convProtocol.replayPendingConversationClear()).toEqual({ replayed: false, deferred: false });
      expect(deferredAttemptConsumedNothing).toBe(true);

      expect(await dbIndex.db.conversations.get('post-skip-z')).toBeDefined();
      expect(await dbIndex.db.conversations.get('wipe-me')).toBeUndefined();
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeUndefined();
      expect(await dbIndex.db.meta.get(`cleared-goal:${prefix}`)).toEqual({ key: `cleared-goal:${prefix}`, value: 1 });
    } finally {
      vi.restoreAllMocks();
      dbIndex.db.close();
    }
  });

  it('an owed-clear replay transaction failure remains deferred for retry', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    try {
      await conversations.createConversation(conversation('still-here'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, completed: null });
      vi.spyOn(dbIndex.db, 'transaction').mockRejectedValueOnce(new Error('replay transaction failure') as never);
      expect(await convProtocol.replayPendingConversationClear()).toEqual({ replayed: false, deferred: true });
      expect(await dbIndex.db.conversations.get('still-here')).toBeDefined();
      expect(JSON.parse(localStorage.getItem(CONVERSATIONS_CLEARED_KEY)!).pending).toEqual({ epochGoal: 1, profile: prefix });
    } finally {
      vi.restoreAllMocks();
      dbIndex.db.close();
    }
  });

  it('a live completion storage notification re-arms a deferred repair automatically (F-001 closeout follow-up)', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    const dbCrypto = await import('../../lib/storage/db-crypto');
    let unsubscribe: () => void = () => {};
    try {
      await conversations.createConversation(conversation('wipe-me'));
      await conversations.createConversation(conversation('delete-me'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, pendingV2: { epochGoal: 1, profile: prefix }, completed: null });

      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      await conversations.createConversation(conversation('post-skip-z'));
      expect((await storedRow(dbIndex, 'post-skip-z')).sawPendingGoal).toBe(1);
      writeRecord({ pending: null, completed: { [prefix]: 1 } });

      // Inactivity is disabled/not involved: the notification below is
      // dispatched here directly and nothing else re-arms the repair.
      let resetCalls = 0;
      let resolveReset!: () => void;
      const resetDone = new Promise<void>((resolve) => { resolveReset = resolve; });
      unsubscribe = convProtocol.onConversationsCleared(() => { resetCalls += 1; resolveReset(); });

      // Force all six attempts in the bounded helper to defer (odd calls are
      // pre-transaction snapshots; even calls are the transaction reads). The
      // listener must then re-arm on its own, without inactivity or another
      // notification, and attempt 7 (call 13) completes on settled bytes.
      const originalToArray = dbIndex.db.conversations.toArray.bind(dbIndex.db.conversations);
      let calls = 0;
      let deferredAttemptConsumedNothing = false;
      vi.spyOn(dbIndex.db.conversations, 'toArray').mockImplementation((async () => {
        const snapshot = await originalToArray();
        calls += 1;
        if (calls % 2 === 1 && calls <= 11) {
          const target = snapshot.find((row) => (row as { id?: string }).id === 'post-skip-z')!;
          const decrypted = await dbCrypto.decryptRowOrPlain<Conversation & Record<string, unknown>>(target, prefix);
          const rewritten = await dbCrypto.encryptRow({ ...decrypted, title: 'base-rewritten' }, undefined, prefix);
          delete rewritten['afterClear'];
          delete rewritten['sawPendingGoal'];
          await dbIndex.db.conversations.put(rewritten);
        }
        if (calls === 13) {
          deferredAttemptConsumedNothing =
            (await dbIndex.db.conversations.get('post-skip-z')) !== undefined &&
            (await dbIndex.db.conversations.get('wipe-me')) !== undefined &&
            (await dbIndex.db.meta.get('delete-post-1')) !== undefined &&
            (await dbIndex.db.meta.get(`cleared-goal:${prefix}`)) === undefined;
        }
        return snapshot;
      }) as never);

      // ONE live-completion notification — no reload, no inactivity timer,
      // no further notification.
      window.dispatchEvent(new StorageEvent('storage', {
        key: CONVERSATIONS_CLEARED_KEY,
        newValue: localStorage.getItem(CONVERSATIONS_CLEARED_KEY),
      }));
      await resetDone;
      expect(resetCalls).toBe(1);
      expect(deferredAttemptConsumedNothing).toBe(true);

      expect(await dbIndex.db.conversations.get('post-skip-z')).toBeDefined();
      expect(await dbIndex.db.conversations.get('wipe-me')).toBeUndefined();
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeUndefined();
      expect(await dbIndex.db.meta.get(`cleared-goal:${prefix}`)).toEqual({ key: `cleared-goal:${prefix}`, value: 1 });
    } finally {
      unsubscribe();
      vi.restoreAllMocks();
      dbIndex.db.close();
    }
  });

  it('a timer-fired live repair rejection is caught, retried, and completes (F-001 final critic)', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    const dbCrypto = await import('../../lib/storage/db-crypto');
    let unsubscribe: () => void = () => {};
    try {
      await conversations.createConversation(conversation('wipe-me'));
      await conversations.createConversation(conversation('delete-me'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, pendingV2: { epochGoal: 1, profile: prefix }, completed: null });
      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      await conversations.createConversation(conversation('post-skip-z'));
      writeRecord({ pending: null, completed: { [prefix]: 1 } });

      let resetCalls = 0;
      let resolveReset!: () => void;
      const resetDone = new Promise<void>((resolve) => { resolveReset = resolve; });
      unsubscribe = convProtocol.onConversationsCleared(() => { resetCalls += 1; resolveReset(); });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const originalToArray = dbIndex.db.conversations.toArray.bind(dbIndex.db.conversations);
      let calls = 0;
      vi.spyOn(dbIndex.db.conversations, 'toArray').mockImplementation((async () => {
        const snapshot = await originalToArray();
        calls += 1;
        if (calls % 2 === 1 && calls <= 11) {
          const target = snapshot.find((row) => (row as { id?: string }).id === 'post-skip-z')!;
          const decrypted = await dbCrypto.decryptRowOrPlain<Conversation & Record<string, unknown>>(target, prefix);
          const rewritten = await dbCrypto.encryptRow({ ...decrypted, title: 'base-rewritten' }, undefined, prefix);
          delete rewritten['afterClear'];
          delete rewritten['sawPendingGoal'];
          await dbIndex.db.conversations.put(rewritten);
        }
        if (calls === 13) throw new Error('timer-fired database rejection');
        return snapshot;
      }) as never);

      window.dispatchEvent(new StorageEvent('storage', {
        key: CONVERSATIONS_CLEARED_KEY,
        newValue: localStorage.getItem(CONVERSATIONS_CLEARED_KEY),
      }));
      await resetDone;
      expect(resetCalls).toBe(1);
      expect(warn).toHaveBeenCalledWith('[conv-protocol] live completion repair failed:', expect.any(Error));
      expect(calls).toBeGreaterThanOrEqual(15);
      expect(await dbIndex.db.conversations.get('post-skip-z')).toBeDefined();
      expect(await dbIndex.db.conversations.get('wipe-me')).toBeUndefined();
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeUndefined();
      expect(await dbIndex.db.meta.get(`cleared-goal:${prefix}`)).toEqual({ key: `cleared-goal:${prefix}`, value: 1 });
    } finally {
      unsubscribe();
      vi.restoreAllMocks();
      dbIndex.db.close();
    }
  });

  it('a true clear writes no delete evidence and never wipes an old-tab untagged post-clear row', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    try {
      await conversations.createConversation(conversation('before-clear'));
      expect(await convProtocol.clearAllConversationsInDb(prefix)).toEqual({ cleared: true });
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeUndefined();

      // Simulate a base-build tab writing directly after the true clear: it
      // cannot stamp either scoped tag, but no false-completion evidence exists.
      await dbIndex.db.conversations.add(conversation('old-tab-after-clear'));
      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(0);
      expect(await dbIndex.db.conversations.get('old-tab-after-clear')).toBeDefined();
    } finally {
      dbIndex.db.close();
    }
  });

  it('current-goal priority keeps G2-tagged rows and wipes historical G1-only rows', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    try {
      await conversations.createConversation(conversation('delete-me'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, completed: { [prefix]: 1 } });
      await conversations.createConversation(conversation('historical-z1'));

      writeRecord({ pending: { epochGoal: 2, profile: prefix }, pendingV2: { epochGoal: 2, profile: prefix }, completed: { [prefix]: 1 } });
      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      await conversations.createConversation(conversation('current-z2'));
      expect(await storedRow(dbIndex, 'historical-z1')).toMatchObject({ afterClear: 1, sawPendingGoal: 1 });
      expect(await storedRow(dbIndex, 'current-z2')).toMatchObject({ afterClear: 1, sawPendingGoal: 2 });
      writeRecord({ pending: null, completed: { [prefix]: 2 } });

      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(1);
      expect(await dbIndex.db.conversations.get('historical-z1')).toBeUndefined();
      expect(await dbIndex.db.conversations.get('current-z2')).toBeDefined();
    } finally {
      dbIndex.db.close();
    }
  });

  it('cross-profile pending does not tag P and overwrite preserves existing scoped signals', async () => {
    const prefix = nextPrefix();
    const { conversations, dbIndex } = await freshDb(prefix);
    try {
      writeRecord({ pending: { epochGoal: 9, profile: 'other99' }, completed: null });
      await conversations.createConversation(conversation('cross-profile'));
      expect((await storedRow(dbIndex, 'cross-profile')).sawPendingGoal).toBeUndefined();

      writeRecord({ pending: { epochGoal: 2, profile: prefix }, completed: { [prefix]: 1 } });
      await conversations.createConversation(conversation('tagged'));
      expect(await conversations.updateConversation('tagged', { title: 'renamed' })).toBe(true);
      expect(await storedRow(dbIndex, 'tagged')).toMatchObject({ afterClear: 1, sawPendingGoal: 2 });
    } finally {
      dbIndex.db.close();
    }
  });

  it('delete evidence survives more than sixteen deletion posts', async () => {
    const prefix = nextPrefix();
    const { conversations, dbIndex } = await freshDb(prefix);
    try {
      for (let index = 0; index < 20; index += 1) await conversations.createConversation(conversation(`post-${index}`));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, completed: null });
      for (let index = 0; index < 20; index += 1) expect(await conversations.deleteConversation(`post-${index}`)).toBe(true);
      expect(await dbIndex.db.meta.get('delete-post-1')).toMatchObject({ value: { preEpoch: 0 } });
      expect(await dbIndex.db.meta.get('legacy-tomb:post-19')).toBeDefined();
    } finally {
      dbIndex.db.close();
    }
  });

  it('a legacy true clear with lost completion is distinguished by the pre-delete epoch', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    try {
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, pendingV2: { epochGoal: 1, profile: prefix }, completed: null });
      // Base-build true clear: epoch + clear, no cleared-goal marker and no
      // completion write. The current delete later records preEpoch=1.
      await dbIndex.db.transaction('rw', dbIndex.db.conversations, dbIndex.db.meta, async () => {
        await dbIndex.db.meta.put({ key: 'epoch', value: 1 });
        await dbIndex.db.conversations.clear();
      });
      await dbIndex.db.conversations.add(conversation('legacy-post-clear'));
      await conversations.createConversation(conversation('delete-me'));
      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      expect(await dbIndex.db.meta.get('delete-post-1')).toMatchObject({ value: { preEpoch: 1 } });
      await convProtocol.replayPendingConversationClear();
      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(0);
      expect(await dbIndex.db.conversations.get('legacy-post-clear')).toBeDefined();
    } finally {
      dbIndex.db.close();
    }
  });

  it('repairing one profile preserves another profile pending clear', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    try {
      await conversations.createConversation(conversation('delete-me'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, completed: null });
      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      writeRecord({
        pending: { epochGoal: 3, profile: 'other99' },
        pendingV2: { epochGoal: 3, profile: 'other99' },
        completed: { [prefix]: 1 },
      });
      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(0);
      const after = JSON.parse(localStorage.getItem(CONVERSATIONS_CLEARED_KEY)!) as { pending?: { epochGoal: number; profile: string } };
      expect(after.pending).toEqual({ epochGoal: 3, profile: 'other99' });
    } finally {
      dbIndex.db.close();
    }
  });

  it('a lost completion write after a true clear cannot make repair wipe an old-tab row', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    try {
      await conversations.createConversation(conversation('before-clear'));
      expect(await convProtocol.clearAllConversationsInDb(prefix)).toEqual({ cleared: true });
      expect(await dbIndex.db.meta.get(`cleared-goal:${prefix}`)).toEqual({ key: `cleared-goal:${prefix}`, value: 1 });
      // Simulate localStorage losing only the completion write: the durable
      // clear transaction committed, but the pending record remains.
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, pendingV2: { epochGoal: 1, profile: prefix }, completed: null });
      await dbIndex.db.conversations.add(conversation('old-tab-after-clear'));
      expect(await convProtocol.replayPendingConversationClear()).toEqual({ replayed: true, deferred: false });
      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(0);
      expect(await dbIndex.db.conversations.get('old-tab-after-clear')).toBeDefined();
    } finally {
      dbIndex.db.close();
    }
  });

  it('older repair preserves a newer pending goal and boot replay executes it', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    try {
      await conversations.createConversation(conversation('delete-me'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, completed: null });
      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      writeRecord({
        pending: { epochGoal: 2, profile: prefix },
        pendingV2: { epochGoal: 2, profile: prefix },
        completed: { [prefix]: 1 },
      });
      expect((await convProtocol.repairCompletedConversationClears(prefix)).repaired).toBe(0);
      const afterRepair = JSON.parse(localStorage.getItem(CONVERSATIONS_CLEARED_KEY)!) as { pending?: { epochGoal: number } };
      expect(afterRepair.pending?.epochGoal).toBe(2);
      expect(await convProtocol.replayPendingConversationClear()).toEqual({ replayed: true, deferred: false });
      expect(await dbIndex.db.meta.get(`cleared-goal:${prefix}`)).toEqual({ key: `cleared-goal:${prefix}`, value: 2 });
      expect(await convProtocol.readConversationEpoch()).toBe(2);
    } finally {
      dbIndex.db.close();
    }
  });

  it('a paused G repair is superseded by a true H clear and spares H-era rows', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    try {
      await conversations.createConversation(conversation('delete-me'));
      writeRecord({ pending: { epochGoal: 1, profile: prefix }, completed: null });
      expect(await conversations.deleteConversation('delete-me')).toBe(true);
      writeRecord({ pending: null, completed: { [prefix]: 1 } });

      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const repairEntered = new Promise<void>((resolve) => { entered = resolve; });
      const originalWhere = dbIndex.db.meta.where.bind(dbIndex.db.meta) as (...values: unknown[]) => {
        between: (...bounds: unknown[]) => { toArray(): Promise<Array<Record<string, unknown>>> };
      };
      let first = true;
      vi.spyOn(dbIndex.db.meta, 'where').mockImplementation(((...args: unknown[]) => {
        const collection = originalWhere(...args);
        if (first && args[0] === 'key') {
          first = false;
          return {
            between: (...bounds: unknown[]) => {
              const rows = collection.between(...bounds);
              return {
                toArray: async (): Promise<Array<Record<string, unknown>>> => {
                  const result = await rows.toArray();
                  entered();
                  await gate;
                  return result;
                },
              };
            },
          };
        }
        return collection;
      }) as never);

      const repair = convProtocol.repairCompletedConversationClears(prefix);
      await repairEntered;
      expect(await convProtocol.clearAllConversationsInDb(prefix)).toEqual({ cleared: true });
      await conversations.createConversation(conversation('h-era'));
      release();
      expect((await repair).repaired).toBe(0);
      expect(await dbIndex.db.conversations.get('h-era')).toBeDefined();
      expect(await storedRow(dbIndex, 'h-era')).toMatchObject({ afterClear: 2 });
    } finally {
      dbIndex.db.close();
    }
  });

  it('a 501-row adoption filters a tombstoned id without losing page offsets', async () => {
    const prefix = nextPrefix();
    const { conversations, convProtocol, dbIndex } = await freshDb(prefix);
    const legacy = new dbIndex.DocQADatabase(dbIndex.LEGACY_CONVERSATIONS_DB_NAME);
    try {
      await conversations.createConversation(conversation('legacy-0'));
      expect(await conversations.deleteConversation('legacy-0')).toBe(true);
      await legacy.conversations.bulkAdd(Array.from({ length: 501 }, (_, index) => conversation(`legacy-${index}`)));
      const result = await convProtocol.adoptLegacyConversations(prefix);
      expect(result).toEqual({ outcome: 'adopted', count: 500 });
      expect(await dbIndex.db.conversations.get('legacy-0')).toBeUndefined();
      expect(await dbIndex.db.conversations.get('legacy-500')).toBeDefined();
    } finally {
      legacy.close();
      dbIndex.db.close();
    }
  });
});
