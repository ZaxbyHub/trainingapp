/**
 * slide-position (Lumen phase 6): "slide x of n" and the course-card slide count
 * come only from the course's ingested `docs/slide-<n>-<slideId>.json` docs.
 * The mock applies the module's REAL predicate to a fake chunk mapping, so the
 * course scoping (packId), the one-hit-per-doc rule (chunkIndex 0) and the path
 * parsing are all exercised.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

type Meta = { docId: string; chunkIndex: number; text: string; source?: string; packId?: string };

const metas: Meta[] = [];
const mockKeywordIndex = {
  isReady: vi.fn(() => true),
  findChunks: vi.fn((predicate: (m: Meta) => boolean, limit = 10) =>
    metas.filter(predicate).slice(0, limit).map((m) => ({ ...m, score: 1 }))
  ),
};

vi.mock('../search/keyword-index', () => ({ getKeywordIndex: vi.fn(() => mockKeywordIndex) }));

import { courseSlideCount, slidePosition } from './slide-position';

function slideDoc(packId: string, n: number, slideId: string, chunkIndex = 0): Meta {
  return { docId: `${packId}:${n}`, chunkIndex, text: 't', source: `docs/slide-${String(n).padStart(3, '0')}-${slideId}.json`, packId };
}

describe('slide-position', () => {
  beforeEach(() => {
    metas.length = 0;
    mockKeywordIndex.isReady.mockReturnValue(true);
    // 12 slides in course-a (more than findChunks' default limit of 10), each doc
    // chunked twice, plus another course and a plain document in the same index.
    for (let n = 1; n <= 12; n += 1) {
      metas.push(slideDoc('course-a', n, `A${n}`), slideDoc('course-a', n, `A${n}`, 1));
    }
    metas.push(slideDoc('course-b', 1, 'B1'), slideDoc('course-b', 2, 'B2'));
    metas.push({ docId: 'handbook', chunkIndex: 0, text: 't', source: 'Employee-Handbook.pdf' });
  });

  test('positions a slide within its own course (past the default result cap)', () => {
    expect(slidePosition('course-a', 'A3')).toEqual({ index: 3, total: 12 });
    expect(slidePosition('course-a', 'A12')).toEqual({ index: 12, total: 12 });
    expect(slidePosition('course-b', 'B2')).toEqual({ index: 2, total: 2 });
  });

  test('counts slides per course, one per slide doc', () => {
    expect(courseSlideCount('course-a')).toBe(12);
    expect(courseSlideCount('course-b')).toBe(2);
  });

  test('degrades to null instead of guessing', () => {
    expect(slidePosition('course-a', 'B1')).toBeNull(); // another course's slide
    expect(slidePosition('course-a', '')).toBeNull();
    expect(courseSlideCount('unknown-course')).toBeNull();
    mockKeywordIndex.isReady.mockReturnValue(false); // e.g. the desktop renderer
    expect(slidePosition('course-a', 'A3')).toBeNull();
    expect(courseSlideCount('course-a')).toBeNull();
  });
});
