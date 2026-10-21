// frozen-recipe-replay-contract.test.ts — the acceptance-check recipes
// published for issues #199/#229 must replay against the SHIPPED specs.
// Each recipe is either a `vitest -t` filter run or a full-file run.
// Because `vitest -t` is a SUBSTRING match over test titles and vitest
// exits 0 when the filter matches zero tests, a drifted filter replays
// NOTHING and still reports success — the exact defect shipped with the
// original #199 recipe (the hyphenated filter `stop-detaches` matched zero
// titles of a spec whose titles say `stop detaches`). This spec pins every
// recipe against the spec SOURCE: each -t filter must be a substring of at
// least one test title the target file actually declares, and every
// full-file target must declare at least one test — the >= 1 requirement is
// load-bearing precisely because vitest exits 0 on a zero-match -t run.
//
// The canonical published recipes live in issues #199/#229; the registry
// below is their in-repo executable form, deliberately inline and frozen
// with this spec so the replay evidence cannot drift from its pin.
//
// Named mutants: (a) re-hyphenate the #199 filter (the historical defect)
// -> Test A red, and Test C proves the shared validator catches it; (b)
// rename a test title in a shipped spec so a filter loses its match ->
// Test A red; (c) strip every it() out of a full-file target -> Test B red.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    // Review PRR-024/UCR-04: stop at the checkout root — a marker-less
    // checkout must fail closed, never bind a foreign ancestor's marker.
    if (fs.existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const SPEC_DIR = path.join(REPO_ROOT, 'desktop', 'src', '__tests__');

const ISSUE_RECIPES = [
  {
    issue: 199,
    spec: 'i199-backend-surface-lifecycle.test.ts',
    filters: ['stop detaches', 'null-deref'],
  },
  { issue: 229, spec: 'reranker-generation-lifecycle.test.ts', filters: [] as string[], fullFile: true },
  { issue: 229, spec: 'backend-memory-tick-lifecycle.test.ts', filters: [] as string[], fullFile: true },
  {
    issue: 229,
    spec: 'backend-env-repo-root-contract.test.ts',
    filters: [] as string[],
    fullFile: true,
  },
] as const;

/**
 * Extract the declared test titles from a spec's SOURCE text: the quoted
 * first argument of every `test(`/`it(` call. The family's multiline it()
 * style puts the title on the line after the callee, so the pattern spans
 * whitespace including newlines; the leading \b keeps `split(`/`fit(` and
 * friends out, and requiring the quote right after the paren keeps plain
 * calls like `convention.test(base)` out.
 */
function extractTestTitles(source: string): string[] {
  const titles: string[] = [];
  const titleCall = /\b(?:test|it)\s*\(\s*(['"])([^'"]*)\1/g;
  // Group 2 always participates when the whole pattern matches, so the
  // fallback only appeases noUncheckedIndexedAccess — it never fires.
  for (const match of source.matchAll(titleCall)) titles.push(match[2] ?? '');
  return titles;
}

/**
 * The replay validator (single source of logic for Tests A and C): a -t
 * filter that matches zero declared titles is a silent no-op replay —
 * `vitest -t` is a substring match and vitest exits 0 on zero matches — so
 * it is flagged as a violation instead of trusted.
 */
function filterViolation(issue: number, spec: string, filter: string, titles: readonly string[]): string | null {
  if (titles.some((title) => title.includes(filter))) return null;
  return (
    `issue #${issue} recipe for ${spec}: -t filter ${JSON.stringify(filter)} matches zero declared ` +
    'test titles (vitest -t is a substring match and exits 0 on zero matches — the replay would run nothing)'
  );
}

describe('frozen acceptance-check recipe replay contract', () => {
  it('every frozen -t filter matches at least one shipped test title', () => {
    for (const recipe of ISSUE_RECIPES) {
      const specPath = path.join(SPEC_DIR, recipe.spec);
      expect(fs.existsSync(specPath), `issue #${recipe.issue}: recipe target ${recipe.spec} must exist`).toBe(
        true,
      );
      const titles = extractTestTitles(fs.readFileSync(specPath, 'utf8'));
      for (const filter of recipe.filters) {
        expect(
          filterViolation(recipe.issue, recipe.spec, filter, titles),
          `issue #${recipe.issue}: recipe filter ${JSON.stringify(filter)} for ${recipe.spec}`,
        ).toBeNull();
      }
    }
  });

  it('every full-file recipe targets a spec with at least one test', () => {
    for (const recipe of ISSUE_RECIPES) {
      if (!('fullFile' in recipe) || !recipe.fullFile) continue;
      const specPath = path.join(SPEC_DIR, recipe.spec);
      expect(
        fs.existsSync(specPath),
        `issue #${recipe.issue}: full-file target ${recipe.spec} must exist`,
      ).toBe(true);
      const titleCount = extractTestTitles(fs.readFileSync(specPath, 'utf8')).length;
      expect(
        titleCount,
        `issue #${recipe.issue}: full-file recipe ${recipe.spec} must target a spec declaring at least one test`,
      ).toBeGreaterThan(0);
    }
  });

  it('the replay validator catches the shipped hyphenated defect (self-asserting negative)', () => {
    // The ORIGINAL #199 defect: the hyphenated filter. It matches zero
    // titles of the shipped spec (whose real titles say `stop detaches`),
    // and the shared validator must flag exactly that — proof that the
    // historical silent no-op replay is detectable by Test A's logic.
    const titles = extractTestTitles(
      fs.readFileSync(path.join(SPEC_DIR, 'i199-backend-surface-lifecycle.test.ts'), 'utf8'),
    );
    expect(titles.length, 'the negative control needs the i199 spec to declare titles').toBeGreaterThan(0);
    expect(
      titles.filter((title) => title.includes('stop-detaches')),
      'the hyphenated defect filter must match zero shipped titles',
    ).toEqual([]);
    const violation = filterViolation(
      199,
      'i199-backend-surface-lifecycle.test.ts',
      'stop-detaches',
      titles,
    );
    expect(violation, 'the validator must flag the zero-match hyphenated filter').not.toBeNull();
    expect(violation, 'the violation must name the defect filter').toContain('stop-detaches');
  });
});
