# Contributing to TrainingApp (trainingapp)

How to file issues for verifiable work in this hybrid Python/Node/Electron repository.

<!-- CANONICAL-VERSION: ZaxbyHub/opencode-swarm@e5278b2522 (PR #3185). Verbatim-copy core; repo notes are repo-specific. Update by re-copying from the canonical and bumping this stamp. -->


The issue-format contract below is the canonical version (see the stamp). The "Repo notes" section at the end is specific to this repository.

## Filing issues — issues are executable contracts

Issues in this repository are not prose requests: they are **executable contracts**. A well-formed issue can be frozen into acceptance checks, proven RED at the base commit, and proven GREEN at the head of its PR, with independent reviewer and critic gates in between. Every criterion that can be executable must be bound to a check — a criterion with a fake or missing binding is miswritten. Criteria that genuinely cannot be executable take the NON-EXECUTABLE path below instead. This section defines the contract; the tracer workflow consumes this shape. Existing issues filed before this contract are grandfathered; it governs new issues.

**Where this sits in the field.** The acceptance-criteria grammar below is [EARS](https://alistairmavin.com/ears/) (Easy Approach to Requirements Syntax — Mavin/Rolls-Royce, 2009; used across aerospace and heavyweight systems engineering). The overall shape — specification before plan, plan before tasks, human gates around implementation — is the same family as [GitHub Spec Kit](https://github.com/github/spec-kit)'s constitution → specify → plan → tasks → implement → converge. Our differentiator: the specification lives in the tracker (the issue itself), and acceptance is **proven executably** (frozen checks run RED at base, GREEN at head) rather than by implementation review alone. The one-AC-one-check rule is classical requirements traceability: every requirement gets exactly one chosen verification method.

### Two issue types

1. **Standalone issues** (feature, bug, investigation): the required core below, no title convention beyond a clear outcome-oriented statement.
2. **Workstream program issues**: when a program spans multiple PRs, it is decomposed as one issue per PR with the title ``[Workstream <letter>] PR <n> of <m>: <outcome statement>`` — workstreams are parallel-capable tracks, PRs within a workstream are sequential, and **one issue = one PR**. Each body carries a `## Sequence` section naming the full chain (`#A -> #B -> ...`) and its depends-on/blocks relationships. The umbrella tracker/epic issue (workstream table, closure ledger, maintainer-gated items, checklist) is repo-specific; see the repo notes at the end of this file.

### Body anatomy (required core)

Every verifiable issue has, in this order:

1. **Provenance preamble** (italic, first line): where the issue was generated from (audit run, session, plan), the exact commit every claim was re-checked against (full SHA), the one-issue-one-PR statement, and a disclaimer for any referenced local artifacts that are not in this repository.
2. `## Summary` — what will be true after this PR that is not true today. Outcome-framed, not task-framed.
3. `## Problem (claims to verify)` or `## Current state (evidence)` — numbered claims, each carrying:
   - a file:line reference, as a permalink anchored to the full SHA named in the preamble;
   - a code excerpt for load-bearing lines (the lines a fix will touch or a check will read);
   - an **epistemic label** — `VERIFIED` (re-checked at the anchor commit; say how) or `INFERENCE` (motivating but unproven) — so the implementer knows which premises still need proving;
   - a **prior-art reconciliation** note when a claim overlaps existing implementations (name them and state which one this PR extends rather than duplicates);
   - corrections discovered during review are **preserved inline** (`CORRECTED during review: ...`), never silently rewritten — the issue is a living record of what was claimed and what was verified.
4. `## Scope` — `In:` and `Out:` (out-of-scope items reference their owning issue when they have one).
5. `## Acceptance criteria` — the contract (next subsection). Non-negotiable.
6. `## Sequence` — programs only (above).

### The acceptance-criteria contract

Each criterion is a checkbox line in **EARS grammar**:

```
- [ ] ACn: WHEN <trigger>, THE SYSTEM SHALL <observable response>
```

- Sequential from `AC1`, nothing between the id and the colon, each AC appears exactly once. One AC binds to exactly **one** frozen check — never share a check across ACs.
- EARS patterns, in order of preference for this repo: **event-driven** (`WHEN <trigger>, THE SYSTEM SHALL <response>` — the default), **ubiquitous** (`THE SYSTEM SHALL <response>` — always-true properties; the natural shape for PRESERVING criteria), **unwanted-behavior** (`IF <undesired trigger>, THEN THE SYSTEM SHALL <response>` — error paths), **state-driven** (`WHILE <state>, THE SYSTEM SHALL <response>`), **optional-feature** (`WHERE <feature>, THE SYSTEM SHALL <response>`).
- The response must be **observable** — a test can assert it. "The system shall be more robust" is not a response.

Each AC carries exactly five sub-bullets:

```
- [ ] AC1: WHEN <trigger>, THE SYSTEM SHALL <observable response>.
  - class: DISCRIMINATING | NEW-SURFACE | PRESERVING
  - argv: <one runnable command from the repository root — the frozen check driver>
  - expect: <the signature the BASE leg shows before the fix>
  - files: <files the check reads or creates>
  - why: <why this is red at base — or green at both ends for PRESERVING>
```

| class | meaning | base leg | head leg |
|---|---|---|---|
| `DISCRIMINATING` | the defect exists today | **RED** (the failure signature) | GREEN |
| `NEW-SURFACE` | the fix creates a surface that cannot exist at base (new spec, new tool) | deterministic **absence** signature — the runner's literal no-matches output (e.g. vitest's `No test files found`, bun's `The following filters did not match any test files:`) | GREEN |
| `PRESERVING` | a regression floor | GREEN | GREEN |

Honest-class rules:

- Do not label an AC `DISCRIMINATING` unless it is genuinely red at the anchor commit — run the check mentally (or for real) against base before claiming it.
- A `NEW-SURFACE` AC must fail at base with a **deterministic** absence signature, never an environmental error (missing runtime, network). If the driver cannot exist at base, the driver itself prints a sentinel line and exits nonzero.
- `PRESERVING` criteria are regression floors: they must be green at base and stay green at head. A PRESERVING check that regresses at head is a fix bug, not a check bug.
- **No vacuous checks.** An AC shaped "do X and observe failure" that cannot fail on the primary dev/test runtime is a false contract — route the probe through a context where it can genuinely fail, or reshape the AC.

**NON-EXECUTABLE criteria.** Some criteria have no meaningful executable check — docs-only changes, host-only behavior (GUI/TUI surfaces a check cannot drive), maintainer product decisions, unavailable external services. For those, write `class: NON-EXECUTABLE(<reason>)` with the closed reason enum `DOCS_ONLY | HOST_ONLY | PRODUCT_DECISION | EXTERNAL_SERVICE_UNAVAILABLE`, replace `argv`/`expect` with **named substitute evidence** (a review artifact, a decision recorded on the issue, a captured external state), and get plan-critic approval for the substitution — never force an artificial executable check; that is the vacuous shape the rule above forbids.
- `argv` is one command, runnable from the repository root, POSIX-safe, deterministic (use the repo's test-runner flags for hermetic runs — see repo notes). `expect` describes what the **base** leg shows; the head leg's pass condition lives in the check's own exit logic.

### Evidence rules

- Every claim is anchored: permalinks embed the full SHA; before filing, re-verify each claim at that commit and say so in the preamble.
- Quotes and excerpts must exist verbatim in the cited file at the cited lines — grep each one before filing (a fabricated quote propagates into every downstream ledger).
- When line numbers matter, confirm the cited file is unchanged between the anchor commit and filing (or re-anchor).
- Label every non-trivial claim `VERIFIED` or `INFERENCE`.

### Extended-section menu (recommended for design-heavy and program issues)

The core is the required minimum. For issues whose fix has real design surface, add any of these (they **inform**, the ACs **bind** — if a Design section and an AC disagree, the AC wins and the Design section gets corrected):

`## Why (evidence)` · `## Current behaviour` · `## Dependencies` (`Depends on:` / `Gated on:` / `Blocks:`) · `## Design` (numbered, with exact signatures) · `## Files to change` · `## Tests` (named spec files) · `## Fixtures to add` · `## Local verification recipe` (commands) · `## Release rules` · `## Definition of done`

### Filing checklist (self-review before Create)

- [ ] Preamble names the source, the anchor SHA, and re-verification
- [ ] Every claim has a full-SHA permalink; every quote greps clean at that SHA; VERIFIED/INFERENCE labeled
- [ ] Scope has both In and Out
- [ ] ACs sequential, each exactly five sub-bullets, one-AC-one-check
- [ ] Classes honest (DISCRIMINATING genuinely red at base; NEW-SURFACE deterministic absence; PRESERVING green-both-ends)
- [ ] No vacuous checks; argv runnable from repo root; expect describes the base leg
- [ ] Program issues: title `[Workstream <letter>] PR n of m`, Sequence section, one issue = one PR
- [ ] Any NON-EXECUTABLE criterion carries a closed-enum reason and named substitute evidence (not a forced check)

### Repo notes (trainingapp)

- **argv conventions for this repo**: python checks as `cd tests && python -m pytest <file> -q`; web_ui checks as `cd web_ui && npx vitest run <file>`; desktop checks as `npm --prefix desktop test`.
- **Contract triplication**: any issue that adds or changes a REST route touches the frozen three-way contract (contracts/api.openapi.yaml + desktop Node CONTRACT_ROUTES + FastAPI) and fans out to four CI workflows — such issues MUST say so in Scope and budget the parity work.
- **CI is path-scoped with fail-open buckets** — a new top-level tree runs everything on first touch.
- A `NEW-SURFACE` argv naming a spec absent at base fails with vitest's `No test files found` or pytest's file-not-found — write the real signature verbatim in `expect`.

## Trace evidence and acceptance-check conventions

Two conventions govern how this repository keeps issue-tracer evidence honest
(established by the `packaged-smoke-cdp` batch; issue #219 AC5 records them
in-repo so they are not tribal knowledge):

1. **`.agents/issue-traces/` evidence is local-only by convention.** Trace
   directories hold frozen check drivers, red-checkpoint manifests, anchor
   receipts, and replay logs. They are git-excluded (`.gitignore`) and are NOT
   reproducible from a clone. Issues and PR bodies that cite trace files carry
   a local-artifact disclaimer; anything a reviewer must be able to re-run or
   verify from the repo itself — acceptance specs, pin records, guard scripts —
   is committed to the repository, and the external anchor receipt is
   published in the issue/PR thread (outside the writable trace) precisely so
   the trace cannot self-attest.

2. **The packaged-smoke contract spec's extras-outside-frozen-set split is a
   deliberate design decision.** `desktop/src/__tests__/packaged-smoke-contract.test.ts`
   publishes `TEST_INVENTORY`, and its test names are a frozen contract: the
   acceptance battery's `-t` filters (the "closed set") select exactly one test
   each **within that spec file** — the battery's frozen checks invoke `-t`
   file-scoped, enforced by `acceptance-precision-contract.test.ts` `-t
   filter-uniqueness` — while the remaining tests are an explicit "declared
   extras" list (enforced by `-t inventory`). Suite-wide `-t` filters are
   substring matches and may also select the harness contract family (the
   frozen `harness-kill-guard` filter intentionally contains `kill-guard`);
   the closed-set guarantee is the file-scoped one. The rationale: the frozen
   battery must stay name-stable (its checks select tests by filter), yet
   precision probes that strengthen the same surface should not be blocked from
   landing — so they are declared, inventoried, and covered by the full suite
   instead of silently riding a filter or silently sitting outside every check.
