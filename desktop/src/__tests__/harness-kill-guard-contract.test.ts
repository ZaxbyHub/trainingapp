/**
 * harness-kill-guard-contract.test.ts — issue #216 AC1 (frozen check C1).
 *
 * Pins the shared checked kill wrapper (scripts/kill-guard.mjs) and its
 * adoption across the five P1 raw-taskkill sites: the wrapper's liveness
 * predicate refuses to kill an exited child, taskkill results are checked and
 * logged, and the harness files route every tree kill through it — a raw
 * taskkill spawn remains confined to the wrapper module and the
 * packaged-smoke batch's own shipped site.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killProcessTree, taskkillArgs } from '../../../scripts/kill-guard.mjs';

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

const RAW_TASKKILL = /(spawnSync|execSync|execFileSync)\(\s*['"`]taskkill['"`]/;
const P1_FILES = [
  'bench/retrieval_bench_driver.mjs',
  'desktop/scripts/run-conformance-host.mjs',
  'desktop/e2e/launch-helpers.ts',
  'desktop/e2e/launch-helpers.spec.ts',
] as const;

function readRel(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');
}

describe('harness kill-guard contract (issue #216 AC1)', () => {
  it('harness-kill-guard: the liveness predicate refuses to kill an exited child', () => {
    const calls: string[][] = [];
    const result = killProcessTree(4242, {
      isAlive: () => false,
      runTaskkill: (args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    expect(result.skipped).toBe(true);
    expect(result.status).toBeNull();
    expect(calls, 'runTaskkill must not be invoked for an exited child').toEqual([]);
  });

  it('harness-kill-guard: an invalid pid is refused without spawning taskkill', () => {
    const calls: string[][] = [];
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      const result = killProcessTree(pid as number, {
        runTaskkill: (args) => {
          calls.push(args);
          return { status: 0 };
        },
      });
      expect(result.skipped).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('harness-kill-guard: taskkill results are checked and failures are logged', () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const failed = killProcessTree(1, { isAlive: () => true, log, runTaskkill: () => ({ status: 1 }) });
    expect(failed.skipped).toBe(false);
    expect(failed.status).toBe(1);
    expect(logs.some((l) => l.includes('taskkill failed (status=1)'))).toBe(true);

    const threw = killProcessTree(1, {
      isAlive: () => true,
      log,
      runTaskkill: () => {
        throw new Error('spawn blew up');
      },
    });
    expect(threw.status).toBeNull();
    expect(threw.error?.message).toBe('spawn blew up');
    expect(logs.some((l) => l.includes('spawn blew up'))).toBe(true);

    const withError = killProcessTree(1, { isAlive: () => true, log, runTaskkill: () => ({ status: null, error: new Error('ETIMEDOUT') }) });
    expect(withError.status).toBeNull();
    expect(logs.some((l) => l.includes('ETIMEDOUT'))).toBe(true);

    const ok = killProcessTree(1, { isAlive: () => true, log, runTaskkill: () => ({ status: 0 }) });
    expect(ok).toEqual({ skipped: false, status: 0, error: null });
  });

  it('harness-kill-guard: the wrapper owns the single raw taskkill argument shape', () => {
    expect(taskkillArgs(42)).toEqual(['/PID', '42', '/T', '/F']);
    const wrapperSource = readRel('scripts/kill-guard.mjs');
    const rawSites = wrapperSource.split(/\r?\n/).filter((l) => RAW_TASKKILL.test(l));
    expect(rawSites.length, `scripts/kill-guard.mjs must hold exactly one raw taskkill site, found ${rawSites.length}`).toBe(1);
  });

  for (const rel of P1_FILES) {
    it(`harness-kill-guard: ${rel} routes kills through killProcessTree`, () => {
      const source = readRel(rel);
      expect(source.includes('killProcessTree'), `${rel} must call the shared killProcessTree wrapper`).toBe(true);
      expect(RAW_TASKKILL.test(source), `${rel} must not carry a raw taskkill invocation`).toBe(false);
    });
  }

  it('harness-kill-guard: raw taskkill sites are confined to the wrapper and packaged-smoke across the tracked harness trees', () => {
    // Census scope (plan-critic R1 finding 3; tightened at PR #220 review
    // PRR-008): git-tracked files under bench/, desktop/, web_ui/ AND scripts/
    // — never trace docs, never .worktrees/ stale copies. The wrapper itself
    // (scripts/kill-guard.mjs) and the packaged-smoke batch's shipped site are
    // the two ALLOWED raw sites; any other hit is an offender.
    const listed = execFileSync('git', ['ls-files', 'bench', 'desktop', 'web_ui', 'scripts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const allowed = ['desktop/scripts/packaged-smoke.mjs', 'scripts/kill-guard.mjs'];
    const offenders: string[] = [];
    for (const rel of listed.split(/\r?\n/)) {
      if (rel === '') continue;
      if (/\.(mjs|ts|js|cjs|mts)$/.test(rel) === false) continue;
      const source = readRel(rel);
      if (RAW_TASKKILL.test(source)) offenders.push(rel);
    }
    // This census file quotes the pattern in its regex constant — the regex
    // must not self-match (the literal text never satisfies it).
    expect(RAW_TASKKILL.test(readRel('desktop/src/__tests__/harness-kill-guard-contract.test.ts'))).toBe(false);
    expect(
      offenders.sort(),
      `raw taskkill outside the allowed sites: ${JSON.stringify(offenders)}`,
    ).toEqual(allowed.sort());
  });
});
