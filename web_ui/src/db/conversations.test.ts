/**
 * db/conversations query semantics, against an in-memory stand-in for the
 * Dexie table (orderBy/reverse/offset/limit/filter/toArray chain). jsdom has
 * no IndexedDB and the repo carries no fake-indexeddb dependency, so this pins
 * the QUERY each function builds over a realistic 120-conversation store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from './conversations';

const store = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, reads: 0 }));

/**
 * Lazy stand-in for Dexie's Collection: like a real IndexedDB cursor it reads
 * rows one at a time (counted in store.reads), applies `until` before reading a
 * row's match, then `filter`, and stops once `limit` rows were ACCEPTED, which
 * is Dexie's documented filter-then-limit order.
 */
vi.mock('./index', () => {
  type Row = Record<string, unknown>;
  interface Plan {
    source: () => Row[];
    offset: number;
    limit: number;
    until?: (r: Row) => boolean;
    filters: Array<(r: Row) => boolean>;
  }
  const collection = (plan: Plan) => ({
    reverse: () => collection({ ...plan, source: () => [...plan.source()].reverse() }),
    offset: (n: number) => collection({ ...plan, offset: n }),
    limit: (n: number) => collection({ ...plan, limit: n }),
    until: (fn: (r: Row) => boolean) => collection({ ...plan, until: fn }),
    filter: (fn: (r: Row) => boolean) => collection({ ...plan, filters: [...plan.filters, fn] }),
    toArray: async () => {
      const out: Row[] = [];
      let skipped = 0;
      for (const row of plan.source()) {
        if (plan.until && plan.until(row)) break;
        store.reads += 1;
        if (!plan.filters.every((f) => f(row))) continue;
        if (skipped < plan.offset) {
          skipped += 1;
          continue;
        }
        out.push(row);
        if (out.length >= plan.limit) break;
      }
      return out;
    },
  });
  return {
    db: {
      conversations: {
        orderBy: (key: string) =>
          collection({
            source: () => [...store.rows].sort((a, b) => (a[key] as number) - (b[key] as number)),
            offset: 0,
            limit: Infinity,
            filters: [],
          }),
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

beforeEach(() => {
  seed(120);
  store.reads = 0;
});

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
    const small = await searchConversations('conversation', { limit: 200 });
    expect(small.matches).toHaveLength(120);
    expect(small.truncated).toBe(false);
  });

  it('no match and an empty query both return nothing', async () => {
    expect(await searchConversations('zzz-nothing')).toEqual({ matches: [], truncated: false });
    expect(await searchConversations('   ')).toEqual({ matches: [], truncated: false });
  });

  it('a broad query stops reading once it has limit + 1 matches (filter, then limit)', async () => {
    await searchConversations('conversation');
    expect(store.reads).toBe(CONVERSATION_SEARCH_LIMIT + 1);
  });

  it('a no-match query reads the whole store, once', async () => {
    await searchConversations('zzz-nothing');
    expect(store.reads).toBe(120);
  });

  it('a superseded search stops early: the cursor halts once isCancelled() turns true', async () => {
    let checks = 0;
    // Cancellation lands after 20 rows (a newer keystroke started a new search).
    const result = await searchConversations('zzz-nothing', { isCancelled: () => ++checks > 20 });
    expect(store.reads).toBe(20);
    expect(store.reads).toBeLessThan(store.rows.length);
    expect(result).toEqual({ matches: [], truncated: false });
  });

  it('an un-cancelled token does not change the result', async () => {
    const a = await searchConversations('answer number 3', { isCancelled: () => false });
    const b = await searchConversations('answer number 3');
    expect(a).toEqual(b);
  });

  it('precomposed and decomposed e-acute match each other (NFC on both sides)', async () => {
    const precomposed = 'Caf\u00e9 menu';
    const decomposed = 'Cafe\u0301 menu';
    store.rows.push(
      { id: 'pre', title: precomposed, messages: [], createdAt: 0, updatedAt: 5_000, mode: 'wllama', modelUsed: 'm' },
      { id: 'dec', title: decomposed, messages: [], createdAt: 0, updatedAt: 4_000, mode: 'wllama', modelUsed: 'm' }
    );
    expect((await searchConversations('caf\u00e9')).matches.map((c) => c.id)).toEqual(['pre', 'dec']);
    expect((await searchConversations('cafe\u0301')).matches.map((c) => c.id)).toEqual(['pre', 'dec']);
    expect(conversationMatches({ title: decomposed, messages: [] } as unknown as Conversation, 'caf\u00e9')).toBe(true);
  });

  it('conversationMatches ignores an empty needle and tolerates missing fields', () => {
    const bare = { id: 'x', title: '', messages: [] } as unknown as Conversation;
    expect(conversationMatches(bare, '')).toBe(false);
    expect(conversationMatches(bare, 'x')).toBe(false);
  });
});
