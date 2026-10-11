"""Arm's-length acceptance check for issue #156 (row C16) — LFM license record.

Frozen-bytes check spec authored from the issue contract (02-reproduction.md
`## Acceptance checks` row C16 and 01-issue-summary.md AC7). The implementer
codes the fix AGAINST these assertions and never edits this file.

Pinned surface (AC7):
  - docs/licenses.md records LFM Open License v1.0 for BOTH tiers (the
    quality tier lfm2.5-2.6b and the fast tier lfm2-1.2b-rag), with the
    $10,000,000 revenue threshold stated in the QUALITY section (both tiers
    are now LFM-licensed, so the threshold binds the quality tier too).
  - The full license text ships as docs/licenses/LFM-OPEN-LICENSE-v1.0.txt.
  - desktop/scripts/stage-installer-resources.mjs's stageDocs stages that
    file, so packaged builds carry the full text (not just the summary in
    docs/licenses.md).

Plain pytest only: pathlib reads relative to this file, no network, no
imports of application code.
"""

from pathlib import Path
import re

REPO_ROOT = Path(__file__).resolve().parent.parent

LICENSES_MD = REPO_ROOT / "docs" / "licenses.md"
LICENSE_TEXT = REPO_ROOT / "docs" / "licenses" / "LFM-OPEN-LICENSE-v1.0.txt"
STAGER_MJS = REPO_ROOT / "desktop" / "scripts" / "stage-installer-resources.mjs"

QUALITY_ID = "lfm2.5-2.6b"
FAST_ID = "lfm2-1.2b-rag"
LICENSE_NAME = "LFM Open License v1.0"
REVENUE_THRESHOLD = "$10,000,000"


def _read(path: Path) -> str:
    assert path.is_file(), f"required surface missing: {path.relative_to(REPO_ROOT)}"
    return path.read_text(encoding="utf-8")


def _quality_section(licenses_text: str) -> str:
    heading = re.search(r"(?im)^##[^\n]*\bquality\b", licenses_text)
    assert heading is not None, (
        "docs/licenses.md has no quality-tier section heading to pin the "
        "revenue threshold against"
    )
    rest = licenses_text[heading.end():]
    nxt = re.search(r"^## ", rest, re.MULTILINE)
    return rest[: nxt.start()] if nxt else rest


def _stage_docs_body(stager_text: str) -> str:
    start = stager_text.find("function stageDocs")
    assert start != -1, "stageDocs function not found in stage-installer-resources.mjs"
    end = stager_text.find("\n}", start)
    assert end != -1, "stageDocs function body is not terminated at column 0"
    return stager_text[start:end]


def test_licenses_md_records_lfm_open_license_for_both_tiers():
    """AC7: both tiers recorded under LFM Open License v1.0 (C16 first leg).

    The first failing assertion at the pre-fix tree carries the
    ISSUE156-SWAP-NOT-LANDED sentinel so the base failure line is stable.
    """
    licenses_md = _read(LICENSES_MD)
    assert QUALITY_ID in licenses_md, (
        "ISSUE156-SWAP-NOT-LANDED: docs/licenses.md does not record the quality tier lfm2.5-2.6b"
    )
    assert FAST_ID in licenses_md, (
        f"docs/licenses.md does not record the fast tier {FAST_ID}"
    )
    tier_mentions = licenses_md.count(LICENSE_NAME)
    assert tier_mentions >= 2, (
        f"docs/licenses.md mentions {LICENSE_NAME} {tier_mentions} time(s); the "
        "license record must cover BOTH tiers (one record per tier)"
    )


def test_quality_section_states_revenue_threshold():
    quality = _quality_section(_read(LICENSES_MD))
    assert REVENUE_THRESHOLD in quality, (
        "docs/licenses.md QUALITY section does not state the $10,000,000 LFM "
        "revenue threshold; with both tiers LFM-licensed it binds the quality "
        "tier and must be stated there"
    )


def test_full_license_text_file_ships():
    assert LICENSE_TEXT.is_file(), (
        "docs/licenses/LFM-OPEN-LICENSE-v1.0.txt does not exist; the full LFM "
        "Open License v1.0 text must ship alongside the weights"
    )
    assert LICENSE_TEXT.stat().st_size > 0, (
        "docs/licenses/LFM-OPEN-LICENSE-v1.0.txt is empty"
    )


def test_stage_docs_stages_the_license_text():
    body = _stage_docs_body(_read(STAGER_MJS))
    assert "LFM-OPEN-LICENSE-v1.0.txt" in body, (
        "stageDocs does not stage docs/licenses/LFM-OPEN-LICENSE-v1.0.txt; "
        "packaged builds must carry the full license text"
    )
