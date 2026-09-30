"""Doc-vs-code accuracy guardrail (issue #89, E6).

Docs are code-adjacent surface with no runtime check: this file pins the
corrected documentation state so the "prose describing a system state that
differs from shipped code" defect class (stale model ids/sizes, dead file
citations, unmarked supersessions) is mechanically detectable on every PR —
including docs-only PRs, which the path-scoped CI buckets skip. It runs in the
always-run doc-accuracy workflow (.github/workflows/doc-accuracy.yml).

Enforced surface (green-by-construction after issue #89 and mutation-sensitive
on exactly the files the issue corrected): README.md, INSTALL.md,
CONFIGURATION.md, USAGE.md, ARCHITECTURE.md, the two new guides
(docs/pack-authoring-guide.md, docs/training-pack-refresh-runbook.md), the
kept v3 product docs (docs/electron-mode.md, docs/training-player.md,
docs/training-transcription.md, docs/updates.md, docs/security/*), PACKAGING.md
(with one line-scoped carve-out for its operator quant-staging guidance), and
web_ui/scripts/start.ps1. CHANGELOG.md history, docs/adr/*, bench/RESULTS.md,
and the archived pre-v3 tree are OUTSIDE the stale-token scan by design — their
stale tokens are true history or recorded dispositions. The CHANGELOG
correction markers ARE guarded in-repo (test_changelog_correction_markers),
and the archive's repaired citations plus its INDEX are guarded below.

Known accepted limits (documented, not oversights): the stale-token patterns
are case/separator/whitespace-insensitive for the spellings the defect class
actually used; novel misspellings need a new pattern. The cite extractor can
miss exotic forms (parenthesised paths, uppercase extensions); path case is
checked case-sensitively because CI is Linux.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# (regex, what it pins) — case/separator/whitespace-insensitive where the
# defect class varied its spelling (Q5_K_M vs Q5_K-M vs q5_k_m; ~3.1GB vs
# ~3.1 GB; 229MB vs 229 MB).
STALE_TOKENS = [
    (
        r"tinybert",
        "TinyBERT never shipped as the default reranker "
        "(ADR-0001: ettin-reranker-32m-v1 on all surfaces)",
    ),
    (
        r"q5[\s_\-]?k[\s_\-]?m",
        "Q5_K_M was the unmeasured incumbent; the packaged "
        "quant is Q4_K_M (ADR-0002, issue #84)",
    ),
    (
        r"smo[\s_\-]?llm[\s_\-]?3",
        "SmolLM3 no longer ships (ADR-0002 profiles are "
        "gemma-4-e2b-it / lfm2.5-vl-450m)",
    ),
    (
        r"229[\s_\-]?mb",
        "the browser GGUF is ~2.6 GB (2,620,370,976 bytes " "measured), not 229 MB",
    ),
    (
        r"~\s*85\s*mb",
        "the staged ettin reranker is ~38 MB total "
        "(bench/RESULTS.md), not the old TinyBERT ~85 MB",
    ),
    (
        r"~\s*80\s*mb",
        "embedders are bundled (bge-small-en-v1.5 134 MB fp32 "
        "desktop; arctic browser), no ~80 MB runtime download",
    ),
    (
        r"~\s*3\.1\s*gb",
        "the Quality GGUF is ~2.9 GB nominal "
        "(2,620,370,976 bytes measured), not ~3.1 GB",
    ),
]

# Per-file line exemptions: lines matching the regex are skipped by the
# stale-token scan (legitimate operator guidance, not drift).
LINE_EXEMPTIONS = {
    "PACKAGING.md": re.compile(r"operators staging a different quant"),
}

ENFORCED_FILES = [
    "README.md",
    "INSTALL.md",
    "CONFIGURATION.md",
    "USAGE.md",
    "docs/pack-authoring-guide.md",
    "docs/training-pack-refresh-runbook.md",
    "docs/electron-mode.md",
    "docs/training-player.md",
    "docs/training-transcription.md",
    "docs/updates.md",
    "docs/security/desktop.md",
    "docs/security/packs.md",
    "PACKAGING.md",
]

# ARCHITECTURE.md pre-v3 stack terms as separator-tolerant regexes.
ARCH_STALE_TERMS = [
    r"chroma[\s_\-]?db",
    r"customtkinter",
    r"llama[\s_\-]?cpp[\s_\-]?python",
    r"tinybert",
    r"doc[\s_\-]?qa[\s_\-]?app",
]

ARCHITECTURE = "ARCHITECTURE.md"

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

ARCHIVE = Path("docs/archive/pre-v3")

# Pinned citation repairs from the issue #89 archive move: the archived file
# must reference its co-move sibling by bare name (they share the flat
# docs/archive/pre-v3/ directory), not the old docs/ path.
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

# CHANGELOG correction markers installed by issue #89 (in-repo guard for the
# never-shipped TinyBERT history): each claim pattern must be followed within
# 6 lines by a marker naming the shipped reranker; the doc-update claims'
# marker must state what never landed.
CHANGELOG_CLAIMS = [
    (r"Added CrossEncoder reranking with TinyBERT", "ettin"),
    (r"Switched to TinyBERT", "ettin"),
    (r"Updated reranking defaults", "never landed"),
]

# INDEX.md prose citations that intentionally reference never-created files
# (historical plans that never materialized — see INDEX Justifications).
INDEX_NEVER_CREATED = {
    "docs/deferred_issues.md",
    "docs/architecture_decisions/adr-001-dead-code.md",
}


def _read(repo_path: str) -> str:
    return (REPO_ROOT / repo_path).read_text(encoding="utf-8", errors="replace")


def _git_ls_md():
    import subprocess

    proc = subprocess.run(
        ["git", "ls-files", "*.md"],
        cwd=REPO_ROOT,
        capture_output=True,
        check=True,
    )
    out = proc.stdout.decode("utf-8", "replace").strip()
    return re.split(r"\r?\n", out) if out else []


def test_stale_token_patterns_are_alive():
    """Negative probe (PRR-011): every pattern must match a synthetic stale
    sample and none must match a clean sample — the guard cannot silently go
    vacuous through a bad pattern edit."""
    stale_samples = {
        r"tinybert": "the old TinyBERT weights",
        r"q5[\s_\-]?k[\s_\-]?m": "Gemma Q5_K_M",
        r"smo[\s_\-]?llm[\s_\-]?3": "SmolLM3-3B weights",
        r"229[\s_\-]?mb": "a 229MB GGUF and a 229-MB variant",
        r"~\s*85\s*mb": "~85MB reranker",
        r"~\s*80\s*mb": "~ 80 MB download",
        r"~\s*3\.1\s*gb": "~3.1GB model",
    }
    clean_sample = "128 MB of tokenizers and 134,098,874 bytes of fp32 weights"
    for pattern, _ in STALE_TOKENS:
        assert re.search(pattern, stale_samples[pattern], re.IGNORECASE), (
            f"pattern {pattern!r} no longer matches its stale sample — the "
            "guard has gone vacuous"
        )
        assert not re.search(pattern, clean_sample, re.IGNORECASE), (
            f"pattern {pattern!r} matches the clean sample — it would "
            "false-positive on every enforced file"
        )


def test_no_stale_claims_on_enforced_surface():
    hits = []
    for rel in ENFORCED_FILES:
        text = _read(rel)
        exemption = LINE_EXEMPTIONS.get(rel)
        for line_no, line in enumerate(text.splitlines(), 1):
            if exemption is not None and exemption.search(line):
                continue
            for pattern, why in STALE_TOKENS:
                if re.search(pattern, line, re.IGNORECASE):
                    hits.append(
                        f"{rel}:{line_no}: /{pattern}/ — {why}: "
                        f"{line.strip()[:120]}"
                    )
    assert not hits, "stale doc claims on the enforced surface:\n" + "\n".join(hits)


def test_architecture_doc_describes_shipped_system():
    text = _read(ARCHITECTURE)
    stale = [t for t in ARCH_STALE_TERMS if re.search(t, text, re.IGNORECASE)]
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
        candidate = candidate.rstrip(".,;:")  # trailing prose punctuation
        if candidate.startswith(CITABLE_PREFIXES) and candidate.endswith(
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
        if re.search(r"229[\s_\-]?mb", line, re.IGNORECASE)
    ]
    assert not hits, f"start.ps1 still cites the stale 229 MB GGUF: {hits}"


def test_no_fill_in_placeholders_in_tracked_docs():
    hits = []
    for rel in _git_ls_md():
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
    # Prose citations in INDEX.md must resolve, except the documented
    # never-created historical targets.
    prose_targets = set(re.findall(r"docs/[A-Za-z0-9_./\-]+\.md", index))
    bad = sorted(
        t
        for t in prose_targets
        if t not in INDEX_NEVER_CREATED and not (REPO_ROOT / t).exists()
    )
    assert not bad, f"INDEX.md prose cites non-existent paths: {bad}"


def test_pinned_archive_citations_stay_repaired():
    problems = []
    for rel, siblings in PINNED_CITATIONS.items():
        text = (REPO_ROOT / rel).read_text(encoding="utf-8", errors="replace")
        for sibling in siblings:
            if f"docs/{sibling}" in text:
                problems.append(
                    f"{rel}: still cites docs/{sibling} "
                    "(co-move sibling — cite bare "
                    f"{sibling})"
                )
            if sibling not in text:
                problems.append(
                    f"{rel}: expected citation of {sibling} missing entirely"
                )
    assert not problems, "archive citation repairs regressed:\n" + "\n".join(problems)


def test_no_archive_file_cites_another_by_old_path():
    """Generalization of the pinned set (PRR-006): NO archived file may cite
    another archived member by its old docs/ path — co-move siblings are
    flat neighbours under docs/archive/pre-v3/."""
    members = sorted(p for p in ARCHIVE.rglob("*.md"))
    basenames = {p.name for p in members}
    problems = []
    for member in members:
        text = member.read_text(encoding="utf-8", errors="replace")
        for match in re.finditer(r"docs/([A-Za-z0-9_.\-/]+\.md)", text):
            cited = match.group(1)
            if Path(cited).name in basenames:
                problems.append(
                    f"{member}: cites archived sibling by old path " f"docs/{cited}"
                )
    assert (
        not problems
    ), "archive files cite co-move siblings by old docs/ paths:\n" + "\n".join(problems)


def test_changelog_correction_markers_present():
    """In-repo guard for the issue #89 CHANGELOG corrections: each named
    TinyBERT-era claim carries a `Correction` marker within 6 lines naming the
    shipped ettin reranker; the doc-update claims' marker states what never
    landed (the frozen trace check covers this too — this is the tracked,
    always-CI copy)."""
    text = _read("CHANGELOG.md")
    lines = text.splitlines()
    problems = []
    for pattern, required_token in CHANGELOG_CLAIMS:
        for i, line in enumerate(lines):
            if re.search(pattern, line):
                window = "\n".join(lines[i : i + 7])
                if "Correction" not in window and "CORRECTED" not in window:
                    problems.append(
                        f"CHANGELOG.md:{i + 1}: claim /{pattern}/ has no "
                        "Correction marker within 6 lines"
                    )
                elif required_token == "ettin" and "ettin" not in window:
                    problems.append(
                        f"CHANGELOG.md:{i + 1}: correction does not name the "
                        "shipped ettin reranker"
                    )
                elif required_token == "never landed" and "never landed" not in window:
                    problems.append(
                        f"CHANGELOG.md:{i + 1}: correction does not state the "
                        "updates never landed"
                    )
    # Residual: any TinyBERT default-on claim needs a correction nearby.
    for i, line in enumerate(lines):
        if re.search(r"TinyBERT", line, re.IGNORECASE) and re.search(
            r"enabled by default|default ON", line, re.IGNORECASE
        ):
            window = "\n".join(lines[i : i + 7])
            if "Correction" not in window and "CORRECTED" not in window:
                problems.append(
                    f"CHANGELOG.md:{i + 1}: TinyBERT default-on claim without "
                    "a nearby correction"
                )
    assert not problems, "CHANGELOG corrections drifted:\n" + "\n".join(problems)
