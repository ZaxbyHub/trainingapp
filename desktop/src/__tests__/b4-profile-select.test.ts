// B4 acceptance checks (issue #62, AC2 + AC3): profile auto-selection and the
// native thread-count default. Pure unit pins for desktop/main/backend/
// inference/profile-select.ts — the implementer builds that module to EXACTLY
// these names, so this file FAILS at import (Cannot find module) until it
// exists, which is the expected RED state on the pre-fix tree.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_THRESHOLD_GB,
  defaultThreadCount,
  selectProfile,
} from '../../main/backend/inference/profile-select';

const GB = 1024 ** 3;

describe('b4-profile-select: AC2 profile auto-selection', () => {
  it('auto selects quality at EXACTLY the threshold (inclusive boundary)', () => {
    expect(selectProfile('auto', 6 * GB)).toBe('quality');
    expect(selectProfile('auto', DEFAULT_PROFILE_THRESHOLD_GB * GB, DEFAULT_PROFILE_THRESHOLD_GB)).toBe('quality');
  });

  it('auto selects quality above the threshold', () => {
    expect(selectProfile('auto', 6 * GB + 1)).toBe('quality');
    expect(selectProfile('auto', 32 * GB)).toBe('quality');
  });

  it('auto selects fast below the threshold (one byte under flips it)', () => {
    expect(selectProfile('auto', 6 * GB - 1)).toBe('fast');
    expect(selectProfile('auto', 0)).toBe('fast');
  });

  it("explicit 'quality' wins regardless of free RAM (even 0 bytes)", () => {
    expect(selectProfile('quality', 0)).toBe('quality');
    expect(selectProfile('quality', 6 * GB - 1)).toBe('quality');
  });

  it("explicit 'fast' wins regardless of free RAM (even 128 GB)", () => {
    expect(selectProfile('fast', 128 * GB)).toBe('fast');
    expect(selectProfile('fast', 6 * GB + 1)).toBe('fast');
  });

  it('a custom thresholdGb overrides the default 6 GiB boundary', () => {
    expect(selectProfile('auto', 4 * GB, 4)).toBe('quality');
    expect(selectProfile('auto', 4 * GB - 1, 4)).toBe('fast');
    expect(selectProfile('auto', 16 * GB, 16)).toBe('quality');
    expect(selectProfile('auto', 16 * GB - 1, 16)).toBe('fast');
  });

  it('DEFAULT_PROFILE_THRESHOLD_GB is 6', () => {
    expect(DEFAULT_PROFILE_THRESHOLD_GB).toBe(6);
  });
});

describe('b4-profile-select: AC3 native thread default min(cores, 8)', () => {
  it.each([
    [12, 8],
    [8, 8],
    [4, 4],
    [1, 1],
    [0, 1],
    [64, 8],
    [16, 8],
    [2, 2],
    [6, 6],
  ])('defaultThreadCount(%d) === %d', (cores, expected) => {
    expect(defaultThreadCount(cores)).toBe(expected);
  });

  it('is clamped to >= 1: never 0, never negative', () => {
    expect(defaultThreadCount(0)).toBe(1);
    expect(defaultThreadCount(-2)).toBe(1);
  });

  it('is explicitly NOT the browser min(cores, 4) cap: 8 and 12 cores stay at 8', () => {
    // The browser wllama path caps at min(cores, 4); the native desktop path
    // must not inherit that cap. 5+ cores is the discriminating range.
    expect(defaultThreadCount(8)).toBe(8);
    expect(defaultThreadCount(12)).toBe(8);
    expect(defaultThreadCount(5)).toBe(5);
    expect(defaultThreadCount(6)).not.toBe(4);
  });
});
