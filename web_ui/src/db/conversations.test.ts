/**
 * db/conversations query semantics, against an in-memory stand-in for the
 * Dexie table (orderBy/reverse/offset/limit/filter/toArray chain). jsdom has
 * no IndexedDB and the repo carries no fake-indexeddb dependency, so this pins
 * the QUERY each function builds over a realistic 120-conversation store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from './conversations';

const store = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('./index', () => {
  type Row = Record<string, unknown>;
  const collection = (items: Row[]) => ({
    reverse: () => collection([...items].reverse()),
    offset: (n: number) => collection(items.slice(n)),
    limit: (n: number) => collection(items.slice(0, n)),
    filter: (fn: (r: Row) => boolean) => collection(items.filter(fn)),
    toArray: async () => items,
  });
  return {
    db: {
      conversations: {
        orderBy: (key: string) =>
          collection([...store.rows].sort((a, b) => (a[key] as number) - (b[key] as number))),
        count: async () => store.rows.length,
      },
    },
  };
});

import {
  CONVERSATION_SEARCH_LIMIT,
  conversationMatches,
  listConversations,
  searchConversations,
} from './conversations';

/** conv-000 is the oldest, conv-119 the newest. */
function seed(n: number): void {
  store.rows = Array.from({ length: n }, (_, i) => {
    const id = `conv-${String(i).padStart(3, '0')}`;
    const conversation: Conversation = {
      id,
      title: `Conversation ${i}`,
      messages: [
        { id: `${id}-u`, role: 'user', content: `question number ${i}`, timestamp: i },
        { id: `${id}-a`, role: 'assistant', content: `answer number ${i}`, timestamp: i },
      ],
      createdAt: i,
      updatedAt: 1_000 + i,
      mode: 'wllama',
      modelUsed: 'test',
    };
    return conversation as unknown as Record<string, unknown>;
  });
}

beforeEach(() => seed(120));

describe('listConversations (offset paging)', () => {
  it('first page is the 50 newest', async () => {
    const page = await listConversations(0, 50);
    expect(page).toHaveLength(50);
    expect(page[0].id).toBe('conv-119');
    expect(page[49].id).toBe('conv-070');
  });

  it('"Load more" with offset = number already loaded returns the NEXT 50 (not offset 50 * 50)', async () => {
    const next = await listConversations(50, 50);
    expect(next).toHaveLength(50);
    expect(next[0].id).toBe('conv-069');
    expect(next[49].id).toBe('conv-020');
    const last = await listConversations(100, 50);
    expect(last.map((c) => c.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `conv-${String(19 - i).padStart(3, '0')}`)
    );
  });
});

describe('searchConversations (all conversations, not the loaded page)', () => {
  it('finds a conversation far beyond the first page by title, case-insensitively', async () => {
    const { matches, truncated } = await searchConversations('  CONVERSATION 7  ');
    // conv-007 is the 113th newest: never in the first (or second) page.
    expect(matches.map((c) => c.id)).toEqual(['conv-079', 'conv-078', 'conv-077', 'conv-076', 'conv-075', 'conv-074', 'conv-073', 'conv-072', 'conv-071', 'conv-070', 'conv-007']);
    expect(truncated).toBe(false);
  });

  it('matches message text as well as titles', async () => {
    const { matches } = await searchConversations('answer number 3');
    expect(matches.map((c) => c.id)).toEqual(['conv-039', 'conv-038', 'conv-037', 'conv-036', 'conv-035', 'conv-034', 'conv-033', 'conv-032', 'conv-031', 'conv-030', 'conv-003']);
  });

  it('returns the newest matches up to the limit and reports truncation', async () => {
    const all = await searchConversations('conversation');
    expect(all.matches).toHaveLength(CONVERSATION_SEARCH_LIMIT);
    expect(all.matches[0].id).toBe('conv-119');
    expect(all.truncated).toBe(true);
    const small = await searchConversations('conversation', 200);
    expect(small.matches).toHaveLength(120);
    expect(small.truncated).toBe(false);
  });

  it('no match and an empty query both return nothing', async () => {
    expect(await searchConversations('zzz-nothing')).toEqual({ matches: [], truncated: false });
    expect(await searchConversations('   ')).toEqual({ matches: [], truncated: false });
  });

  it('conversationMatches ignores an empty needle and tolerates missing fields', () => {
    const bare = { id: 'x', title: '', messages: [] } as unknown as Conversation;
    expect(conversationMatches(bare, '')).toBe(false);
    expect(conversationMatches(bare, 'x')).toBe(false);
  });
});
