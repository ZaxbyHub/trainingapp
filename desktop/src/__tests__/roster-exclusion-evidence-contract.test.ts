// roster-exclusion-evidence-contract.test.ts — the contract-family roster's
// EXCLUSION list must stay evidenced. Every exclusion is a claim that the
// excluded spec is owned by some other CI context; an unevidenced or stale
// exclusion is a silent hole in the required gate (the excluded spec would
// then fail NO required check). Each entry must name (a) a file that exists
// under .github/workflows/ and (b) a literal scalar that file's text
// actually contains — the same evidence bar the roster run line itself is
// held to in ci-gate-required-contract.test.ts.
//
// The roster and exclusion registry lives in contract-family-registry.ts
// (single source of truth shared with the gate wiring); this spec is the
// frozen acceptance surface that validates the registry's evidence and its
// census completeness. It imports the registry, so it cannot run until the
// registry exists — that is the expected RED at the pre-implementation
// revision.
//
// Named mutants: (a) point an exclusion's workflow at a deleted/renamed
// workflow file -> Test A red; (b) edit the owning workflow so the pinned
// scalar disappears (e.g. its step is removed) -> Test A red; (c) corrupt
// the validator to accept absent evidence -> Test B red; (d) add a
// convention-named spec and neither roster nor exclude it -> Test C red;
// (e) roster and exclude the same spec at once -> Test C red.
//
// The registry import carries the repo's ESM `.js` specifier for a `.ts`
// source (the i199 `engine.js` idiom): vite maps it to the TypeScript file,
// and a plain-nodenext typecheck of this spec stays clean.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_ROSTER, ROSTER_EXCLUSIONS } from './contract-family-registry.js';
import type { RosterExclusionEntry } from './contract-family-registry.js';

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
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * Workflow evidence snapshot: workflow file name -> file text, or null when
 * the file is missing. Pure input to the validator so the negative controls
 * can feed it fabricated maps.
 */
type WorkflowFilesById = ReadonlyMap<string, string | null>;

/**
 * The single evidence validator shared by every assertion in this spec (the
 * positive Test A and the self-asserting negative Test B run the SAME
 * logic): an exclusion is evidenced only when the named workflow file
 * exists and its text contains the entry's scalar. Returns a violation
 * naming the spec, the workflow, and the scalar, or null when the evidence
 * is sound.
 */
function evidenceViolation(entry: RosterExclusionEntry, filesById: WorkflowFilesById): string | null {
  const content = filesById.get(entry.runs_in.workflow) ?? null;
  if (content === null) {
    return (
      `${entry.spec}: excluded via ${entry.runs_in.workflow}, but that workflow does not exist ` +
      `under .github/workflows/ (evidence scalar ${JSON.stringify(entry.runs_in.scalar)})`
    );
  }
  if (!content.includes(entry.runs_in.scalar)) {
    return (
      `${entry.spec}: workflow ${entry.runs_in.workflow} does not contain the evidence scalar ` +
      `${JSON.stringify(entry.runs_in.scalar)} (claimed reason: ${entry.reason})`
    );
  }
  return null;
}

/** Read each referenced workflow once (missing files map to null). */
function readWorkflowFiles(entries: readonly RosterExclusionEntry[]): Map<string, string | null> {
  const filesById = new Map<string, string | null>();
  for (const entry of entries) {
    if (filesById.has(entry.runs_in.workflow)) continue;
    const workflowPath = path.join(WORKFLOWS_DIR, entry.runs_in.workflow);
    filesById.set(
      entry.runs_in.workflow,
      fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : null,
    );
  }
  return filesById;
}

