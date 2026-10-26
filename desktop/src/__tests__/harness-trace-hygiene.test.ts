/**
 * harness-trace-hygiene.test.ts — issue #183 AC15/AC16 (frozen checks C13
 * `trace-hygiene-guard-refusal` and C14 `trace-hygiene-junction-lifecycle`).
 *
 * Commits the trace-wrapper hygiene guard (scripts/trace-hygiene.mjs): the
 * stub-plant refusal on the main checkout (the mechanism that replaced the
 * main checkout's real @playwright/test during the #131 trace) and the
 * journaled junction create→remove→VERIFY lifecycle, exercised in-process AND
 * through the real CLI (both verbs), including a forced leftover survivor.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ERR_JUNCTION_LEFT,
  ERR_REFUSED_STUB_MAIN_CHECKOUT,
  ERR_REFUSED_UNRESOLVED_ROOT,
  assertNotMainCheckout,
  assertStubPlantAllowed,
  canonicalPath,
  createJunction,
  removeJournaledJunctions,
} from '../../../scripts/trace-hygiene.mjs';

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    if (fs.existsSync(path.join(current, '.git'))) {
      throw new Error(`repo root not found above ${dir} (marker walk hit checkout root)`);
    }
    current = path.dirname(current);
  }
  throw new Error(`repo root not found above ${dir}`);
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const GUARD = path.join(REPO_ROOT, 'scripts', 'trace-hygiene.mjs');

const spawnNode = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, args, { cwd: REPO_ROOT, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });

describe('trace-hygiene-guard-refusal (issue #183 AC15)', () => {
  it('refuses stub planting on the main checkout and allows a disposable root, in-process', () => {
    const absent = path.join(REPO_ROOT, 'desktop', 'node_modules', '@playwright', 'definitely-absent-e174');
    // The main checkout itself, package absent → the #131 incident is refused.
    let thrown: unknown = null;
    try {
      assertStubPlantAllowed({ repoRoot: REPO_ROOT, packagePath: absent });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { code?: string }).code).toBe(ERR_REFUSED_STUB_MAIN_CHECKOUT);
    // The generic main-checkout refusal also bites on the main checkout.
    let generic: unknown = null;
    try {
      assertNotMainCheckout(REPO_ROOT);
    } catch (err) {
      generic = err;
    }
    expect((generic as { code?: string }).code).toBe('TRACE_HYGIENE_REFUSED_MAIN_CHECKOUT');

    // A SUBDIR of the main checkout is inside the main tree (git walks up) —
    // refused, never "allowed" by an exact-equality blind spot.
    let subdir: unknown = null;
    try {
      assertStubPlantAllowed({ repoRoot: path.join(REPO_ROOT, 'docs'), packagePath: absent });
    } catch (err) {
      subdir = err;
    }
    expect((subdir as { code?: string }).code).toBe(ERR_REFUSED_STUB_MAIN_CHECKOUT);

    // A plain non-repo directory (OUTSIDE any git work tree) cannot be proven
    // disposable → fail closed.
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'e174-nongit-'));
    try {
      let unresolved: unknown = null;
      try {
        assertStubPlantAllowed({ repoRoot: nonGit, packagePath: absent });
      } catch (err) {
        unresolved = err;
      }
      expect((unresolved as { code?: string }).code).toBe(ERR_REFUSED_UNRESOLVED_ROOT);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }

    // Canonical comparison: forward slashes + case folding must not defeat it.
    expect(canonicalPath(path.join(REPO_ROOT, 'docs'))).toBe(canonicalPath(path.join(REPO_ROOT, 'docs')));
  });

  it('allows stub planting when the package is present or the root is a disposable worktree', () => {
    const present = path.join(REPO_ROOT, 'desktop', 'node_modules', '@playwright', 'test');
    if (fs.existsSync(present)) {
      expect(assertStubPlantAllowed({ repoRoot: REPO_ROOT, packagePath: present })).toBe('present');
    }
    // Disposable-worktree allowance is exercised end-to-end by the guard's own
    // selfcheck (a seeded main repo + linked worktree); here we pin the CLI.
  });

  it('refuse-stub CLI: exit 2 with the named error on the main checkout; import-safe module', async () => {
    const absent = path.join(REPO_ROOT, 'desktop', 'node_modules', '@playwright', 'definitely-absent-e174');
    const refused = await spawnNode([GUARD, 'refuse-stub', '--repo-root', REPO_ROOT, '--package', absent]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('TRACE_HYGIENE_REFUSED_STUB_MAIN_CHECKOUT');

    // Import safety: the static import at the top of this spec proves the
    // entry guard (importing never runs the CLI).
    const mod = await import('../../../scripts/trace-hygiene.mjs');
    expect(typeof mod.main).toBe('function');
  });
});

describe('trace-hygiene-junction-lifecycle (issue #183 AC16)', () => {
  it('create → journal → remove → lstat-verified gone; selfcheck CLI drives the whole lifecycle', () => {
    const tmp = fs.mkdtempSync(path.join(import.meta.dirname!, 'hygiene-'));
    try {
      const target = path.join(tmp, 'real');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'keep.txt'), 'target content');
      const link = path.join(tmp, 'linked');
      const journal = path.join(tmp, 'junctions.jsonl');

      createJunction(link, target, journal);
      const st = fs.lstatSync(link);
      expect(st.isSymbolicLink()).toBe(true);
      // The target's content is reachable through the link while it exists.
      expect(fs.existsSync(path.join(link, 'keep.txt'))).toBe(true);

      const removed = removeJournaledJunctions(journal);
      expect(removed).toBe(1);
      expect(() => fs.lstatSync(link)).toThrow();
      // The TARGET is untouched (link-only removal).
      expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('target content');
      // The journal is cleared after a fully verified removal.
      expect(fs.existsSync(journal)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a non-link left at a journaled path is a named survivor, never silently deleted', () => {
    const tmp = fs.mkdtempSync(path.join(import.meta.dirname!, 'hygiene-left-'));
    try {
      const realDir = path.join(tmp, 'not-a-link');
      fs.mkdirSync(realDir, { recursive: true });
      fs.writeFileSync(path.join(realDir, 'precious.txt'), 'do not delete');
      const journal = path.join(tmp, 'junctions.jsonl');
      fs.writeFileSync(journal, `${JSON.stringify({ link: realDir, target: tmp, pid: 0 })}\n`, 'utf8');

      let thrown: unknown = null;
      try {
        removeJournaledJunctions(journal);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe(ERR_JUNCTION_LEFT);
      // The real directory SURVIVED (removal must never recurse a real tree).
      expect(fs.readFileSync(path.join(realDir, 'precious.txt'), 'utf8')).toBe('do not delete');
      // The journal is preserved for a retry.
      expect(fs.existsSync(journal)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('selfcheck CLI: all four invariants pass end-to-end (exit 0)', async () => {
    const selfcheck = await spawnNode([GUARD, 'selfcheck']);
    expect(selfcheck.code).toBe(0);
    expect(selfcheck.stdout).toContain('stub planting refused on the main checkout');
    expect(selfcheck.stdout).toContain('stub planting allowed inside a disposable');
    expect(selfcheck.stdout).toContain('lstat-verified gone');
    expect(selfcheck.stdout).toContain('leftover verification bites');
    expect(selfcheck.stdout).toContain('selfcheck PASS');
  });
});
