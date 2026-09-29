# Pre-v3 Archived Documents (docs/archive/pre-v3/)

**Everything under this directory predates the v3 architecture** (Electron shell + Node backend + SQLite/sqlite-vec store + knowledge packs — see [../../../ARCHITECTURE.md](../../../ARCHITECTURE.md) and [docs/adr/](../../adr/)). These files describe the retired Python-desktop and browser-only eras (roughly 2026-02 through 2026-04). They are retained for history only: they are unmaintained, their commands and component names do not describe the shipped product, and citations inside them have been repaired only where they dangled within this archive. Do not update them; write new docs instead.

Moved from the repo root and docs/ by issue #89 (E6 documentation refresh, 2026-09-29).

## Inventory

| Archived file (this directory) | Was | Era | What it was |
|---|---|---|---|
| PIPELINE_OPTIMIZATION_PLAN.md | repo root | 2026-04 | Ingestion/chat pipeline optimization plan (IMPLEMENTED then; Python engine) |
| RAG_PIPELINE_FIXES_PLAN.md | repo root | 2026-04 | RAG pipeline defect-resolution plan (Python FastAPI/ChromaDB stack) |
| RAG_PIPELINE_FIXES_PLAN_REVISED.md | repo root | 2026-04 | Revision of the above |
| RAG_PIPELINE_REVIEW_REPORT.md | repo root | 2026-04-09 | v1.1.0 end-to-end pipeline review report |
| WEB_UI_OVERHAUL_PLAN.md | repo root | 2026 | Staged web_ui overhaul roadmap (Phases 1-7, completed) |
| html5_rfc_issue.md | repo root | 2026 | RFC proposing the HTML5 SPA delivery (built; superseded by the v3 Electron desktop) |
| qa-report.md | repo root | 2026-04-09 | v5.1 AI-hardening QA audit report (79 findings, Python scope) |
| UX_FIX_PLAN.md | docs/ | 2026 | FastAPI-surface UX fix plan |
| audit_model_gguf_paths.md | docs/ | 2026-03-11 | model_path vs gguf_path usage audit (Phase 15) |
| bug_ledger.md | docs/ | 2026-03-11 | Phase 14-15 bug ledger (6 confirmed defects) |
| build_verification_checklist.md | docs/ | 2026-03-11 | PyInstaller (AFOMIS.spec) build checklist |
| documentation_audit.md | docs/ | 2026-03-11 | Documentation audit (DEFECT-005 era) |
| final_bug_ledger.md | docs/ | 2026-03-11 | AFOMIS restoration final bug ledger (all fixed) |
| packaging_audit.md | docs/ | 2026-03-11 | PyInstaller packaging audit |
| postmortem_analysis.md | docs/ | 2026-03-11 | Phases 14-20 postmortem |
| regression_summary_phase15.md | docs/ | 2026-03-11 | Phase 15 regression test summary |
| security_hardening_guide.md | docs/ | 2026 | Python-side server hardening guide (FastAPI auth/JWT era; the v3 transport model is docs/security/desktop.md) |
| smoke_test_plan.md | docs/ | 2026-03-11 | Packaged AFOMIS.exe smoke test plan |
| releases/v0.1.0.md | docs/releases/ | 2026-04 | RAG hardening pass release notes |
| releases/v0.2.0.md | docs/releases/ | 2026-04 | Fluent-design UI modernization release notes |
| releases/v2.2.0.md | docs/releases/ | 2026-04 | RAG/chat performance release notes |
| releases/v2.2.1.md | docs/releases/ | 2026-04 | GUI freeze fix release notes |
| releases/v2.2.2.md | docs/releases/ | 2026-04 | Post-project cleanup release notes |

The authoritative release history is [../../../CHANGELOG.md](../../../CHANGELOG.md); release notes for the current web_ui surface era remain at [../../releases/v2.3.0.md](../../releases/v2.3.0.md).

## Justifications

- `docs/releases/v2.3.0.md` — NOT archived: it documents the offline HTML5 web-app overhaul (Phase 1-7) that is still the shipped browser surface; kept in place as the current release note for that era, superseded as a history record only by CHANGELOG.md.
- `web_ui/package/README.md` — NOT archived or rewritten: vendored third-party (EdgeVec) README kept verbatim per its own header; its upstream-relative links target files that were never part of this repository. Out of scope for doc rewrite by design.
- `AFOMIS.spec` (repo root) — NOT archived: legacy PyInstaller spec for the pre-v3 Python desktop app, superseded for the shipped product by desktop/electron-builder.yml (E1). Retained in place because build_exe.bat and the skip-gated tests/regression/test_defect_006_build_path.py reference it, and the legacy Python surface remains the CI conformance target (`.github/workflows/conformance.yml` runs `--asgi api_server:app`); it now carries an in-file banner. Its `seed_data` entry packages a directory that does not exist (gitignored; the loader was deliberately deleted).
- `scripts/export_seed_chunks.py` — NOT archived: legacy dev-only tool that would recreate the gitignored `seed_data/` directory; zero callers in CI or packaging; carries an in-file docstring note.
- `USAGE.md`, `INSTALL.md`, `CONFIGURATION.md` (repo root) — NOT archived: they document the legacy Python harness that still runs as the CI conformance target and are linked from README; each now carries a header note scoping it to that role, and their factually wrong claims (TinyBERT defaults, Q5_K_M, stale sizes) were corrected in place by issue #89.
- Historical citation targets that never existed (`docs/deferred_issues.md`, `docs/architecture_decisions/adr-001-dead-code.md`, referenced inside two archived plans) are left as-is — they are references to plans that never materialized, preserved as part of the historical record.
