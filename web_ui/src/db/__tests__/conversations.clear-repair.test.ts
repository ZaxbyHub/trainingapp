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

      expect(await convProtocol.repairCompletedConversationClears(prefix)).toBe(1);
      expect(await dbIndex.db.conversations.get('wipe-me')).toBeUndefined();
      expect(await dbIndex.db.conversations.get('post-skip-z')).toBeDefined();
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeUndefined();
      expect(await dbIndex.db.meta.get(`cleared-goal:${prefix}`)).toEqual({ key: `cleared-goal:${prefix}`, value: 1 });
      expect(await convProtocol.repairCompletedConversationClears(prefix)).toBe(0);
    } finally {
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
      expect(await convProtocol.repairCompletedConversationClears(prefix)).toBe(0);
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

      expect(await convProtocol.repairCompletedConversationClears(prefix)).toBe(1);
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
      expect(await dbIndex.db.meta.get('delete-post-1')).toBeDefined();
      expect(await dbIndex.db.meta.get('legacy-tomb:post-19')).toBeDefined();
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
      expect(await repair).toBe(0);
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
