/**
 * Browser learn-kernel unit tests (issue #82, D6) — mirrors of
 * tests/test_learn_kernel.py's golden cases (union/dedup/rank, cap,
 * grounding guard, marker parsing). Keep both in sync.
 */
import { describe, test, expect } from 'vitest';
import { buildLearnResults, slideIdFromName, MAX_LEARN_RESULTS } from '../learn-kernel';
import type { SearchResult } from '../../../types/search';

const MARKER = '[training-slide] section=Course Introduction | title=Welcome | slide_id=5rN4PvXJM5d';

const chunk = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  docId: 'd0',
  chunkIndex: 0,
  score: 0.5,
  text: 'plain text',
  source: 'doc.md',
  ...overrides,
});

describe('learn kernel (browser mirror)', () => {
  test('slideIdFromName matches the slide filename convention', () => {
    expect(slideIdFromName('/x/docs/slide-001-5rN4PvXJM5d.json')).toBe('5rN4PvXJM5d');
    expect(slideIdFromName('slide-12-abc.json')).toBe('abc');
    expect(slideIdFromName('handbook.md')).toBeNull();
    expect(slideIdFromName(undefined)).toBeNull();
  });

  test('direct hit parses title/section from the marker and keeps the snippet', () => {
    const learn = buildLearnResults([
      chunk({
        source: 'slide-001-5rN4PvXJM5d.json',
        score: 0.91,
        text: `${MARKER}\nStart\nOpMed CDP MicroLearning Companion`,
      }),
    ]);
    expect(learn).toHaveLength(1);
    expect(learn[0]).toMatchObject({
      slide_id: '5rN4PvXJM5d',
      title: 'Welcome',
      section: 'Course Introduction',
      reason: 'direct',
      score: 0.91,
    });
    expect(learn[0].snippet?.startsWith('Start')).toBe(true);
  });

  test('ranked descending, capped at MAX_LEARN_RESULTS', () => {
    const chunks = Array.from({ length: 8 }, (_, i) =>
      chunk({ source: `slide-${String(i + 1).padStart(3, '0')}-slide${i}.json`, score: 0.9 - i * 0.01 }),
    );
    const learn = buildLearnResults(chunks);
    expect(learn).toHaveLength(MAX_LEARN_RESULTS);
    const scores = learn.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  test('non-slide chunks yield an empty array', () => {
    expect(buildLearnResults([chunk({ source: 'handbook.md', score: 0.9 })])).toEqual([]);
    expect(buildLearnResults([])).toEqual([]);
  });

  test('grounding general suppresses every result', () => {
    const learn = buildLearnResults(
      [chunk({ source: 'slide-001-5rN4PvXJM5d.json', score: 0.95, text: `${MARKER}\nbody` })],
      { grounding: 'general' },
    );
    expect(learn).toEqual([]);
  });

  test('grounded grounding keeps results', () => {
    const learn = buildLearnResults(
      [chunk({ source: 'slide-001-5rN4PvXJM5d.json', score: 0.95, text: `${MARKER}\nbody` })],
      { grounding: 'grounded' },
    );
    expect(learn).toHaveLength(1);
  });
});
