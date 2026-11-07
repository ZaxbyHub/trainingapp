# CI/CD Pipeline Documentation

## Overview

This project uses GitHub Actions for continuous integration and deployment. All workflows are defined in `.github/workflows/`. Nine workflows run the CI signal; three of them (Tests, Web UI, Conformance) plus Security implement the path-scoped gating model of issue #87 (Workstream E, E4), and `doc-accuracy` (issue #89) runs unconditionally on every PR and push.

## Path scoping model (issue #87)

PR feedback time must match diff size, and every PR that touches a contract or a pack format must get a conformance/pack signal without paying for unrelated jobs. Two rules make that work:

1. **Workflows whose checks are required never use workflow-level `paths:` filters.** GitHub reports a workflow skipped by path filtering as never having run, so its required checks would sit "Pending" forever and block merging (GitHub docs, "Handling skipped but required checks"). Path scoping therefore lives at JOB level: a `changes` job classifies the diff via `scripts/ci_paths.py` into buckets (`python`, `webui`, `conformance`, `pack`, `eval`), and each real job runs `if: ${{ !cancelled() && needs.changes.outputs.<bucket> != 'false' }}` with exactly one sanctioned exception (issue #319 AC3): `python-conformance` adds a push-always clause — `!cancelled() && (github.event_name == 'push' || needs.changes.outputs.conformance != 'false')` — so the pip-audit advisory gate runs on every push to `master`; the override is a closed set (PUSH_ALWAYS_JOBS) pinned to that exact string by `tests/test_ci_paths.py` (`!cancelled()`, not `always()`: `always()` keeps jobs running after a run is cancelled, defeating the PR concurrency cancel, while `!cancelled()` is still true when `changes` fails, so the gate stays fail-open). A job skipped by that conditional reports Success, so required checks stay satisfiable.
2. **Everything fails open.** The classifier treats unknown paths as `python=true` (a new module never silently skips the matrix), the `changes` job never fails (errors emit all-true), and the consumer polarity `!= 'false'` runs jobs when the output is missing. A broken gate can only make CI run more, never silently less.

`tests/test_ci_paths.py` pins the bucket decisions, the per-job wiring and polarity, and the required-checks provenance below. Fork PRs work too: the `changes` job diffs against `origin/$GITHUB_BASE_REF` with a full checkout.

## Required checks

A ruleset on `refs/heads/master` requires exactly these contexts for every actor — `bypass_actors: []`, a pull-request rule at `required_approving_review_count: 0`, non-strict — so a pending or failed required check blocks the merge for the maintainer without `--admin` (the classic branch protection is neutralized to match; created via the sequenced, explicitly authorized closeout steps on issue #277 AC6). Contexts are bare job `name:` strings (check runs carry no workflow prefix):

**Recovery path** (issue #277 AC6/AC7): when a required context is red for a cause outside the PR — a runner outage, a registry outage during the `dependency-audit` steps (npm exits 1 for an unreachable registry; the gate classifies by payload and fails closed after two retries, so an outage shows as a red context, not a false pass), or a known flake class (e.g. #135) — the maintainer temporarily disables the ruleset, merges, re-enables it, and logs the event on issue #277. The same log covers any `--admin` use while the ruleset is disabled.

```text
web-ui (typecheck + build + test + packaging)
web-ui e2e (browser-mode pack gate, Playwright)
security
python-conformance
pack-fixture-build
dependency-audit
```

Informational (never blocks merge): the 2-leg Tests matrix, `perf-thresholds` (floors-or-stated-skip-reasons signal), `eval-report`, the whole Desktop Build workflow, and `doc-accuracy` (issue #89: documentation-vs-code drift guardrail — deliberately unscoped so docs-only PRs get a signal; informational tier is a deliberate choice, not an omission — promote it to required by adding the `doc-accuracy` context to branch protection if the maintainers want it gating). Note for PRs opened BEFORE a required check existed (e.g. #48): the new checks stay "Pending" on the old head until the PR is pushed again or closed/reopened. Contract-family exclusion disclosure (issue #233): the specs excluded from the required `security` family roster evidence their OWNING context's run line (see `desktop/src/__tests__/contract-family-registry.ts` and `roster-exclusion-evidence-contract.test.ts`), and several of those owners are informational themselves (the desktop-build full suite, the harness-contracts workflow) — the exclusion evidence proves the owning run line, not unconditional execution: on PRs touching none of a workflow's path filters the owning workflow does not run, and the excluded spec then executes nowhere (harness-contracts and desktop-build both carry workflow-level `paths:` filters); the evidence proves nothing about merge-blocking either — merge-blocking closure for the lifecycle specs at issue was delivered by rostering them instead.

The `security` job (required, unbucketed — it reports on every PR) additionally runs the **contract-spec family** and the **Audit guards** step (issue #276/#277: the pinned `pytest`/`pyyaml`/`packaging` run of the dependency-currency and advisory-gate guards — `tests/test_vendored_xlsx.py`, `test_dependency_currency.py`, `test_extractor_twins.py`, `test_electron_fuses.py`, `test_dependency_audit_gate.py`, `test_dependabot_config.py`, `test_runtime_pins.py`, `test_python_advisory_step.py`, `test_ci_paths.py`, `test_master_push_advisory_scan.py`, `test_319_guards.py` (issue #319); the first of workstreams G/E/F/H to land creates the step, later ones append their guard files) (issue #215): a red contract pin or a red guard fails this required context, so it blocks the merge. (Safety was removed from this job by issue #277: its bundled database could not see CVE-2026-68770; the current-database `pip-audit` scan now runs in the required `python-conformance` job, which since issue #319 AC3 runs on EVERY push to `master` regardless of the diff and stays bucket-scoped on pull requests (Python-surface PRs only; unrelated changes skip it by path design on PRs) with owned package-keyed expiring accepted-risk entries, and the JavaScript graphs are gated by the required `dependency-audit` job — `scripts/audit_gate.py` against `.github/audit-allowlist.json`, where every entry is owner-named, owner-issued and dated so expiries force the decisions.) The roster (issue #233: the five PR #230 lifecycle pins — `backend-env-repo-root-contract`, `backend-lifecycle-capture-once-census`, `backend-memory-tick-lifecycle`, `i199-backend-surface-lifecycle`, `reranker-generation-lifecycle` — plus the separate `i230-resolver-env-parity` pin, the #232-residual pair `i230-host-stop-profile-reset` + `i230-sampler-liveness` (rostered by review PRR-008), and the frozen acceptance surfaces `roster-exclusion-evidence-contract` + `frozen-recipe-replay-contract`, joining the original six; the trace 201-207-208-209-210 pair `logline-contract-sweep` + `acceptance-battery-precision`; and the trace 248-41 diagnostics trio `diagnostics-redact-parity` + `diagnostics-logging` + `diagnostics-console-composition` plus its frozen-token re-driver `diagnostics-acceptance-precision` (review PRR-018/015, pr255)) lives in `desktop/src/__tests__/contract-family-registry.ts` — the single source of truth shared by the gate wiring and the frozen evidence contract — and is closed and pinned by `ci-gate-required-contract.test.ts`; every roster exclusion must name an owning workflow whose run line literally executes the excluded spec (`roster-exclusion-evidence-contract.test.ts`); new contract-family specs must be added to that step's run line and the registry.

## Workflows

### 1. Tests (`test.yml`) — path-scoped (`python`, `eval` buckets)

**Triggers:** push to main/master, PRs to main/master (unfiltered; scoping at job level).
**Jobs:**

- `changes` — diff → bucket outputs.
- `test` — Python 3.11/3.12 matrix on Windows (3.10 dropped as end-of-life by issue #277), pytest with coverage on the 3.11 leg; runs when the diff touches the Python surface (`tests/**`, root `*.py`, `bench/**`, `eval/**`, `contracts` fixtures/schema, ADR docs, `requirements.txt`, `pytest.ini`, `.github/ci/llama-cpp-constraints.txt`, `.github/ci/llama-cpp-wheel.txt`, `packtool/storyline/transcribe.py`, the three gated workflow files, and anything unclassified — fail-open).
- `perf-thresholds` — informational (issue #87): runs the evidence-conditional perf suites (`test_rag_performance.py`, `test_low_end_hardware.py`) plus their guardrails; asserts against `bench/RESULTS.md` machine-tagged floors where the machine has a floors row, else skips with a named per-artifact reason (issue #52 conversion). `continue-on-error`.
- `eval-report` — informational (issue #54): tier-0 eval harness against the deterministic no-weights backend; posts `eval-report/REPORT.md` + `report.json` artifacts; gated on the `eval` bucket (retrieval surface). `continue-on-error`.

### 2. Web UI (`web-ui.yml`) — path-scoped (`webui` bucket: `web_ui/**`, `contracts/**`, `vendor/**`, the workflow file, and the three desktop twins `desktop-twin-drift.test.ts` pins: `desktop/main/security/csp.ts`, `desktop/main/protocol.ts`, `desktop/main/backend/packs/pack-archive-rules.ts`)

**Triggers:** push to main/master, all PRs (unfiltered; scoping at job level).
**Jobs:** `web-ui` (typecheck app+tests, build, vitest, prepare-models/validate-build packaging checks) and `web-ui e2e` (the browser e2e suite, `npm run test:e2e`, run under both the Chromium and Firefox Playwright projects: browser-mode Knowledge Pack install + course-playback specs (ADR-0012) and the in-chat model-gate keyboard spec; then the Lumen a11y visual subset `npm run test:visual:a11y:ci` — the axe, tooltip-overflow, doc-row-reflow and doc-list-scroll specs only, Chromium only; the job keeps its original `browser-mode pack gate` display name because that name is the required status context). Both required. Firefox is a supported, CI-verified browser; Safari/WebKit is unsupported and not installed. All 6 player-origin isolation specs run on Firefox (the click-activation spec launches its own Firefox with Fission disabled, because Playwright cannot send input into an out-of-process frame). The third job, `web-ui-visual-baseline` (`windows-latest`), runs the `lumen-baseline` pixel spec WITHOUT `--update-snapshots` on a clean build with no staged weights; it is NOT required (absent from branch protection), so a red run is informative, and it may be red if the runner's fonts differ from the machine that generated the Windows-Chromium baselines (see `web_ui/e2e/visual/README.md`).

### 3. Conformance (`conformance.yml`) — path-scoped (`conformance`, `pack` buckets) — required

**Triggers:** push to main/master, PRs to main/master (unfiltered; scoping at job level).
**Jobs:**

- `python-conformance` — the frozen API contract suite (`contracts/tests/run_conformance.py --asgi api_server:app`), the #51 test-collection guard, the pip-audit advisory gate (issue #319 AC3: runs on every push to `master` regardless of the diff bucket; bucket-scoped on pull requests), and the CI wiring guardrail (`python -m pytest tests/test_ci_paths.py`) that carries the contract-family gate's external defender (review PRR-003: a diff that deletes the contract step from `security.yml` must still get a red required check). Runs on the Python surface and anything under `contracts/**` (lockstep fail-open with the `python` bucket), plus `scripts/check_test_collection.py`, `conformance.yml`, and `security.yml` (the defender's trigger).
- `pack-fixture-build` — packtool fixture packs: `build-docs` from `contracts/fixtures/source-docs/` (issue #73 leg, moved from desktop-build.yml) AND `build-storyline` against an assembled publish dir (`tests/fixtures/storyline-mini` + the committed `story.html` stub), each followed by `verify`; uploads both pack artifacts. Runs on `packtool/**`, `contracts/pack.schema.json`, `contracts/fixtures/**`, `contracts/validate_pack.py`.
- The Electron-backend conformance leg (issue #61/B3) stays in `desktop-build.yml` (`backend-conformance` job) — informational.

### 4. Desktop Build (`desktop-build.yml`) — workflow-level path filter (`desktop/**`, `web_ui/**`, `contracts/**`, `packtool/**`, `vendor/**`, `.github/workflows/desktop-build.yml`) — informational

**Jobs:** Electron shell build (unsigned NSIS, fixture models, E1 manifest gate, driver selftest + packaged-boot smoke per #133/#131/#177-#182 — the smoke runs `--driver cdp` behind its own 32-min step timeout, and the fixture installer uploads only AFTER a green smoke; also typechecks the `desktop/e2e` specs, `npm --prefix desktop run typecheck:e2e`), renderer Playwright-under-Electron (#67), Electron-backend conformance (#61), store interop + pack schema/parity (#63/#68/#70). Least-privilege: the workflow declares `permissions: contents: read`; all third-party actions are SHA-pinned with version comments. Its workflow-level `paths:` filter is safe because none of its checks are required.

### 5. Security Scan (`security.yml`) — unfiltered — required

Bandit on every push/PR plus weekly cron (the Bandit step is `continue-on-error` report-only) and the merge-blocking **Audit guards** step (issue #276/#277: pinned `pip install pytest==9.1.1 pyyaml==6.0.2 packaging==26.2`, then the eleven-file Python guard roster — `tests/test_vendored_xlsx.py`, `test_dependency_currency.py`, `test_extractor_twins.py`, `test_electron_fuses.py`, `test_dependency_audit_gate.py`, `test_dependabot_config.py`, `test_runtime_pins.py`, `test_python_advisory_step.py`, `test_ci_paths.py`, `test_master_push_advisory_scan.py`, `test_319_guards.py` (the last two join in issue #319)), plus the merge-blocking **contract-spec family** step (issue #215): Node setup + `npm --prefix desktop ci --no-audit --no-fund` + the closed 22-spec roster (issue #233: the original six — `embed-seam-contract`, `embed-threads-clamp-contract`, `embed-constants-parity`, `pack-twin-parity`, `ci-gate-required-contract`, `contract-spec-conventions` — plus the five PR #230 lifecycle pins `backend-env-repo-root-contract`, `backend-lifecycle-capture-once-census`, `backend-memory-tick-lifecycle`, `i199-backend-surface-lifecycle`, `reranker-generation-lifecycle`, the separate `i230-resolver-env-parity` pin, the #232-residual `i230-host-stop-profile-reset` and `i230-sampler-liveness` (rostered by review PRR-008), the frozen surfaces `roster-exclusion-evidence-contract`, `frozen-recipe-replay-contract`, the trace 201-207-208-209-210 pair `logline-contract-sweep` and `acceptance-battery-precision`, and the trace 248-41 diagnostics trio `diagnostics-redact-parity`, `diagnostics-logging`, `diagnostics-console-composition` plus its frozen-token re-driver `diagnostics-acceptance-precision` (review PRR-018/015, pr255); registry: `desktop/src/__tests__/contract-family-registry.ts`). Least-privilege: `permissions: contents: read`. Safety was removed from this job (issue #277 AC5): its bundled database could not see CVE-2026-68770 — the current-database scan is `pip-audit` (pinned, owned expiring ignore) inside the required `python-conformance` job. The JavaScript graphs are gated by the sibling required job `dependency-audit`: unfiltered push/PR triggers, no `continue-on-error`, `node-version-file: .nvmrc`, `python scripts/audit_gate.py --package-dir <pkg> --allowlist .github/audit-allowlist.json` per shipped package (payload-classified collection with two infra retries then fail-closed — see issue #277 AC1).

### 6. Build and Release (`build.yml`) — tags `v*` + manual

Python 3.11 Windows PyInstaller build, ZIP artifact, GitHub Release for tags.

### 7. Nightly Build (`nightly.yml`) — daily 2 AM UTC + manual

Dated archive artifact (7-day retention).

### 8. Create Release (`release.yml`) — manual

Version bump, commit, tag; dispatches `build.yml` against the tag.

## Usage

### Creating a New Release

1. Go to Actions tab
2. Select "Create Release"
3. Click "Run workflow"
4. Enter version number
5. Select version type (patch/minor/major)
6. Click "Run workflow"

### Running Tests Locally

```bash
# Install pre-commit hooks
pip install pre-commit
pre-commit install

# Run all hooks
pre-commit run --all-files

# Run tests
pytest tests/ -v

# Inspect CI path scoping for a diff
git diff --name-only --no-renames origin/master...HEAD | python scripts/ci_paths.py --bucket python --stdin
```

### Manual Build

```bash
python scripts/build.py
```

## Secrets

No secrets required for basic operation. The `GITHUB_TOKEN` is automatically provided.

## Caching

The following are cached for faster builds: pip packages (per job key), npm caches (per lockfile), PyInstaller build cache. The Windows Python jobs in `test.yml` and `conformance.yml` install a hash-pinned prebuilt `llama-cpp-python` wheel (`.github/ci/llama-cpp-wheel.txt`, from the project's CPU wheel index, `--require-hashes`) before `pip install -r requirements.txt -c .github/ci/llama-cpp-constraints.txt`, so PyPI's sdist is never compiled; both files are part of the pip cache keys. `build.yml` and `nightly.yml` are unchanged.

## Troubleshooting

### A required check is stuck "Pending — Waiting for status to be reported"

That PR's head predates the workflow (or the job name changed). Push to the PR (or close/reopen it) so the workflows run and report the check; a workflow-level path filter cannot be the cause — required workflows are unfiltered by design.

### Jobs skipped on an unrelated diff

Check the `changes` job log: it prints the bucket decisions. If a file you changed is unclassified, the `python` bucket fails OPEN on purpose — extend the classifier lists in `scripts/ci_paths.py` (and the pins in `tests/test_ci_paths.py`) when a tree is verified irrelevant or relevant.

### Build Timeout

If the build times out (45 minutes), you may need to: clear the cache, re-run the workflow, or check for dependency updates.

## Badges

Add these to your README.md:

```markdown
![Build](https://github.com/USERNAME/REPO/workflows/Build%20and%20Release/badge.svg)
![Tests](https://github.com/USERNAME/REPO/workflows/Tests/badge.svg)
![Security](https://github.com/USERNAME/REPO/workflows/Security%20Scan/badge.svg)
```

### doc-accuracy (issue #89)

Always-run documentation-accuracy guardrail. No `paths:` filter and no bucket gate — by design: the path-scoped model above skips docs-only diffs, and doc drift is exactly what this check polices. Runs `tests/test_doc_accuracy.py` (stdlib-only) on `ubuntu-latest`; informational tier (see Required checks above).

### harness-contracts (issues #216/#219)

Contract guards for the harness runners and the action-pin record (`harness-contracts.yml`). Workflow-level `paths:` filter on the surfaces the guards govern — `bench/**`, `scripts/**`, `web_ui/scripts/**`, `.github/workflows/**` (incl. `pins.json`), `desktop/package.json`/`package-lock.json`, and the contract specs themselves — because `desktop-build.yml`'s filter does not trigger on those trees, leaving the guards inert on their own subjects (PR #220 review PRR-002). Runs the `harness-*` contract specs plus `acceptance-precision-contract.test.ts` (filename filters, so future `harness-*.test.ts` files run here automatically) on `windows-latest`; informational tier (see Required checks above — merge-blocking promotion of the contract suite is issue #215's decision).
