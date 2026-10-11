"""Arm's-length acceptance check for issue #156 (row C7) — documentation swap.

Frozen-bytes check spec authored from the issue contract (02-reproduction.md
`## Acceptance checks` row C7 and 01-issue-summary.md AC9). The implementer
codes the fix AGAINST these assertions and never edits this file.

Pinned surface (AC9):
  - The retired ids are absent from the CURRENT product docs —
    desktop/README.md, web_ui/public/models/README.md, PACKAGING.md,
    ARCHITECTURE.md, desktop/test/soak/README.md — matching on normalized
    (case-folded) text for both the raw ids (gemma-4-e2b-it,
    lfm2.5-vl-450m) and their display forms (Gemma 4 E2B…, LFM 2.5 VL 450M);
    mmproj mentions are gone from those surfaces too (the multimodal path is
    retired with the models).
  - README.md names BOTH new ids (lfm2.5-2.6b, lfm2-1.2b-rag).
  - INSTALL.md's GGUF-details section pins BOTH directions: the LFM ids for
    the shipped desktop app AND an explicit legacy-Python-harness sentence
    naming Gemma 4 E2B (the legacy harness legitimately retains it).

INSTALL.md and CONFIGURATION.md are deliberately NOT part of the blanket
retired-id scan (they host legacy-Python-harness content); only the pinned
GGUF-section sentence inside INSTALL.md is asserted here.

Plain pytest only: pathlib reads relative to this file, no network, no
imports of application code.
"""

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

RETIRED_SCAN_SURFACES = [
    "desktop/README.md",
    "web_ui/public/models/README.md",
    "PACKAGING.md",
    "ARCHITECTURE.md",
    "desktop/test/soak/README.md",
]
ROOT_README = REPO_ROOT / "README.md"
INSTALL_MD = REPO_ROOT / "INSTALL.md"

QUALITY_ID = "lfm2.5-2.6b"
FAST_ID = "lfm2-1.2b-rag"

# Normalized (case-folded) needles: raw ids, display forms, and the retired
# multimodal projector artifact.
RETIRED_NEEDLES = [
    "gemma-4-e2b-it",
    "lfm2.5-vl-450m",
    "gemma 4 e2b",
    "lfm 2.5 vl 450m",
    "mmproj",
]


def _read(path: Path) -> str:
    assert path.is_file(), f"required surface missing: {path.relative_to(REPO_ROOT)}"
    return path.read_text(encoding="utf-8")


def _install_gguf_section(install_text: str) -> str:
    """The GGUF-details section of INSTALL.md.

    Starts at the first markdown heading whose text mentions GGUF and runs to
    the next heading of the same or shallower level.
    """
    heading = None
    for level, text in re.findall(
        r"^(#{1,6})[ \t]+([^\n]+)$", install_text, re.MULTILINE
    ):
        if "GGUF" in text:
            heading = re.search(
                r"^(#{1,6})[ \t]+" + re.escape(text.strip()) + r"[ \t]*$",
                install_text,
                re.MULTILINE,
            )
            level_num = len(level)
            break
    assert heading is not None, "INSTALL.md has no GGUF-details heading to pin"
    rest = install_text[heading.end() :]
    nxt = re.search(r"^#{1,%d}[ \t]+" % level_num, rest, re.MULTILINE)
    return rest[: nxt.start()] if nxt else rest


def test_retired_ids_absent_from_current_product_docs():
    """AC9: the retired-id doc scan is clean (C7 first leg).

    The first failing assertion at the pre-fix tree carries the
    ISSUE156-SWAP-NOT-LANDED sentinel so the base failure line is stable.
    """
    for rel in RETIRED_SCAN_SURFACES:
        normalized = _read(REPO_ROOT / rel).casefold()
        for needle in RETIRED_NEEDLES:
            assert needle not in normalized, (
                f"ISSUE156-SWAP-NOT-LANDED: retired model references remain in current product docs "
                f"({needle!r} still present in {rel})"
            )


def test_root_readme_names_both_new_ids():
    readme = _read(ROOT_README)
    assert (
        QUALITY_ID in readme
    ), f"README.md does not name the new quality model id {QUALITY_ID}"
    assert FAST_ID in readme, f"README.md does not name the new fast model id {FAST_ID}"


def test_install_gguf_section_pins_both_directions():
    section = _install_gguf_section(_read(INSTALL_MD))
    assert (
        QUALITY_ID in section
    ), f"INSTALL.md GGUF-details section does not name the desktop quality id {QUALITY_ID}"
    assert (
        FAST_ID in section
    ), f"INSTALL.md GGUF-details section does not name the desktop fast id {FAST_ID}"
    legacy_lines = [
        line
        for line in section.splitlines()
        if "gemma 4" in line.casefold()
        and any(marker in line.casefold() for marker in ("legacy", "harness", "python"))
    ]
    assert legacy_lines, (
        "INSTALL.md GGUF-details section lost the explicit legacy-Python-harness "
        "sentence naming Gemma 4 E2B (the legacy harness legitimately retains it)"
    )
