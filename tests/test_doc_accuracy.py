"""Doc-vs-code accuracy guardrail (issue #89, E6).

Docs are code-adjacent surface with no runtime check: this file pins the
corrected documentation state so the "prose describing a system state that
differs from shipped code" defect class (stale model ids/sizes, dead file
citations, unmarked supersessions) is mechanically detectable on every PR —
including docs-only PRs, which the path-scoped CI buckets skip. It runs in the
always-run doc-accuracy workflow (.github/workflows/doc-accuracy.yml).

Enforced surface (deliberately narrow so every predicate is green-by-
construction after issue #89 and mutation-sensitive on exactly the files the
issue corrected): README.md, INSTALL.md, CONFIGURATION.md, USAGE.md,
ARCHITECTURE.md, web_ui/scripts/start.ps1, docs/archive/pre-v3/INDEX.md, plus
the tracked-*.md placeholder scan and the archive citation set. Historical
surfaces (CHANGELOG.md history, docs/adr/*, bench/RESULTS.md, the archived
pre-v3 tree) are OUTSIDE the scan set by design: their stale tokens are true
history or recorded dispositions, guarded instead by the frozen issue-tracer
checks and review gates.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# (regex, what it pins) — case/separator/whitespace-insensitive where the
# defect class varied its spelling (Q5_K_M vs Q5_K-M vs q5_k_m; ~3.1GB vs
# ~3.1 GB).
STALE_TOKENS = [
    (
        r"tinybert",
        "TinyBERT never shipped as the default reranker"
        "(ADR-0001: ettin-reranker-32m-v1 on all surfaces)",
    ),
    (
        r"q5[\s_\-]?k[\s_\-]?m",
        "Q5_K_M was the unmeasured incumbent; the packaged quant is Q4_K_M (ADR-0002, issue #84)",
    ),
    (
        r"smollm3",
        "SmolLM3 no longer ships (ADR-0002 profiles are gemma-4-e2b-it / lfm2.5-vl-450m)",
    ),
    (r"229\s+mb", "the browser GGUF is 2.5 GB on disk (~2.9 GB nominal), not 229 MB"),
    (
        r"~\s*85\s*mb",
        "the staged ettin reranker is ~38 MB (bench/RESULTS.md), not the old TinyBERT ~85 MB",
    ),
    (
        r"~\s*80\s*mb",
        "embedders are bundled (bge-small-en-v1.5 134 MB desktop;"
        " arctic browser), no ~80 MB runtime download",
    ),
    (
        r"~\s*3\.1\s*gb",
        "the Quality GGUF is ~2.9 GB nominal (2.5 GB on disk), not ~3.1 GB",
    ),
]

ENFORCED_FILES = [
    "README.md",
    "INSTALL.md",
    "CONFIGURATION.md",
    "USAGE.md",
]

ARCH_STALE_TERMS = [
    "chromadb",
    "customtkinter",
    "llama-cpp-python",
    "tinybert",
    "doc_qa_app",
]

# Pinned citation repairs from the issue #89 archive move: the archived file
# must reference its co-move sibling by bare name (they share the flat
# docs/archive/pre-v3/ directory), not the old docs/ path.
ARCHIVE = Path("docs/archive/pre-v3")
PINNED_CITATIONS = {
    ARCHIVE / "RAG_PIPELINE_FIXES_PLAN.md": ["security_hardening_guide.md"],
    ARCHIVE / "RAG_PIPELINE_FIXES_PLAN_REVISED.md": ["security_hardening_guide.md"],
    ARCHIVE
    / "final_bug_ledger.md": [
        "documentation_audit.md",
        "packaging_audit.md",
        "build_verification_checklist.md",
        "smoke_test_plan.md",
    ],
    ARCHIVE
    / "postmortem_analysis.md": [
        "documentation_audit.md",
        "build_verification_checklist.md",
        "smoke_test_plan.md",
    ],
}

# Top-level prefixes whose members the ARCHITECTURE.md path-existence gate
# accepts (mirrors the frozen C1 extraction family, extended per plan).
CITABLE_PREFIXES = (
    "desktop/",
    "web_ui/",
    "packtool/",
    "contracts/",
    "docs/",
    "scripts/",
    "bench/",
    "eval/",
    ".github/",
)


def _read(repo_path: str) -> str:
    return (REPO_ROOT / repo_path).read_text(encoding="utf-8", errors="replace")


def _iter_tracked_md():
    out = (
        re.split(r"\r?\n", out.decode("utf-8", "replace").strip())
        if (out := _git_ls_md())
        else []
    )
    return out


def _git_ls_md() -> bytes:
    import subprocess

    proc = subprocess.run(
        ["git", "ls-files", "*.md"],
        cwd=REPO_ROOT,
        capture_output=True,
        check=True,
    )
    return proc.stdout


def test_no_stale_claims_on_enforced_surface():
    hits = []
    for rel in ENFORCED_FILES:
        text = _read(rel)
        for line_no, line in enumerate(text.splitlines(), 1):
            for pattern, why in STALE_TOKENS:
                if re.search(pattern, line, re.IGNORECASE):
                    hits.append(
                        f"{rel}:{line_no}: /{pattern}/ — {why}: {line.strip()[:120]}"
                    )
    assert not hits, "stale doc claims on the enforced surface:\n" + "\n".join(hits)


def test_architecture_doc_describes_shipped_system():
    text = _read("ARCHITECTURE.md")
    stale = [t for t in ARCH_STALE_TERMS if t in text.lower()]
    assert not stale, f"ARCHITECTURE.md carries pre-v3 terms: {stale}"

    cited = set()
    # markdown links: [text](path)
    for match in re.finditer(r"\]\(([^)\s]+)\)", text):
        cited.add(match.group(1))
    # backticked spans
    for match in re.finditer(r"`([^`\n]+)`", text):
        cited.add(match.group(1).strip())
    normalized = set()
    for candidate in cited:
        candidate = candidate.split("#", 1)[0]
        candidate = re.sub(r":\d+$", "", candidate).strip()
        if candidate.startswith(CITABLE_PREFIXES) and (
            candidate.endswith(
                (
                    ".md",
                    ".ts",
                    ".tsx",
                    ".py",
                    ".sql",
                    ".json",
                    ".yaml",
                    ".yml",
                    ".mjs",
                    ".cjs",
                    ".ps1",
                    ".spec",
                    ".mdx",
                )
            )
        ):
            normalized.add(candidate)
    assert (
        len(normalized) >= 12
    ), f"ARCHITECTURE.md cites only {len(normalized)} repo paths (need >= 12)"
    missing = sorted(p for p in normalized if not (REPO_ROOT / p).exists())
    assert not missing, f"ARCHITECTURE.md cites paths that do not exist: {missing}"


def test_start_ps1_model_size_comments_corrected():
    text = _read("web_ui/scripts/start.ps1")
    hits = [
        line
        for line in text.splitlines()
        if re.search(r"229\s+mb", line, re.IGNORECASE)
    ]
    assert not hits, f"start.ps1 still cites the stale 229 MB GGUF: {hits}"


def test_no_fill_in_placeholders_in_tracked_docs():
    hits = []
    for rel in _iter_tracked_md():
        text = (REPO_ROOT / rel).read_text(encoding="utf-8", errors="replace")
        for line_no, line in enumerate(text.splitlines(), 1):
            if "<fill in>" in line:
                hits.append(f"{rel}:{line_no}: {line.strip()[:120]}")
    assert not hits, "'<fill in>' placeholders in tracked docs:\n" + "\n".join(hits)


def test_archive_index_resolves():
    index = _read(str(ARCHIVE / "INDEX.md"))
    basenames = set(re.findall(r"\| ([A-Za-z0-9_.\-/]+\.md) \|", index))
    assert basenames, "archive INDEX.md inventory is empty"
    missing = sorted(b for b in basenames if not (REPO_ROOT / ARCHIVE / b).exists())
    assert not missing, f"INDEX.md lists files not present in {ARCHIVE}: {missing}"


def test_pinned_archive_citations_stay_repaired():
    problems = []
    for rel, siblings in PINNED_CITATIONS.items():
        text = (REPO_ROOT / rel).read_text(encoding="utf-8", errors="replace")
        for sibling in siblings:
            if f"docs/{sibling}" in text:
                problems.append(
                    f"{rel}: still cites docs/{sibling} (co-move sibling — cite bare {sibling})"
                )
            if sibling not in text:
                problems.append(
                    f"{rel}: expected citation of {sibling} missing entirely"
                )
    assert not problems, "archive citation repairs regressed:\n" + "\n".join(problems)
