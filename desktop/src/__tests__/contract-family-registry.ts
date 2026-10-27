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
  // Review PRR-008 (pr242-20261021): the frozen #232-residual acceptance
  // specs join the roster — same REAL-engine idiom as the ubuntu-green
  // memory-tick spec; before this they ran in no merge-blocking context
  // and were invisible to the convention census (non-convention names).
  'i230-host-stop-profile-reset.test.ts',
  'i230-sampler-liveness.test.ts',
  // The frozen acceptance surfaces of this issue ride the same gate.
  'roster-exclusion-evidence-contract.test.ts',
  'frozen-recipe-replay-contract.test.ts',
  // Trace 201-207-208-209-210 (collated test-gate-integrity batch): the
  // batch's acceptance battery and its meta-guard had no other
  // merge-blocking home - same disposition as the #232-residual specs
  // (review PRR-008, pr242-20261021).
  'logline-contract-sweep.test.ts',
  'acceptance-battery-precision.test.ts',
  // Trace 248-41 (issue #248): the redaction-gate parity contract (both twins
  // byte-identical over the shared corpus, desktop console outcomes) pins
  // security-adjacent AC5 behavior with no other merge-blocking home.
  'diagnostics-redact-parity.test.ts',
  // Review PRR-018 (pr255): the trace's other two new desktop specs — the
  // logging core spec (file transport, toggle, export bundle, capture/ingest)
  // and the console-composition contract — are named OUTSIDE the convention
  // and had no merge-blocking home; same disposition as the parity spec.
  'diagnostics-logging.test.ts',
  'diagnostics-console-composition.test.ts',
  // Review PRR-015 (pr255): the trace's frozen -t acceptance tokens gain a
  // committed re-driver (the acceptance-battery-precision pattern) — rostered
  // with it for the same no-other-home reason.
  'diagnostics-acceptance-precision.test.ts',
];

/** Convention-matching specs owned by another CI context, with run-line evidence. */
export const ROSTER_EXCLUSIONS: RosterExclusionEntry[] = [
  {
    spec: 'acceptance-precision-contract.test.ts',
    reason: 'pin-record guard owned by harness-contracts.yml',
    runs_in: {
      workflow: 'harness-contracts.yml',
      // The owning run line VERBATIM (single physical line). Review
      // PRR-002: the previous tail-only scalar was a line PREFIX — a
      // narrowed run line starting with it kept the evidence green while
      // selecting fewer specs; the full-line form is what the hardened
      // line-exact check in ci-gate-required-contract.test.ts requires
      // (and the bare filename also appears in the paths: trigger
      // filters, which are not run evidence).
      scalar: 'npm --prefix desktop test -- src/__tests__/harness- src/__tests__/acceptance-precision-contract.test.ts',
    },
  },
  {
    spec: 'packaged-smoke-contract.test.ts',
    // Review PRR-013: truthful — the spec runs in desktop-build's full
    // vitest suite (before the build); only the packaged smoke itself
    // needs a built installer dist.
    reason: 'runs in desktop-build full vitest suite; packaged smoke needs built dist',
    runs_in: { workflow: 'desktop-build.yml', scalar: 'npm --prefix desktop test' },
  },
  {
    spec: 'harness-kill-guard-contract.test.ts',
    reason: 'harness-contracts.yml owns this pin',
    runs_in: {
      workflow: 'harness-contracts.yml',
      // Full owning run line (review PRR-002 tightened the previous
      // 'test -- src/__tests__/harness-' tail to the line-exact form).
      scalar: 'npm --prefix desktop test -- src/__tests__/harness- src/__tests__/acceptance-precision-contract.test.ts',
    },
  },
  {
    spec: 'harness-parse-contract.test.ts',
    reason: 'harness-contracts.yml owns this pin',
    runs_in: {
      workflow: 'harness-contracts.yml',
      // Full owning run line (review PRR-002 tightened the previous
      // 'test -- src/__tests__/harness-' tail to the line-exact form).
      scalar: 'npm --prefix desktop test -- src/__tests__/harness- src/__tests__/acceptance-precision-contract.test.ts',
    },
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
