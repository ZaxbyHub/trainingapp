// contract-family-registry.ts — the single source of truth for the
// contract-family gate wiring (issue #233, plan A2). Two consumers share it:
//   * ci-gate-required-contract.test.ts — pins that the required `security`
//     job's run line selects every rostered spec, that the roster/exclusion
//     census over the naming convention is closed, and that every exclusion
//     carries machine-verifiable owning-workflow evidence;
//   * roster-exclusion-evidence-contract.test.ts — the frozen acceptance
//     surface validating the registry's evidence and census completeness.
// Because both specs import this module, the roster can never drift between
// the gate that enforces it and the evidence contract that audits it.
//
// Roster policy (issue #233 disposition): ROSTER the specs whose pins are
// security-adjacent or cross-cutting — they have no other merge-blocking
// home, so the required `security` contract-family step is their gate.
// EXCLUDE (with typed evidence) only the specs with a genuine non-security
// owning CI context; an exclusion is a claim that the named workflow's run
// line really executes that spec, and `runs_in.scalar` must be a literal the
// owning workflow's text actually contains (a run-line fragment, never a
// paths: trigger filter — those prove nothing executes).

/** One excluded spec and the machine-verifiable evidence of its owning CI context. */
export type RosterExclusionEntry = {
  spec: string;
  reason: string;
  runs_in: { workflow: string; scalar: string };
};

/** The closed contract-family roster — the specs the required security step runs. */
export const FAMILY_ROSTER: string[] = [
  'embed-seam-contract.test.ts',
  'embed-threads-clamp-contract.test.ts',
  'embed-constants-parity.test.ts',
  'pack-twin-parity.test.ts',
  'ci-gate-required-contract.test.ts',
  'contract-spec-conventions.test.ts',
  // issue #233 (PR #230 follow-up): the backend lifecycle pins join the
  // required gate — they pin security-adjacent host behavior and have no
  // other merge-blocking home.
  'backend-env-repo-root-contract.test.ts',
  'backend-lifecycle-capture-once-census.test.ts',
  'backend-memory-tick-lifecycle.test.ts',
  'i199-backend-surface-lifecycle.test.ts',
  'reranker-generation-lifecycle.test.ts',
  'i230-resolver-env-parity.test.ts',
  // The frozen acceptance surfaces of this issue ride the same gate.
  'roster-exclusion-evidence-contract.test.ts',
  'frozen-recipe-replay-contract.test.ts',
];

/** Convention-matching specs owned by another CI context, with run-line evidence. */
export const ROSTER_EXCLUSIONS: RosterExclusionEntry[] = [
  {
    spec: 'acceptance-precision-contract.test.ts',
    reason: 'pin-record guard owned by harness-contracts.yml',
    runs_in: {
      workflow: 'harness-contracts.yml',
      // The owning run line's tail (run: npm --prefix desktop test --
      // src/__tests__/harness- src/__tests__/acceptance-precision-...):
      // contiguous, run-line-unique — the bare filename also appears in the
      // paths: trigger filters, which are not run evidence.
      scalar: 'test -- src/__tests__/harness- src/__tests__/acceptance-precision-contract.test.ts',
    },
  },
  {
    spec: 'packaged-smoke-contract.test.ts',
    reason: 'needs a packaged dist (desktop-build smoke)',
    runs_in: { workflow: 'desktop-build.yml', scalar: 'npm --prefix desktop test' },
  },
  {
    spec: 'harness-kill-guard-contract.test.ts',
    reason: 'harness-contracts.yml owns this pin',
    runs_in: { workflow: 'harness-contracts.yml', scalar: 'test -- src/__tests__/harness-' },
  },
  {
    spec: 'harness-parse-contract.test.ts',
    reason: 'harness-contracts.yml owns this pin',
    runs_in: { workflow: 'harness-contracts.yml', scalar: 'test -- src/__tests__/harness-' },
  },
  {
    spec: 'e1-manifest-contract.test.ts',
    reason: 'desktop-build-owned pin (installer fixtures)',
    runs_in: { workflow: 'desktop-build.yml', scalar: 'npm --prefix desktop test' },
  },
  {
    spec: 'b9-contract-route-parity.test.ts',
    reason: 'desktop-build-owned pin (route fixtures)',
    runs_in: { workflow: 'desktop-build.yml', scalar: 'npm --prefix desktop test' },
  },
  {
    spec: 'browser-pack-extract-parity.test.ts',
    reason: 'desktop-build-owned pin (browser twin)',
    runs_in: { workflow: 'desktop-build.yml', scalar: 'npm --prefix desktop test' },
  },
  {
    spec: 'c3-pack-parity.test.ts',
    reason: 'desktop-build-owned pin (pack fixtures)',
    runs_in: { workflow: 'desktop-build.yml', scalar: 'npm --prefix desktop test' },
  },
];
