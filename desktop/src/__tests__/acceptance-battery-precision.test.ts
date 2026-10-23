// acceptance-battery-precision.test.ts — the recurrence guardrail for the
// trace 201-207-208-209-210 collated batch (issues #201 #207 #208 #209 #210).
//
// Defect class (04-root-cause): assertions that cannot fail - among them the
// runner zero-match trap (vitest -t matching nothing still exits 0 and prints
// "N skipped"). The batch's 13 frozen checks are themselves the regression
// pins; THIS spec is the meta-guard that keeps their filter contracts
// honest inside the committed suite: every (spec-file, -t token, row-count)
// triple of the batch is re-executed here, and any drift - a renamed or
// deleted row, a token that stops selecting, or a token that starts
// selecting MORE rows than the frozen contract - fails CI.
//
// The playwright -g half of the batch (C5..C8) is deliberately NOT re-driven
// here (browser launches do not belong in a desktop vitest spec): those rows
// run in the required web-ui e2e job by file path (test:visual:a11y:ci for
// lumen-axe-below-fold, the e2e project for isolation-browser), so their
// executed-pass contract is CI-enforced already.
//
// Lifecycle: RED at base (this file did not exist at 035fffab; the batch's
// rows were absent too - every nested run below would print 0 passed and the
// row goes red), GREEN after the fix (proven by the batch replay).
//
// CI home: FAMILY_ROSTER (required `security` job) alongside the batch's
// logline spec - the PRR-008 (pr242) precedent for acceptance surfaces with
// no other merge-blocking home.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Run a nested vitest command with the batch's own hygiene (the i193
 * PRR-016/052 idiom): explicit hard timeout + a real process-TREE kill on
 * timeout, because the shell wrapper's descendants would otherwise survive
 * and hold sqlite handles / ports.
 *
 * ASYNC by contract (implementation-round lesson): a synchronous 300s
 * spawnSync starves the vitest worker event loop and its pool RPC heartbeat
 * ('Timeout calling onTaskUpdate' unhandled error under the full parallel
 * run). spawn + awaited close keeps the loop alive.
 *
 * The tree kill is PER PLATFORM and both arms really kill a tree - the
 * previous claim that it "stays identical (taskkill /T /F on timeout)" was
 * false on POSIX, which is the platform this spec's required CI job runs on:
 *   - Windows: taskkill /T /F /PID <live child> (the /T flag walks the tree).
 *   - POSIX:   the child is spawned DETACHED, so it leads its own process
 *     group; process.kill(-pid, 'SIGKILL') takes the whole group. A
 *     per-process SIGKILL only reaches the shell wrapper, leaving the
 *     npm -> node -> vitest descendants alive (they keep the stdio pipes
 *     open, which defers 'close' and turns the intended bounded kill into a
 *     generic vitest timeout).
 */
function runNestedVitest(
  command: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: REPO_ROOT, // npm --prefix needs the REPO root, not vitest's desktop/ cwd
      env,
      // POSIX only: a detached child becomes its own process-group leader,
      // which is what makes the group kill below reach the descendants.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    const killer = setTimeout(() => {
      if (typeof child.pid !== 'number') return;
      if (process.platform === 'win32') {
        // The child is still alive here (the async spawn does not kill it),
        // so taskkill /T /F walks a LIVE tree.
        spawnSync(`taskkill /T /F /PID ${child.pid}`, { shell: true, encoding: 'utf8' });
        return;
      }
      try {
        // Kill the whole process GROUP: the detached child is its leader.
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(killer);
      resolve({
        status,
        out: `${stdout}\n${stderr}`.replace(ANSI_RE, ''),
      });
    });
  });
}
/**
 * The frozen (spec, token, rows) triples of the batch. These values mirror
 * the EXPECT_ROWS constants of the trace's frozen drivers (repro/check-c1.sh
 * .. check-c13.sh) - changing one without the other turns either this spec
 * or the acceptance replay red.
 */
const BATTERY: ReadonlyArray<readonly [string, string, number]> = [
  ['src/__tests__/logline-contract-sweep.test.ts', 'index-degrade-lines', 6],
  ['src/__tests__/logline-contract-sweep.test.ts', 'index-sidecar-lines', 2],
  ['src/__tests__/logline-contract-sweep.test.ts', 'pack-manager-lines', 4],
  ['src/__tests__/logline-contract-sweep.test.ts', 'comment-contracts', 5],
  ['src/__tests__/fixtures/document-surface-fake.test.ts', 'mutating-methods', 5],
  ['src/__tests__/i185-stub-getstats-mixed-state.test.ts', 'route-500', 2],
  ['src/__tests__/i169-stats-route-real-seed.test.ts', 'chunk-oracle', 2],
  ['src/__tests__/i169-stats-route-real-seed.test.ts', 'auth-negative', 2],
  ['src/__tests__/i193-native-deps-gate.test.ts', 'hygiene', 6],
];

describe('acceptance battery precision (trace 201-207-208-209-210 guardrail)', () => {
  for (const [spec, token, rows] of BATTERY) {
    it(`battery-precision: -t ${token} executes exactly ${rows} rows in ${spec.split('/').pop()}`, async (ctx) => {
      const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
      delete env.CI; // local semantics: the D2-gated rows may skip, the
      // executed-pass count guard still demands the token rows run for real
      // under the ambient desktop dev box (better-sqlite3 present).
      const result = await runNestedVitest(
        `npm --prefix desktop test -- ${spec} -t ${token}`,
        env,
        300_000,
      );
      // The vitest summary is the ONLY trusted signal (the -t filter name is
      // echoed on the npm command line, so its presence proves nothing).
      const m = result.out.match(/Tests +([0-9]+) passed/);
      // ANY skipped row means the EXACT count cannot be verified here: the D2
      // contract (issue #193) skips the native-deps-gated rows when the addon
      // is absent (locally) and fails them under CI. This meta-guard demands
      // an executed-pass count, so the honest outcome on a box without the
      // staged deps is a SKIP - not a red that blames the code under test -
      // while CI (where the deps MUST be staged) gets a loud failure instead
      // of a silent hole in the guardrail.
      if (/\b[0-9]+ skipped\b/.test(result.out)) {
        if (process.env.CI) {
          expect.fail(
            `the nested run skipped rows for -t ${token} UNDER CI - the native deps must be ` +
              `staged there (D2: CI fails, never silently skips):\n${result.out.slice(-500)}`,
          );
        }
        ctx.skip();
      }
      expect(m, `no "Tests N passed" summary for -t ${token} (exit ${result.status}):\n${result.out.slice(-500)}`).not.toBeNull();
      expect(Number(m?.[1]), `executed-pass count for -t ${token} in ${spec}`).toBe(rows);
      expect(result.status, `nested run exited nonzero for -t ${token}:\n${result.out.slice(-500)}`).toBe(0);
    }, 320_000);
  }
});
