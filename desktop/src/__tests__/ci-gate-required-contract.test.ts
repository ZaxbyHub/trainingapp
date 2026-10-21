// ci-gate-required-contract.test.ts — issue #215 AC13 (batch
// batch-143-203-204-212-213-215): a failing contract spec must fail a REQUIRED
// check so the merge is blocked. The contract-family step lives in the
// `security` job (an already-required, unbucketed context that reports on
// every PR), so the wiring is merge-blocking with no settings change.
//
// `required-wiring` pins the load-bearing facts so a future edit cannot
// silently reintroduce the fail-open hole: the README required-checks list
// names `security`; the security job runs the CLOSED contract-family roster
// (detected structurally by naming convention, with explicit exclusions in
// the outbound-guardrail allowlist pattern); the trigger carries no paths
// filters; the job has no if:/needs: gate; the contract step is unconditional
// and not continue-on-error.
//
// Named mutants: (a) remove the contract-family step from security.yml;
// (b) narrow its selection below the roster; (c) add continue-on-error (or an
// if: skip) to the contract step — each must kill this row. A future contract
// spec named outside the convention is a naming-discipline error (documented
// in contract-spec-conventions.test.ts); one named inside the convention but
// missing from the roster is flagged here.
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
const SECURITY_YML = path.join(REPO_ROOT, '.github', 'workflows', 'security.yml');
const WORKFLOWS_README = path.join(REPO_ROOT, '.github', 'workflows', 'README.md');

/** The closed contract-family roster — the files the required step runs. */
const FAMILY_ROSTER = [
  'embed-seam-contract.test.ts',
  'embed-threads-clamp-contract.test.ts',
  'embed-constants-parity.test.ts',
  'pack-twin-parity.test.ts',
  'ci-gate-required-contract.test.ts',
  'contract-spec-conventions.test.ts',
];

/**
 * Explicit convention-match exclusions (outbound-guardrail allowlist
 * pattern): pre-existing specs whose suffix matches the family convention but
 * which are NOT this contract family. Post-fix the convention matches 16
 * files = 6 roster + 10 exclusions.
 */
const ROSTER_EXCLUSIONS = new Map<string, string>([
  ['acceptance-precision-contract.test.ts', 'pin-record guard owned by harness-contracts.yml'],
  ['packaged-smoke-contract.test.ts', 'needs a packaged dist (desktop-build smoke)'],
  ['harness-kill-guard-contract.test.ts', 'harness-contracts.yml owns this pin'],
  ['harness-parse-contract.test.ts', 'harness-contracts.yml owns this pin'],
  ['e1-manifest-contract.test.ts', 'desktop-build-owned pin (installer fixtures)'],
  ['b9-contract-route-parity.test.ts', 'desktop-build-owned pin (route fixtures)'],
  ['browser-pack-extract-parity.test.ts', 'desktop-build-owned pin (browser twin)'],
  [
    'i230-resolver-env-parity.test.ts',
    'issue-tracer acceptance check for issue #232 residual (b) — owned by the desktop vitest suite, not the cross-cutting contract family',
  ],
  ['c3-pack-parity.test.ts', 'desktop-build-owned pin (pack fixtures)'],
  [
    'backend-env-repo-root-contract.test.ts',
    'issue-tracer acceptance check for issue #229 (c) — owned by the desktop vitest suite, not the cross-cutting contract family',
  ],
]);

