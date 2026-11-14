/**
 * Token-guard oracle fixture-source pin (issue #271 AC6).
 *
 * Asserts the tokenguard oracle reads its WordPiece vocabulary from a
 * GIT-TRACKED fixture (not the operator-staged model directory), and that at
 * most the oracle self-check leg is skip-gated. Node environment; assumes a
 * git checkout is present (true on CI and any dev checkout).
 *
 * @vitest-environment node
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_UI_ROOT = resolve(HERE, '..', '..', '..');
const REPO_ROOT = resolve(WEB_UI_ROOT, '..');
const SPEC_PATH = join(HERE, 'text-chunker.tokenguard.test.ts');
/** The git-tracked fixture the oracle must consume. */
const TRACKED_FIXTURE = 'models/bge-small-en-v1.5/tokenizer.json';

describe('tokenguard oracle reads a git-tracked fixture (issue #271 AC6)', () => {
  const specText = readFileSync(SPEC_PATH, 'utf-8');

  test('the fixture exists in the tree', () => {
    expect(existsSync(join(REPO_ROOT, TRACKED_FIXTURE))).toBe(true);
  });

  test('the fixture is git-tracked (git ls-files --error-unmatch succeeds)', () => {
    // Preconditions asserted explicitly (Copilot PR #349 review): this spec
    // assumes a git checkout; a source archive without .git fails HERE with
    // a named reason instead of an opaque execFileSync throw.
    expect(existsSync(join(REPO_ROOT, '.git')), 'a git checkout is present (.git directory)').toBe(true);
    let gitOk = true;
    try {
      execFileSync('git', ['--version'], { stdio: 'pipe' });
    } catch {
      gitOk = false;
    }
    expect(gitOk, 'the git CLI is available on PATH (required to verify tracking)').toBe(true);
    execFileSync('git', ['ls-files', '--error-unmatch', TRACKED_FIXTURE], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  });

  test('the oracle actually consumes the tracked fixture (the spec resolves its tokenizer dir to it)', () => {
    // Bind the guard to the loader the oracle runs: extract the MODEL_DIR
    // resolution from text-chunker.tokenguard.test.ts and assert it names the
    // tracked fixture path segments.
    const modelDirMatch = specText.match(/const MODEL_DIR = path\.resolve\(([\s\S]*?)\);/);
    expect(modelDirMatch, 'MODEL_DIR resolution present in the tokenguard spec').not.toBeNull();
    const segments = modelDirMatch![1];
    for (const seg of ['..', 'models', 'bge-small-en-v1.5']) {
      expect(segments).toContain(`'${seg}'`);
    }
    expect(segments).not.toContain('snowflake-arctic-embed-m-v1.5');
    expect(specText).not.toContain("'public', 'models'");
  });

  test('at most one skipIf remains (any vitest API) and it is the identified oracle self-check', () => {
    // Comment-aware scan: blank comment interiors offset-preserving before
    // counting, so prose mentions (docs lines) do not count. Issue #349
    // review F-003: the pin must reject skipIf gating reintroduced through
    // BOTH the it and describe/test APIs — a bare \bskipIf\b scan covers
    // it.skipIf, describe.skipIf and test.skipIf (and an alias binding still
    // contains the token); the banned runIf/.skip( forms stay.
    const stripped = stripComments(specText);
    const skipIfs = [...stripped.matchAll(/\bskipIf\b/g)];
    expect(
      skipIfs.length,
      'exactly one skipIf (the self-check; describe.skipIf/test.skipIf/alias forms all contain the token)',
    ).toBeLessThanOrEqual(1);
    expect(stripped).not.toMatch(/\brunIf\b/);
    expect(stripped).not.toMatch(/\.skip\(/);
    if (skipIfs.length === 1) {
      // The single gate guards the SELF-CHECK: the condition is the
      // tokenizer-null form and the test name names the oracle self-check.
      const gateStart = skipIfs[0].index ?? 0;
      const window = stripped.slice(gateStart, gateStart + 400);
      expect(window).toContain('TOKENIZER_MODEL === null');
      expect(window).toContain('oracle self-check');
    }
  });
});

/** Blank comment interiors offset-preserving: block comments first (the spec's
 * JSDoc header mentions skip semantics), then `//` line comments. The spec
 * under scan contains no '//' URL literals (verified by the positive control
 * below in the original design; a template-literal URL would need the full
 * dead-doc classifier, out of scope for a single-file scan). */
function stripComments(text: string): string {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  const lines = noBlocks.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx >= 0 ? line.slice(0, idx).padEnd(line.length) : line;
  });
  return lines.join('\n');
}
