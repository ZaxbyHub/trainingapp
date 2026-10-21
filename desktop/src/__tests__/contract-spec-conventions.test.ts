// contract-spec-conventions.test.ts — issue #215 AC14 (batch
// batch-143-203-204-212-213-215): the contract-spec family follows the repo's
// root-resolution convention (marker walk to contracts/api.openapi.yaml with
// an explicit diagnosable failure — never a fixed-depth path.resolve, which
// silently re-points source reads when a spec moves), and the tsc-coverage
// disclosure stays honest (no tsc project compiles src/__tests__, so these
// specs are vitest-runtime-validated only — a future tsconfig change that
// silently starts or stops compiling tests is noticed here).
//
// Named mutants: revert embed-seam-contract.test.ts to a fixed-depth
// REPO_ROOT derivation -> red; change desktop/tsconfig.json's include -> red.
//
// Roster note: new contract-family members must adopt a convention-matching
// name (*-contract / -parity / -conventions / embed-seam-contract) so the
// roster net in ci-gate-required-contract.test.ts flags them until they are
// deliberately rostered or excluded.
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

/** The closed contract-family roster — imported from contract-family-registry.ts,
 * the single source of truth shared with ci-gate-required-contract and the
 * frozen roster-exclusion-evidence spec (issue #233; impl-review r1 MINOR-3:
 * importing the registry removes the local mirror so a future registry addition
 * cannot silently escape this spec's pins). */
import { FAMILY_ROSTER } from './contract-family-registry.js';

describe('contract spec conventions (issue #215 AC14)', () => {
  it('root-resolution-and-tsc-pin: the family marker-walks to the repo root and the tsc disclosure stays true', () => {
    // (a) Root resolution: any family spec that derives REPO_ROOT must probe
    // the marker (explicit failure), and no family spec may use a fixed-depth
    // path.resolve derivation. Comment-stripped with a state machine (strings
    // kept): documentation may quote the banned shape while describing it,
    // and a naive block-strip would swallow code at glob text like `main/**`.
    const stripComments = (source: string): string => {
      let out = '';
      let i = 0;
      let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'template' = 'code';
      while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (state === 'code') {
          if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
          if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
          if (c === "'" || c === '"' || c === '`') {
            state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'template';
            out += c; i += 1; continue;
          }
          out += c; i += 1; continue;
        }
        if (state === 'line') {
          if (c === '\n') { state = 'code'; out += c; }
          i += 1; continue;
        }
        if (state === 'block') {
          if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
          if (c === '\n') out += c;
          i += 1; continue;
        }
        if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
        out += c;
        if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'template' && c === '`')) {
          state = 'code';
        }
        i += 1;
      }
      return out;
    };
    for (const name of FAMILY_ROSTER) {
      const source = stripComments(fs.readFileSync(path.join(SPEC_DIR, name), 'utf8'));
      expect(
        source,
        `${name}: fixed-depth path.resolve root derivations are banned in the contract-spec family`,
      ).not.toMatch(/path\.(?:resolve|join)\(\s*[^,]+,\s*'\.\.'/);
      if (/REPO_ROOT\s*=/.test(source)) {
        expect(
          source,
          `${name}: derives REPO_ROOT but does not probe the contracts/api.openapi.yaml marker`,
        ).toContain('contracts/api.openapi.yaml');
      }
    }
    // The original offender carries the marker-walk now (named mutant: revert
    // it to the fixed-depth derivation -> the two assertions above go red on
    // this file).
    const embedSeamRaw = fs.readFileSync(path.join(SPEC_DIR, 'embed-seam-contract.test.ts'), 'utf8');
    expect(stripComments(embedSeamRaw), 'embed-seam-contract must keep the marker-walk root').toContain(
      'contracts/api.openapi.yaml',
    );

    // (b) The tsc-coverage disclosure: desktop/tsconfig.json compiles
    // main/** ONLY — no project compiles src/__tests__, so the contract specs
    // (including their cross-package packtool imports) are vitest-runtime
    // validated. Pin the fact so a future include change is noticed.
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'desktop', 'tsconfig.json'), 'utf8'),
    ) as { include?: unknown };
    expect(tsconfig.include, 'the disclosed tsc scope is exactly main/**').toEqual(['main/**/*.ts']);
    // Review PRR-024: NO desktop project may compile the test tree — the
    // preload and e2e configs could otherwise absorb src/__tests__ and make
    // the disclosure false while this row stays green.
    for (const extra of ['tsconfig.preload.json', 'tsconfig.e2e.json']) {
      const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'desktop', extra), 'utf8')) as {
        include?: unknown;
      };
      expect(
        JSON.stringify(cfg.include ?? []),
        `${extra} must not compile src/__tests__`,
      ).not.toContain('__tests__');
    }
    expect(embedSeamRaw, 'the header must carry the tsc-coverage disclosure').toMatch(
      /tsconfig\.json includes main\/\*\* only/,
    );
  });
});