describe('ci gate required wiring (issue #215 AC13)', () => {
  it('required-wiring: the contract family runs in a required, always-reporting context', () => {
    // YAML comments stripped before any step-locating scan (critic round-1):
    // commenting a step out keeps every string in the raw text, so a raw
    // indexOf is satisfied by the comment. `#` only opens a comment at line
    // start or after whitespace, never inside quotes.
    const stripYamlComments = (text: string): string => {
      let out = '';
      for (const line of text.split('\n')) {
        let inSingle = false;
        let inDouble = false;
        let cut = line.length;
        for (let i = 0; i < line.length; i += 1) {
          const ch = line[i];
          if (ch === "'" && !inDouble) inSingle = !inSingle;
          else if (ch === '"' && !inSingle && line[i - 1] !== '\\') inDouble = !inDouble;
          else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
            cut = i;
            break;
          }
        }
        out += `${line.slice(0, cut)}\n`;
      }
      return out;
    };
    const security = stripYamlComments(fs.readFileSync(SECURITY_YML, 'utf8'));
    // The workflows README checks in with CRLF line endings; normalize so the
    // fence and `$`-anchored multiline regexes below are checkout-format
    // independent.
    const readme = fs.readFileSync(WORKFLOWS_README, 'utf8').replace(/\r\n/g, '\n');

    // (1) The `security` job name is a declared required context — asserted
    // against the FENCED required-checks list specifically: the prose below
    // the list also names `security` and would satisfy an unanchored scan
    // (review PRR-002).
    const requiredList = /## Required checks[\s\S]*?```text\n([\s\S]*?)```/.exec(readme);
    expect(requiredList, 'README must keep the fenced required-checks list').not.toBeNull();
    expect(
      requiredList?.[1] ?? '',
      'the required-checks list must name the security context',
    ).toMatch(/^security$/m);

    // (2) The contract-family step runs in the security job and its RUN
    // SCALAR covers the closed roster (a future roster file must be added to
    // the run line). Assertions are scoped to the run scalar on purpose:
    // a whole-file scan is satisfied by YAML comments and prose and lets the
    // pin delete itself (review PRR-001).
    const stepIdx = security.indexOf('embed-seam-contract.test.ts');
    expect(stepIdx, 'security.yml must run the contract-family specs').toBeGreaterThan(-1);
    const stepStart = security.lastIndexOf('\n      - ', stepIdx);
    const stepEnd = security.indexOf('\n      - ', stepIdx);
    const stepBlock = security.slice(stepStart, stepEnd === -1 ? security.length : stepEnd);
    const runIdx = stepBlock.indexOf('run:');
    expect(runIdx, 'the contract step must carry a run scalar').toBeGreaterThan(-1);
    const runScalar = stepBlock.slice(runIdx);
    for (const name of FAMILY_ROSTER) {
      expect(runScalar, `the contract run line must select ${name}`).toContain(name);
    }
    expect(stepBlock, 'the contract step must not be continue-on-error').not.toContain('continue-on-error');
    expect(stepBlock, 'the contract step must be unconditional').not.toMatch(/\n\s+if:/);
    expect(
      runScalar,
      'the contract step must actually execute the family (a run that merely echoes the names is not a gate)',
    ).toMatch(/npm --prefix desktop test/);

    // (2b) The dependency-install step the contract run relies on is present
    // and equally unconditional (review PRR-003: breaking the install must
    // not silently un-gate; and the step itself must not be skippable).
    const installIdx = security.indexOf('npm --prefix desktop ci');
    expect(installIdx, 'the contract family needs its desktop install step').toBeGreaterThan(-1);
    const installStart = security.lastIndexOf('\n      - ', installIdx);
    const installEnd = security.indexOf('\n      - ', installIdx);
    const installBlock = security.slice(
      installStart,
      installEnd === -1 ? security.length : installEnd,
    );
    expect(installBlock, 'the install step must not be continue-on-error').not.toContain(
      'continue-on-error',
    );
    expect(installBlock, 'the install step must be unconditional').not.toMatch(/\n\s+if:/);

    // (3) The load-bearing unconditionality facts stay true: the pull_request
    // trigger carries no paths scoping (a scoped trigger would leave the
    // required check Pending on unrelated diffs), and the job has no
    // job-level if:/needs: gate (indent-4 keys under the job).
    expect(security, 'the security workflow must keep an unscoped pull_request trigger').not.toMatch(
      /^\s{4,}(paths|paths-ignore):/m,
    );
    expect(security, 'the security job must carry no job-level if:, needs:, or continue-on-error').not.toMatch(
      /^    (if|needs|continue-on-error):/m,
    );

    // (4) Structural roster rule: every convention match is either rostered
    // or an explicit exclusion — a new family-named spec cannot silently sit
    // outside the required gate.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(SPEC_DIR);
    // Includes the `contract-spec-` prefix family members adopt
    // (contract-spec-conventions.test.ts and its successors): a successor
    // named after the family's own precedent must not escape the roster net.
    // (The prefix arm needs its own `.*\.test\.ts$` tail — inside a shared
    // group it would only match the degenerate `contract-spec-.test.ts`.)
    const convention = /^contract-spec-.*\.test\.ts$|(-contract|-parity|-conventions)\.test\.ts$/;
    const unclassified: string[] = [];
    for (const file of files.sort()) {
      const base = path.basename(file);
      if (!convention.test(base)) continue;
      if (FAMILY_ROSTER.includes(base)) continue;
      if (ROSTER_EXCLUSIONS.has(base)) continue;
      unclassified.push(base);
    }
    expect(
      unclassified,
      'every convention-matching spec must be rostered or explicitly excluded (with a reason)',
    ).toEqual([]);
    // The roster is closed: every roster member exists and every exclusion
    // still exists (entries cannot rot into free passes).
    for (const name of [...FAMILY_ROSTER, ...ROSTER_EXCLUSIONS.keys()]) {
      expect(fs.existsSync(path.join(SPEC_DIR, name)), `${name} must exist`).toBe(true);
    }
  });
});
