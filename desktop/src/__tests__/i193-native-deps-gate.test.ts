// i193-native-deps-gate.test.ts — pins the recorded D2 skip-vs-fail policy
// for native-deps-gated suites (issue #193 AC1's executed outcome, trace
// test-batch-oct2026 Cluster A).
//
// Decision D2 (recorded on #193 before implementation): missing native deps
// FAIL under CI (silent CI skips are the silent-degrade class this batch
// exists to kill) and SKIP locally (the repo's sanctioned staged-deps skip).
// The predicate lives in ./fixtures/native-deps-gate.ts and is consumed by
// i169-stats-route-real-seed.test.ts's describeReal gate.
import { describe, expect, it } from 'vitest';
import { nativeDepsGate } from './fixtures/native-deps-gate.js';

describe('native-deps-gate policy (issue #193 D2: CI fails, local skips)', () => {
  it('deps present -> run, regardless of CI', () => {
    expect(nativeDepsGate({ ci: false, nativeDepsPresent: true })).toBe('run');
    expect(nativeDepsGate({ ci: true, nativeDepsPresent: true })).toBe('run');
  });

  it('deps missing under CI -> fail (never a silent skip)', () => {
    // The AC21 named mutant inverts this branch (fail -> skip); this row is
    // what must go red.
    expect(nativeDepsGate({ ci: true, nativeDepsPresent: false })).toBe('fail');
    expect(nativeDepsGate({ ci: true, nativeDepsPresent: false })).not.toBe('skip');
  });

  it('deps missing locally -> skip (the sanctioned staged-deps skip)', () => {
    expect(nativeDepsGate({ ci: false, nativeDepsPresent: false })).toBe('skip');
  });
});
