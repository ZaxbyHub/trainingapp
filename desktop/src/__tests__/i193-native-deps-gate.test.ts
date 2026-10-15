// i193-native-deps-gate.test.ts — pins the recorded D2 skip-vs-fail policy
// for native-deps-gated suites (issue #193 AC1's executed outcome, trace
// test-batch-oct2026 Cluster A) AND the wiring that delivers it.
//
// Decision D2 (recorded on #193 before implementation): missing native deps
// FAIL under CI (silent CI skips are the silent-degrade class this batch
// exists to kill) and SKIP locally (the repo's sanctioned staged-deps skip).
// The predicate lives in ./fixtures/native-deps-gate.ts and is consumed by
// i169-stats-route-real-seed.test.ts's describeReal gate.
//
// The WIRING rows (second describe) exist because the first review round
// observed the gate unreachable: the store stack top-level-required the
// native addon, so a deps-less box died at MODULE_NOT_FOUND before any
// skip/fail decision could run. They pin (a) the lazy-require shape that
// keeps the stack import-safe and (b) the end-to-end branch behavior via a
// nested run of the gated spec with TRAININGAPP_TEST_FORCE_NATIVE_DEPS_ABSENT.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nativeDepsGate } from './fixtures/native-deps-gate.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);
const STAGING_INSTRUCTION = 'npm --prefix desktop ci';

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

describe('native-deps-gate WIRING (issue #193 AC21: the gate must be reachable)', () => {
  it('store stack is import-safe: native addons resolve lazily, never at module import', () => {
    // Named mutant: restore a top-level `const X = require('better-sqlite3')`
    // in any of these files — this row must go red. (The empirical twin is
    // the hide-deps transcript in the trace: with the addon absent the gated
    // spec loads and skips instead of dying at MODULE_NOT_FOUND.)
    const topLevelRequire = /^const\s+\w+\s*=\s*require\(['"](?:better-sqlite3|sqlite-vec)['"]\)/m;
    const lazyMarkers: Array<[string, string]> = [
      ['desktop/main/backend/store/sqlite-store.ts', 'function loadNativeAddons'],
      ['desktop/main/backend/store/recovery.ts', 'function rawDatabase'],
      ['desktop/main/backend/store/backup.ts', 'function rawDatabase'],
      ['desktop/main/backend/store/pack-manager.ts', 'function loadNativeIndexAddons'],
    ];
    for (const [rel, marker] of lazyMarkers) {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(source, `${rel} lost its lazy native loader`).toContain(marker);
      expect(source, `${rel} top-level-requires a native addon`).not.toMatch(topLevelRequire);
    }
  });

  it('wiring: forced-absent locally SKIPS the real suite with the staging instruction', () => {
    // Named mutant: make describeReal plain `describe` (drop the skip
    // wiring) — the nested real rows then run without a store and the run
    // exits nonzero, so this row must go red.
    const env = { ...process.env, TRAININGAPP_TEST_FORCE_NATIVE_DEPS_ABSENT: '1' };
    delete env.CI;
    const result = spawnSync(
      `npm --prefix desktop test -- src/__tests__/i169-stats-route-real-seed.test.ts --reporter=verbose`,
      { shell: true, cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 180_000 },
    );
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(out, out).toMatch(/SKIPPED: desktop\/node_modules\/better-sqlite3 absent/);
    expect(out, out).toContain(STAGING_INSTRUCTION);
    expect(result.status, out).toBe(0);
    // The non-native AC15 row keeps running on a deps-less box.
    expect(out, out).toMatch(/[1-9][0-9]* passed/);
    expect(out, out).toMatch(/out-of-scope-fields/);
  });

  it('wiring: forced-absent under CI FAILS loudly with the staging instruction', () => {
    // Named mutant: delete the fail-branch throw in i169's suite-scoped
    // beforeAll — the nested run then degrades to row failures without the
    // instruction, so this row must go red.
    const env = {
      ...process.env,
      TRAININGAPP_TEST_FORCE_NATIVE_DEPS_ABSENT: '1',
      CI: '1',
    };
    const result = spawnSync(
      `npm --prefix desktop test -- src/__tests__/i169-stats-route-real-seed.test.ts --reporter=verbose`,
      { shell: true, cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 180_000 },
    );
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(result.status, out).not.toBe(0);
    expect(out, out).toContain('native deps missing under CI');
    expect(out, out).toContain('fail, never silently skip');
    expect(out, out).toContain(STAGING_INSTRUCTION);
  });
});