describe('roster exclusion evidence contract', () => {
  it('every ROSTER_EXCLUSIONS entry names an existing workflow whose text contains the evidence scalar', () => {
    const filesById = readWorkflowFiles(ROSTER_EXCLUSIONS);
    for (const entry of ROSTER_EXCLUSIONS) {
      expect(
        evidenceViolation(entry, filesById),
        `unevidenced ROSTER_EXCLUSIONS entry for ${entry.spec} ` +
          `(workflow ${entry.runs_in.workflow}, scalar ${JSON.stringify(entry.runs_in.scalar)})`,
      ).toBeNull();
    }
  });

  it('the evidence validator rejects fabricated evidence (self-asserting negative)', () => {
    // Guard the control's premise: desktop-build.yml must exist and really
    // run the desktop suite, or the fabricated-scalar check below would
    // pass for the missing-file reason instead.
    const buildYml = path.join(WORKFLOWS_DIR, 'desktop-build.yml');
    expect(fs.existsSync(buildYml), 'the fabricated-evidence control needs desktop-build.yml').toBe(
      true,
    );

    // (a) Fabricated scalar: a real workflow, an evidence string its text
    // does not carry — the exact shape of a hand-waved exclusion.
    const fabricated: RosterExclusionEntry = {
      spec: 'fabricated-contract.test.ts',
      reason: 'x',
      runs_in: { workflow: 'desktop-build.yml', scalar: 'npm --prefix desktop test --no-such-thing' },
    };
    const fabricatedFiles: WorkflowFilesById = new Map([
      ['desktop-build.yml', fs.readFileSync(buildYml, 'utf8')],
    ]);
    const fabricatedViolation = evidenceViolation(fabricated, fabricatedFiles);
    expect(
      fabricatedViolation,
      'a scalar absent from the workflow text must yield a violation',
    ).not.toBeNull();
    expect(fabricatedViolation, 'the violation must name the entry spec').toContain(
      'fabricated-contract.test.ts',
    );
    expect(fabricatedViolation, 'the violation must name the workflow').toContain('desktop-build.yml');
    expect(fabricatedViolation, 'the violation must name the scalar').toContain('--no-such-thing');

    // (b) A missing workflow must also be a violation, not a silent pass.
    const missing: RosterExclusionEntry = {
      spec: 'fabricated-contract.test.ts',
      reason: 'x',
      runs_in: { workflow: 'no-such-workflow.yml', scalar: 'anything' },
    };
    const missingViolation = evidenceViolation(
      missing,
      new Map<string, string | null>([['no-such-workflow.yml', null]]),
    );
    expect(missingViolation, 'a missing workflow file must yield a violation').not.toBeNull();
    expect(missingViolation, 'the missing-workflow violation must name the workflow').toContain(
      'no-such-workflow.yml',
    );

    // (c) Every REAL entry validates clean through the same helper over the
    // real workflow files — Tests A and B share this single source of logic.
    const realFiles = readWorkflowFiles(ROSTER_EXCLUSIONS);
    for (const entry of ROSTER_EXCLUSIONS) {
      expect(
        evidenceViolation(entry, realFiles),
        `real entry ${entry.spec} must validate clean through the shared helper`,
      ).toBeNull();
    }
  });

  it('roster and exclusion specs are disjoint and complete over the convention census', () => {
    // Same convention net as ci-gate-required-contract.test.ts: the
    // `contract-spec-` prefix arm needs its own `.*\.test\.ts$` tail — inside
    // a shared group it would only match the degenerate
    // `contract-spec-.test.ts`.
    const convention = /^contract-spec-.*\.test\.ts$|(-contract|-parity|-conventions)\.test\.ts$/;
    const census = fs
      .readdirSync(SPEC_DIR)
      .filter((name) => convention.test(name))
      .sort();
    const roster = new Set<string>(FAMILY_ROSTER);
    const excluded = new Set<string>(
      ROSTER_EXCLUSIONS.map((entry: RosterExclusionEntry) => entry.spec),
    );

    const overlap = [...roster].filter((name) => excluded.has(name)).sort();
    expect(overlap, 'a spec cannot be both rostered and excluded').toEqual([]);

    const unclassified = census.filter((name) => !roster.has(name) && !excluded.has(name));
    expect(
      unclassified,
      'every convention-matching spec must be in FAMILY_ROSTER or ROSTER_EXCLUSIONS',
    ).toEqual([]);
  });
});
