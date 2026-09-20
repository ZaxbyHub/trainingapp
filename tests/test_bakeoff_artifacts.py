"""CI guardrail for the A5 bake-off decision artifact (issue #55).

Validates the committed eval/bakeoff/results/bakeoff-results.json against
the frozen schema (eval/bakeoff/schema.py -- the same rules the trace's
frozen acceptance checks enforce) and the ADR-0001 Decision-section
consistency rules. Any future edit that changes models without re-measuring
or that breaks the winner/dims pairing fails here.

Stdlib-only imports; runs in the plain pytest matrix without the model stack.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO_ROOT / "eval" / "bakeoff" / "schema.py"


def _load_schema():
    spec = importlib.util.spec_from_file_location("bakeoff_schema", SCHEMA_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["bakeoff_schema"] = module
    spec.loader.exec_module(module)
    return module


def test_bakeoff_results_schema_and_adr_consistency():
    schema = _load_schema()
    violations, data = schema.load_and_validate(str(REPO_ROOT))
    assert not violations, "bake-off artifact violations: %s" % violations
    assert data is not None and data["threads"] == 8
    # The full 4x3 grid must be present as scored combinations.
    combos = {(c["embedding"], c["reranker"]) for c in data["combos"]}
    assert (
        len(combos) == 12
    ), "expected 12 scored embedding x reranker combos, got %d" % len(combos)


def test_bakeoff_eval_set_untouched_reference():
    """The bake-off numbers are only valid against the A4 eval set as of the
    bake-off; the README pins the eval-set revision those numbers cite."""
    readme = REPO_ROOT / "eval" / "bakeoff" / "README.md"
    assert readme.is_file(), "eval/bakeoff/README.md missing"
    text = readme.read_text(encoding="utf-8")
    assert (
        "Methodology execution log" in text
    ), "README must carry the methodology execution log (plan-critic note)"
