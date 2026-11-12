"""Text normalization vectors: the Python twin matches the shared contract (issue #281 E-AC6).

The Python twin (contracts/tests/store-interop/normalize_search.py) must produce
exactly each vector's expected string in contracts/text-normalization-vectors.json.
Stdlib only (runs in the security job's Audit guards step).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
VECTORS = REPO_ROOT / "contracts" / "text-normalization-vectors.json"
TWIN_DIR = REPO_ROOT / "contracts" / "tests" / "store-interop"

sys.path.insert(0, str(TWIN_DIR))
from normalize_search import normalize_search  # noqa: E402

REQUIRED_IDS = (
    "soft-hyphen-word",
    "soft-hyphen-only",
    "zwsp-word",
    "zwnj",
    "zwj",
    "word-joiner",
    "bom",
    "ligature-fl",
    "ligature-ffi",
    "fullwidth-letter",
    "fullwidth-word",
    "fullwidth-quote",
    "superscript",
    "en-dash",
    "em-dash",
    "hyphen-bullet",
    "minus-sign",
    "curly-quotes",
    "double-quotes",
    "ellipsis",
    "nbsp",
    "narrow-nbsp",
    "mixed-variant-word",
    "greek-preserved",
    "cjk-preserved",
    "whitespace-collapse",
    "ignorable-only-with-space",
    "dash-run",
    "nel-kept",
    "file-sep-kept",
    "nel-leading-kept",
    "file-sep-trailing-kept",
    "class-boundary-trimmed",
)


def _corpus() -> dict:
    return json.loads(VECTORS.read_text(encoding="utf-8"))


def test_corpus_shape_and_required_families():
    corpus = _corpus()
    assert corpus.get("version") == 1, "vector file version must be 1"
    vectors = corpus.get("vectors", [])
    assert (
        len(vectors) >= 33
    ), f"contract floor is 33 vectors, file carries {len(vectors)}"
    ids = [v["id"] for v in vectors]
    assert len(ids) == len(
        set(ids)
    ), "duplicate vector ids would silently halve a family"
    missing = [rid for rid in REQUIRED_IDS if rid not in set(ids)]
    assert missing == [], f"missing required vector families: {missing}"


@pytest.mark.parametrize(
    "vector",
    _corpus()["vectors"],
    ids=lambda v: v["id"],
)
def test_python_twin_matches_each_vector(vector):
    assert (
        normalize_search(vector["input"]) == vector["expected"]
    ), f"python twin diverges on vector {vector['id']}: {vector['note']}"
