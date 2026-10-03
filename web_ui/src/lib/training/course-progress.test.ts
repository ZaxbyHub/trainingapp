import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceCourseProgress,
  courseProgressView,
  loadCourseProgress,
  mergeCourseProgress,
  saveCourseProgress,
} from './course-progress';
import { TRAINING_PROGRESS_KEY } from '../storage/persisted-keys';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('advanceCourseProgress', () => {
  it('moves forward only and returns the same object when nothing changes', () => {
    const start = { a: 3 };
    expect(advanceCourseProgress(start, 'a', 5)).toEqual({ a: 5 });
    expect(advanceCourseProgress(start, 'a', 3)).toBe(start);
    expect(advanceCourseProgress(start, 'a', 1)).toBe(start);
    expect(advanceCourseProgress(start, 'b', 2)).toEqual({ a: 3, b: 2 });
  });

  it('ignores invalid positions and empty course ids', () => {
    const start = {};
    expect(advanceCourseProgress(start, 'a', 0)).toBe(start);
    expect(advanceCourseProgress(start, 'a', 1.5)).toBe(start);
    expect(advanceCourseProgress(start, 'a', Number.NaN)).toBe(start);
    expect(advanceCourseProgress(start, '', 2)).toBe(start);
  });
});

describe('load/save', () => {
  it('round-trips and drops malformed entries', () => {
    saveCourseProgress({ a: 2 });
    expect(loadCourseProgress()).toEqual({ a: 2 });
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ a: 2, b: 'x', c: 0, d: 1.5, e: 4 }));
    expect(loadCourseProgress()).toEqual({ a: 2, e: 4 });
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, '[1,2]');
    expect(loadCourseProgress()).toEqual({});
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, 'nope');
    expect(loadCourseProgress()).toEqual({});
  });

  it('survives unavailable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadCourseProgress()).toEqual({});
    expect(() => saveCourseProgress({ a: 1 })).not.toThrow();
  });
});

describe('courseProgressView', () => {
  it('is null when the slide count is unknown, clamped otherwise', () => {
    expect(courseProgressView({ a: 2 }, 'a', null)).toBeNull();
    expect(courseProgressView({ a: 2 }, 'a', 0)).toBeNull();
    expect(courseProgressView({ a: 2 }, 'a', 5)).toEqual({ reached: 2, total: 5 });
    expect(courseProgressView({ a: 9 }, 'a', 5)).toEqual({ reached: 5, total: 5 });
    expect(courseProgressView({}, 'a', 5)).toEqual({ reached: 0, total: 5 });
  });
});

describe('mergeCourseProgress', () => {
  it('takes the per-course max and returns the same object when nothing is added', () => {
    const current = { a: 3, b: 5 };
    expect(mergeCourseProgress(current, { a: 4, c: 2 })).toEqual({ a: 4, b: 5, c: 2 });
    expect(mergeCourseProgress(current, { a: 3, b: 1 })).toBe(current);
    expect(mergeCourseProgress(current, {})).toBe(current);
  });
});
