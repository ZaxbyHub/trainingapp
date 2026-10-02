# CI/CD Pipeline Documentation

## Overview

This project uses GitHub Actions for continuous integration and deployment. All workflows are defined in `.github/workflows/`. Nine workflows run the CI signal; three of them (Tests, Web UI, Conformance) plus Security implement the path-scoped gating model of issue #87 (Workstream E, E4), and `doc-accuracy` (issue #89) runs unconditionally on every PR and push.

## Path scoping model (issue #87)

PR feedback time must match diff size, and every PR that touches a contract or a pack format must get a conformance/pack signal without paying for unrelated jobs. Two rules make that work:

1. **Workflows whose checks are required never use workflow-level `paths:` filters.** GitHub reports a workflow skipped by path filtering as never having run, so its required checks would sit "Pending" forever and block merging (GitHub docs, "Handling skipped but required checks"). Path scoping therefore lives at JOB level: a `changes` job classifies the diff via `scripts/ci_paths.py` into buckets (`python`, `webui`, `conformance`, `pack`, `eval`), and each real job runs `if: always() && needs.changes.outputs.<bucket> != 'false'`. A job skipped by that conditional reports Success, so required checks stay satisfiable.
2. **Everything fails open.** The classifier treats unknown paths as `python=true` (a new module never silently skips the matrix), the `changes` job never fails (errors emit all-true), and the consumer polarity `!= 'false'` runs jobs when the output is missing. A broken gate can only make CI run more, never silently less.

`tests/test_ci_paths.py` pins the bucket decisions, the per-job wiring and polarity, and the required-checks provenance below. Fork PRs work too: the `changes` job diffs against `origin/$GITHUB_BASE_REF` with a full checkout.

## Required checks

Branch protection on `master` requires exactly these contexts (they are bare job `name:` strings — check runs carry no workflow prefix):

```text
web-ui (typecheck + build + test + packaging)
web-ui e2e (browser-mode pack gate, Playwright)
security
python-conformance
pack-fixture-build
```

Informational (never blocks merge): the 3-leg Tests matrix, `perf-thresholds` (floors-or-stated-skip-reasons signal), `eval-report`, the whole Desktop Build workflow, and `doc-accuracy` (issue #89: documentation-vs-code drift guardrail — deliberately unscoped so docs-only PRs get a signal; informational tier is a deliberate choice, not an omission — promote it to required by adding the `doc-accuracy` context to branch protection if the maintainers want it gating). Note for PRs opened BEFORE a required check existed (e.g. #48): the new checks stay "Pending" on the old head until the PR is pushed again or closed/reopened.

## Workflows

### 1. Tests (`test.yml`) — path-scoped (`python`, `eval` buckets)

**Triggers:** push to main/master, PRs to main/master (unfiltered; scoping at job level).
**Jobs:**

- `changes` — diff → bucket outputs.
- `test` — Python 3.10/3.11/3.12 matrix on Windows, pytest with coverage on the 3.11 leg; runs when the diff touches the Python surface (`tests/**`, root `*.py`, `bench/**`, `eval/**`, `contracts` fixtures/schema, ADR docs, `requirements.txt`, `pytest.ini`, `packtool/storyline/transcribe.py`, the three gated workflow files, and anything unclassified — fail-open).
- `perf-thresholds` — informational (issue #87): runs the evidence-conditional perf suites (`test_rag_performance.py`, `test_low_end_hardware.py`) plus their guardrails; asserts against `bench/RESULTS.md` machine-tagged floors where the machine has a floors row, else skips with a named per-artifact reason (issue #52 conversion). `continue-on-error`.
- `eval-report` — informational (issue #54): tier-0 eval harness against the deterministic no-weights backend; posts `eval-report/REPORT.md` + `report.json` artifacts; gated on the `eval` bucket (retrieval surface). `continue-on-error`.

### 2. Web UI (`web-ui.yml`) — path-scoped (`webui` bucket: `web_ui/**`, `contracts/**`, the workflow file)

**Triggers:** push to main/master, all PRs (unfiltered; scoping at job level).
**Jobs:** `web-ui` (typecheck app+tests, build, vitest, prepare-models/validate-build packaging checks) and `web-ui e2e` (browser-mode pack-gate Playwright spec, C9/ADR-0009, then the Lumen a11y visual subset `npm run test:visual:a11y:ci` — axe + tooltip-overflow only; the screenshot spec is a manual Windows gate, see `web_ui/e2e/visual/README.md`). Both required.

### 3. Conformance (`conformance.yml`) — path-scoped (`conformance`, `pack` buckets) — required

**Triggers:** push to main/master, PRs to main/master (unfiltered; scoping at job level).
**Jobs:**

- `python-conformance` — the frozen API contract suite (`contracts/tests/run_conformance.py --asgi api_server:app`) plus the #51 test-collection guard. Runs on the Python surface and anything under `contracts/**` (lockstep fail-open with the `python` bucket).
- `pack-fixture-build` — packtool fixture packs: `build-docs` from `contracts/fixtures/source-docs/` (issue #73 leg, moved from desktop-build.yml) AND `build-storyline` against an assembled publish dir (`tests/fixtures/storyline-mini` + the committed `story.html` stub), each followed by `verify`; uploads both pack artifacts. Runs on `packtool/**`, `contracts/pack.schema.json`, `contracts/fixtures/**`, `contracts/validate_pack.py`.
- The Electron-backend conformance leg (issue #61/B3) stays in `desktop-build.yml` (`backend-conformance` job) — informational.

### 4. Desktop Build (`desktop-build.yml`) — workflow-level path filter (`desktop/**`, `web_ui/**`, `contracts/**`, `packtool/**`) — informational

**Jobs:** Electron shell build (unsigned NSIS, fixture models, E1 manifest gate, packaged-boot smoke per #133/#131), renderer Playwright-under-Electron (#67), Electron-backend conformance (#61), store interop + pack schema/parity (#63/#68/#70). Its workflow-level `paths:` filter is safe because none of its checks are required.

### 5. Security Scan (`security.yml`) — unfiltered — required

Bandit + Safety on every push/PR plus weekly cron; Bandit step is `continue-on-error` (report-only) but the job still gates on Safety.

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
git diff --name-only origin/master...HEAD | python scripts/ci_paths.py --bucket python --stdin
```

### Manual Build

```bash
python scripts/build.py
```

## Secrets

No secrets required for basic operation. The `GITHUB_TOKEN` is automatically provided.

## Caching

The following are cached for faster builds: pip packages (per job key), npm caches (per lockfile), PyInstaller build cache.

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
