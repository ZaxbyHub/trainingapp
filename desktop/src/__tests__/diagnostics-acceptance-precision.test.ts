// diagnostics-acceptance-precision.test.ts — the recurrence guardrail for the
// frozen acceptance checks of trace 248-41 (issues #248 #41), review PRR-015
// (pr255): the trace's frozen drivers select their spec rows with vitest `-t`
// tokens (check-c1/c2/c3/c6 on diagnostics-logging.test.ts, check-c5 on
// web-logging.test.ts), and a vitest run whose -t filter matches NOTHING
// still exits 0 while printing "N skipped" — so a test-title rename would
// zero every frozen check with CI green. THIS spec is the committed re-driver
// that keeps those filter contracts honest: every frozen (spec, token) pair
// is re-executed here and must select at least one EXECUTED-PASS test.
//
// Pattern: the trace 201-207-208-209-210 guardrail
// (acceptance-battery-precision.test.ts, rostered by review PRR-008) — same
// nested-vitest idiom, relaxed from its exact row counts to the >=1
// selection floor the PRR-015 fix names: diagnostics-logging.test.ts is the
// other streams' actively-extended landing target, so an exact count would
// fight every legitimate addition; the zero-match rename is what must die.
//
// The WEB row (web-logging.test.ts -t redaction) is deliberately NOT a
// nested run: the required `security` job stages only the DESKTOP deps
// (web_ui/node_modules is absent there), and browser-suite launches do not
// belong in a desktop vitest spec (the same battery file's C5..C8 carve-out).
// Its committed re-driver is a static source scan of the spec's own titles —
// vitest -t matches the full name (describe chain + title), the 'redaction'
// token lives in the describe title, and a rename that drops it is exactly
// the zero-match failure this row must catch.
//
// Lifecycle: GREEN at introduction by construction (the tokens select their
// groups today); RED the moment a title rename orphans a frozen check.
//
// CI home: FAMILY_ROSTER (required `security` job) — the PRR-008 (pr242)
// precedent for acceptance surfaces with no other merge-blocking home.
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
 * Run a nested vitest command with the battery's hygiene (the i193
 * PRR-016/052 idiom): ASYNC spawn (a synchronous spawnSync starves the outer
 * worker's event loop) and a real process-TREE kill on timeout — Windows
 * taskkill /T /F walks a live tree; POSIX needs a DETACHED child (its own
 * process group) so process.kill(-pid) reaches the npm->node->vitest
 * descendants that would otherwise hold the stdio pipes open.
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
        spawnSync(`taskkill /T /F /PID ${child.pid}`, { shell: true, encoding: 'utf8' });
        return;
      }
      try {
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
 * The frozen -t tokens of the trace's desktop acceptance checks, mirrored
 * from repro/check-c1.sh, check-c2.sh, check-c3.sh and check-c6.sh — changing
 * a title without updating the frozen driver (or this BATTERY) turns this
 * spec red instead of silently zeroing the check.
 */
const BATTERY: ReadonlyArray<readonly [string, string]> = [
  ['src/__tests__/diagnostics-logging.test.ts', 'default-file-logging'],
  ['src/__tests__/diagnostics-logging.test.ts', 'enhanced-level'],
  ['src/__tests__/diagnostics-logging.test.ts', 'export-bundle'],
  ['src/__tests__/diagnostics-logging.test.ts', 'capture-handlers'],
];

// The web row's landing target (repro/check-c5.sh) and its frozen token.
const WEB_SPEC = path.join(REPO_ROOT, 'web_ui', 'src', 'lib', 'logging', '__tests__', 'web-logging.test.ts');
const WEB_TOKEN = 'redaction';

describe('diagnostics acceptance precision (trace 248-41 frozen -t tokens)', () => {
  for (const [spec, token] of BATTERY) {
    it(`battery-precision: -t ${token} executes at least one test in ${spec.split('/').pop()}`, async () => {
      const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
      const result = await runNestedVitest(
        `npm --prefix desktop test -- ${spec} -t ${token}`,
        env,
        180_000,
      );
      // The vitest summary is the ONLY trusted signal (the -t filter name is
      // echoed on the npm command line, so its presence proves nothing).
      const m = result.out.match(/Tests +([0-9]+) passed/);
      expect(
        m,
        `no "Tests N passed" summary for -t ${token} (exit ${result.status}):\n${result.out.slice(-500)}`,
      ).not.toBeNull();
      // The selection floor: a renamed title zeroes the executed-pass count
      // while vitest still exits 0 — exactly the silent failure class this
      // row exists to kill (PRR-015).
      expect(
        Number(m?.[1]),
        `-t ${token} selects no executed test in ${spec} — a title rename has orphaned the frozen acceptance check`,
      ).toBeGreaterThan(0);
      expect(result.status, `nested run exited nonzero for -t ${token}:\n${result.out.slice(-500)}`).toBe(0);
    }, 200_000);
  }

  it(`battery-precision: -t ${WEB_TOKEN} names at least one test title in web-logging.test.ts (static scan)`, () => {
    const source = fs.readFileSync(WEB_SPEC, 'utf8');
    // vitest -t matches the FULL test name (describe chain + title), so the
    // token may live in either a describe or an it/test title.
    const titles = source.match(/(?:describe|it|test)\(\s*['"][^'"]*redaction[^'"]*['"]/g) ?? [];
    expect(
      titles.length,
      `-t ${WEB_TOKEN} matches no test title in web-logging.test.ts — a title rename has orphaned the frozen acceptance check (check-c5)`,
    ).toBeGreaterThan(0);
  });
});
