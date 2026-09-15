/**
 * Unit tests for KeywordIndex.findChunks (issue #83 D7 additive accessor).
 * findChunks is a read-only iteration over the in-memory idMapping, so these
 * tests drive it through a prototype instance with a pre-populated mapping —
 * no FlexSearch or IndexedDB needed (same spirit as keyword-index.test.ts's
 * "no complex IndexedDB async mocking" rule).
 */
import { describe, test, expect } from 'vitest';
import { KeywordIndex } from './keyword-index';

function makeIndexWithMapping(entries: Array<{ docId: string; chunkIndex: number; text: string; source?: string; page?: number }>): KeywordIndex {
  // Prototype instance: findChunks only touches idMapping.
  const idx = Object.create(KeywordIndex.prototype) as KeywordIndex;
  const mapping = new Map<string, { docId: string; chunkIndex: number; text: string; source?: string; page?: number }>();
  entries.forEach((e, i) => mapping.set(`${e.docId}:${e.chunkIndex}-${i}`, e));
  (idx as unknown as { idMapping: Map<string, unknown> }).idMapping = mapping;
  return idx;
}

describe('KeywordIndex.findChunks (issue #83)', () => {
  test('returns chunks matching the predicate as SearchResult shape', () => {
    const idx = makeIndexWithMapping([
      { docId: 'a', chunkIndex: 0, text: 'slide marker chunk', source: 'docs/slide-3-ABC123.json' },
      { docId: 'b', chunkIndex: 0, text: 'ordinary chunk' },
    ]);
    const hits = idx.findChunks((m) => m.source === 'docs/slide-3-ABC123.json');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ docId: 'a', chunkIndex: 0, source: 'docs/slide-3-ABC123.json', text: 'slide marker chunk' });
  });

  test('preserves insertion order and respects the limit', () => {
    const idx = makeIndexWithMapping([
      { docId: 'a', chunkIndex: 0, text: 'one', source: 'x.json' },
      { docId: 'b', chunkIndex: 0, text: 'two', source: 'x.json' },
      { docId: 'c', chunkIndex: 0, text: 'three', source: 'x.json' },
    ]);
    const hits = idx.findChunks((m) => m.source === 'x.json', 2);
    expect(hits.map((h) => h.docId)).toEqual(['a', 'b']);
  });

  test('returns empty for a non-matching predicate', () => {
    const idx = makeIndexWithMapping([{ docId: 'a', chunkIndex: 0, text: 'one' }]);
    expect(idx.findChunks(() => false)).toEqual([]);
  });
});
