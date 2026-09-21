"""CI guardrail for the ADR-0002 LLM-profile decision record and the per-model
license review (issue #56).

Validates the committed docs/adr/0002-llm-profiles.md and docs/licenses.md with a
column-aware validator that is strictly stronger than the trace's frozen
acceptance checks: cited tok/s numbers must equal the `decode_tok_s` column of a
matching machine-tagged row in bench/RESULTS.md (the frozen checks only require
the number to appear somewhere on the matching row), and the Gemma license
outcome must be stated inside the "License review outcome" section (the frozen
check accepts it anywhere in the file).

Also pins the consumption surface the decision lands on (the #85 first-run gate
reads docs/licenses.md via desktop/main/index.ts), the corrected license facts in
INSTALL.md, and two tracked drifts with explicit dispositions:
  - the bundled-QGUF quant string still says Q5_K_M while ADR-0002 selects the
    measured Q4_K_M — xfail until #84 re-pins the artifact;
  - desktop/electron-builder.yml copies no docs/ into packaged resources, so the
    wizard's packaged licenses path stays empty until #84 wires packaging.

Negative branches mutate the real documents in memory and assert the validator
rejects each specific mutation, so the guardrail fails on real drift rather than
passing vacuously. Stdlib-only; runs in the plain pytest matrix without the
model stack.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
ADR_REL = "docs/adr/0002-llm-profiles.md"
LICENSES_REL = "docs/licenses.md"
RESULTS_REL = "bench/RESULTS.md"
INSTALL_REL = "INSTALL.md"
INDEX_TS_REL = "desktop/main/index.ts"
BUILDER_REL = "desktop/electron-builder.yml"

REQUIRED_COLUMNS = (
    "profile",
    "model",
    "quant",
    "tok/s",
    "first-token",
    "peak rss",
    "license",
    "risk",
)
PROFILES = ("quality", "fast")
UNMEASURED_NAMES = ("LFM2.5-1.2B-Instruct", "gemma-3-1b-it")
UNMEASURED_RE = re.compile(r"(no recorded rows|unmeasured|not measured|PENDING)", re.I)
MODEL_SLUG_RE = re.compile(r"[a-z0-9]+(?:[.\-][a-z0-9]+)+")
QUANT_RE = re.compile(r"Q[0-9]_K_[MS]")
MACHINE_TAG_RE = re.compile(r"\(machine ([a-z0-9][a-z0-9-]*)\)")
DOWNSTREAM_REFS = ("#62", "#84", "#85")
BLOCKED_LINE_RE = re.compile(
    r"blocked (by|on|until) this (ADR|decision)|blocked until this (ADR )?merge", re.I
)
# Stricter than the frozen check: the outcome must be stated inside the
# "license review outcome" section, not anywhere in the file.
OUTCOME_RE = re.compile(
    r"(bundling is not blocked|does not block|not governed by|no fallback"
    r"|fallback (is|was)? ?not (needed|triggered)|not triggered)",
    re.I,
)
THRESHOLD_RE = re.compile(r"\$10,000,000|10 million", re.I)


def _load(rel: str) -> str:
    return (REPO_ROOT / rel).read_text(encoding="utf-8")


def _norm(label: str) -> str:
    return re.sub(r"[\s_-]+", " ", label.strip().lower())


def _row_cells(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def _is_separator(cells: list[str]) -> bool:
    nonempty = [c for c in cells if c]
    return bool(nonempty) and all(re.fullmatch(r":?-{2,}:?", c) for c in nonempty)


def _pipe_blocks(text: str) -> list[list[str]]:
    lines = text.splitlines()
    blocks, i = [], 0
    while i < len(lines):
        if lines[i].lstrip().startswith("|"):
            j = i
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                j += 1
            blocks.append(lines[i:j])
            i = j
        else:
            i += 1
    return blocks


def _sections(text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    heading, body = None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if heading is not None:
                out.append((heading, "\n".join(body)))
            heading, body = line, []
        elif heading is not None:
            body.append(line)
    if heading is not None:
        out.append((heading, "\n".join(body)))
    return out


def _find_section(text: str, *words: str) -> str | None:
    for heading, body in _sections(text):
        low = heading.lower()
        if all(w in low for w in words):
            return heading + "\n" + body
    return None


def _decision_table(adr_text: str):
    """(header_cells, [row_cells, ...]) of the 8-column decision table."""
    for block in _pipe_blocks(adr_text):
        header_cells = _row_cells(block[0])
        normed = [_norm(c) for c in header_cells]
        if all(any(_norm(lbl) in nc for nc in normed) for lbl in REQUIRED_COLUMNS):
            rows = [
                _row_cells(line)
                for line in block[1:]
                if not _is_separator(_row_cells(line))
            ]
            return header_cells, rows
    return None


def _cell(cells: list[str], header_cells: list[str], label: str) -> str:
    want = _norm(label)
    for idx, hc in enumerate(header_cells):
        if want in _norm(hc):
            return cells[idx] if idx < len(cells) else ""
    return ""


def _bench_native_rows(results_text: str) -> list[dict[str, str]]:
    """Rows of the native llama.cpp results table, keyed by header label."""
    for block in _pipe_blocks(results_text):
        header_cells = _row_cells(block[0])
        labels = [_norm(c) for c in header_cells]
        if "machine" not in labels or "decode tok s" not in labels:
            continue
        rows = []
        for line in block[1:]:
            cells = _row_cells(line)
            if _is_separator(cells):
                continue
            rows.append(dict(zip(labels, cells)))
        return rows
    return []


def _citation_violation(profile: str, row: list[str], header_cells, results_text: str):
    """Column-aware: the cited tok/s number must equal the decode_tok_s column
    of a matching (machine, model, quant) recorded row."""
    model = _cell(row, header_cells, "model")
    quant = _cell(row, header_cells, "quant")
    toks = _cell(row, header_cells, "tok/s")
    qm = QUANT_RE.search(quant)
    tm = MACHINE_TAG_RE.search(" | ".join(row))
    fm = re.search(r"\d+(?:\.\d+)?", toks)
    if not (qm and tm and fm and MODEL_SLUG_RE.search(model.lower())):
        return (
            f"{profile} row missing model slug / Q*_K_* quant / cited tok/s / "
            f"(machine tag): model={model!r} quant={quant!r} tok/s={toks!r}"
        )
    slug = max(MODEL_SLUG_RE.findall(model.lower()), key=len)
    tag, number = tm.group(1), fm.group(0)
    for bench in _bench_native_rows(results_text):
        if bench.get("machine", "").lower() != tag.lower():
            continue
        if slug not in bench.get("model", "").lower():
            continue
        if qm.group(0) != bench.get("quant", ""):
            continue
        try:
            decode = float(bench["decode tok s"])
        except (KeyError, ValueError):
            continue
        if decode == float(number):
            return None
    return (
        f"{profile} row cites tok/s={number} but no recorded bench row with "
        f"machine={tag}, model={slug}, quant={qm.group(0)} has decode_tok_s={number}"
    )


def validate_documents(
    adr_text: str, licenses_text: str, results_text: str
) -> list[str]:
    """All conformance violations; empty list = conforming."""
    v: list[str] = []

    table = _decision_table(adr_text)
    if table is None:
        return [
            f"decision table header missing required columns: {', '.join(REQUIRED_COLUMNS)}"
        ]
    header_cells, rows = table
    for profile in PROFILES:
        prow = [r for r in rows if _cell(r, header_cells, "profile").lower() == profile]
        if not prow:
            v.append(f"decision table missing {profile} row")
            continue
        for row in prow:
            defect = _citation_violation(profile, row, header_cells, results_text)
            if defect:
                v.append(defect)
            if not _cell(row, header_cells, "license"):
                v.append(f"{profile} row license cell empty")
            if not _cell(row, header_cells, "risk"):
                v.append(f"{profile} row risk cell empty")

    if not any(line.strip() == "## Decision" for line in adr_text.splitlines()):
        v.append("no '## Decision' heading")

    lines = adr_text.splitlines()
    hits = [i for i, l in enumerate(lines) if any(n in l for n in UNMEASURED_NAMES)]
    if not hits or not any(
        UNMEASURED_RE.search(lines[j])
        for i in hits
        for j in range(max(0, i - 3), min(len(lines), i + 4))
    ):
        v.append("unmeasured-candidate statement missing")

    outcome_section = _find_section(adr_text, "license review outcome")
    if outcome_section is None:
        v.append("no 'License review outcome' section")
    else:
        if "ai.google.dev/gemma/terms" not in adr_text:
            v.append("missing ai.google.dev/gemma/terms citation")
        if "For Gemma 4 terms" not in adr_text:
            v.append("missing quoted 'For Gemma 4 terms' clause")
        if not (
            "ai.google.dev/gemma/apache_2" in adr_text or "gemma_4_license" in adr_text
        ):
            v.append("missing Gemma 4 license URL")
        if not OUTCOME_RE.search(outcome_section) or not re.search(
            r"outcome", outcome_section, re.I
        ):
            v.append("explicit license-review outcome statement missing")

    for ref in DOWNSTREAM_REFS:
        if ref not in adr_text:
            v.append(f"downstream gate reference missing ({ref})")
    if not BLOCKED_LINE_RE.search(adr_text):
        v.append("downstream blocked-until statement missing")

    if not _find_section(licenses_text, "quality", "profile"):
        v.append("licenses.md missing quality profile section")
    if not _find_section(licenses_text, "fast", "profile"):
        v.append("licenses.md missing fast profile section")
    fast_section = _find_section(licenses_text, "fast", "profile")
    if fast_section and not THRESHOLD_RE.search(fast_section):
        v.append("fast profile section missing LFM1.0 threshold language")
    for kind, needles in (
        ("embedding", ("apache", "Qwen3-Embedding", "ADR-0001")),
        ("reranker", ("apache", "ettin", "ADR-0001")),
    ):
        sec = _find_section(licenses_text, kind)
        if sec is None:
            v.append(f"licenses.md missing {kind} section")
            continue
        for needle in needles:
            if not re.search(re.escape(needle), sec, re.I):
                v.append(f"licenses.md {kind} section missing {needle}")
    for marker in ("TBD", "TODO", "PLACEHOLDER", "FIXME"):
        for name, text in (("ADR", adr_text), ("licenses.md", licenses_text)):
            if re.search(rf"\b{marker}\b", text, re.I):
                v.append(f"placeholder marker {marker} present in {name}")
    return v


# ---------------------------------------------------------------------------
# positive: the committed documents conform
# ---------------------------------------------------------------------------


def test_documents_pass_conformance_validator():
    violations = validate_documents(
        _load(ADR_REL), _load(LICENSES_REL), _load(RESULTS_REL)
    )
    assert violations == [], (
        "ADR-0002/licenses.md conformance violations: %s" % violations
    )


def test_wizard_consumes_licenses_doc_dev_and_packaged():
    ts = _load(INDEX_TS_REL)
    dev = re.search(
        r"path\.join\(root,\s*['\"]docs['\"],\s*['\"]licenses\.md['\"]\)", ts
    )
    packaged = re.search(
        r"path\.join\(process\.resourcesPath,\s*['\"]docs['\"],\s*['\"]licenses\.md['\"]\)",
        ts,
    )
    assert (
        dev and packaged
    ), "licensesPath() must wire docs/licenses.md in dev and packaged"
    assert (
        REPO_ROOT / LICENSES_REL
    ).is_file(), "docs/licenses.md missing from wired path"


def test_install_model_license_facts_corrected():
    install = _load(INSTALL_REL)
    # bge-small-en-v1.5 is MIT (ADR-0001 comparison table), not Apache-2.0.
    assert re.search(
        r"-\s*License:\s*MIT \(see \[docs/licenses\.md\]", install
    ), "INSTALL.md embedding-model license must state MIT with the docs/licenses.md pointer"
    gguf_match = re.search(
        r"### GGUF Model Details(.*?)(?=\n### |\n## )", install, re.S
    )
    gguf_section = gguf_match.group(1) if gguf_match else ""
    assert (
        "Apache-2.0" in gguf_section and "docs/licenses.md" in gguf_section
    ), "INSTALL.md GGUF section must carry the Gemma-4 Apache-2.0 fact + pointer"


@pytest.mark.xfail(
    reason=(
        "ADR-0002 selects the measured Q4_K_M quant; the bundled-artifact strings "
        "(app_paths.py DEFAULT_BUNDLED_GGUF, INSTALL.md, app_gui.py, test pins) "
        "still say Q5_K_M until #84 re-pins packaging"
    ),
    strict=False,
)
def test_install_bundled_quant_matches_adr_decision():
    adr_text = _load(ADR_REL)
    header_cells, rows = _decision_table(adr_text)
    qrow = next(
        r for r in rows if _cell(r, header_cells, "profile").lower() == "quality"
    )
    adr_quant = QUANT_RE.search(_cell(qrow, header_cells, "quant")).group(0)
    install = _load(INSTALL_REL)
    bundled = re.search(r"\*\*Bundled Model\*\*:.*\((Q[0-9]_K_[MS])\)", install)
    assert bundled, "INSTALL.md bundled-model quant string not found"
    assert (
        bundled.group(1) == adr_quant
    ), "bundled quant %s != ADR-0002 decision quant %s" % (bundled.group(1), adr_quant)


def test_packaged_licenses_gap_tracked_until_84():
    """electron-builder.yml copies no docs/ into packaged resources today, so the
    wizard's packaged licensesPath stays empty until #84 wires packaging (ADR-0002
    Consequences 1). When #84 adds that extraResources entry, UPDATE this pin —
    its failure is the signal the packaging contract changed."""
    builder = _load(BUILDER_REL)
    assert not re.search(r"extraResources:[\s\S]*?from:\s*docs\b", builder), (
        "electron-builder.yml now copies docs/ — update ADR-0002 Consequences 1 "
        "and the first-run wizard packaged-path expectations"
    )


# ---------------------------------------------------------------------------
# negative: the validator rejects specific mutations
# ---------------------------------------------------------------------------


def _mutated(text: str, old: str, new: str, count: int = 1) -> str:
    assert text.count(old) >= count, "mutation anchor not found: %r" % old[:60]
    return text.replace(old, new, count)


def test_validator_rejects_tampered_citation_number():
    adr = _load(ADR_REL)
    tampered = _mutated(adr, "| 3.65 tok/s", "| 3.66 tok/s")
    v = validate_documents(tampered, _load(LICENSES_REL), _load(RESULTS_REL))
    assert any("cites tok/s=3.66" in x for x in v), v


def test_validator_rejects_first_token_ms_quoted_as_toks():
    """The column-aware check that the frozen acceptance checks lack: the row's
    first_token_ms value must NOT satisfy the tok/s citation."""
    adr = _load(ADR_REL)
    tampered = _mutated(adr, "| 3.65 tok/s @4 threads", "| 36813 tok/s @4 threads")
    v = validate_documents(tampered, _load(LICENSES_REL), _load(RESULTS_REL))
    assert any("cites tok/s=36813" in x for x in v), v


def test_validator_rejects_missing_decision_heading():
    adr = _mutated(_load(ADR_REL), "## Decision\n", "## Ruling\n")
    v = validate_documents(adr, _load(LICENSES_REL), _load(RESULTS_REL))
    assert any("## Decision" in x for x in v), v


def test_validator_rejects_placeholder_in_licenses():
    lic = _mutated(_load(LICENSES_REL), "## Reranker", "## Reranker (TODO: confirm)")
    v = validate_documents(_load(ADR_REL), lic, _load(RESULTS_REL))
    assert any("placeholder marker TODO" in x for x in v), v


def test_validator_rejects_missing_fast_row():
    adr = _load(ADR_REL)
    header_cells, rows = _decision_table(adr)
    fast_line = next(
        line
        for line in adr.splitlines()
        if line.lstrip().startswith("|")
        and _row_cells(line)
        and _cell(_row_cells(line), header_cells, "profile").lower() == "fast"
    )
    tampered = adr.replace(fast_line + "\n", "")
    v = validate_documents(tampered, _load(LICENSES_REL), _load(RESULTS_REL))
    assert any("missing fast row" in x for x in v), v


def test_validator_rejects_missing_outcome_statement():
    adr = _load(ADR_REL)
    tampered = _mutated(adr, "bundling is not blocked", "bundling is blocked", count=2)
    tampered = _mutated(tampered, "fallback was not needed", "fallback was needed")
    tampered = _mutated(tampered, "clause is NOT triggered", "clause is triggered")
    v = validate_documents(tampered, _load(LICENSES_REL), _load(RESULTS_REL))
    assert any("outcome statement missing" in x for x in v), v


def test_validator_rejects_bare_downstream_mentions():
    adr = _mutated(
        _load(ADR_REL),
        "are blocked until this ADR merges",
        "consume this ADR's decisions",
    )
    v = validate_documents(adr, _load(LICENSES_REL), _load(RESULTS_REL))
    assert any("blocked-until statement missing" in x for x in v), v


def test_validator_rejects_missing_adr0001_crossref():
    lic = _load(LICENSES_REL).replace("ADR-0001", "ADR-000X")
    v = validate_documents(_load(ADR_REL), lic, _load(RESULTS_REL))
    assert any("embedding section missing ADR-0001" in x for x in v), v
    assert any("reranker section missing ADR-0001" in x for x in v), v


def test_validator_rejects_fast_section_without_threshold_language():
    lic = _mutated(
        _load(LICENSES_REL),
        "10 million\n  United States dollars ($10,000,000) or more",
        "the license's revenue threshold",
    )
    v = validate_documents(_load(ADR_REL), lic, _load(RESULTS_REL))
    assert any("threshold language" in x for x in v), v
