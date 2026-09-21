"""CI guardrail for the A5 bake-off decision artifact (issue #55).

Validates the committed eval/bakeoff/results/bakeoff-results.json against the
frozen schema (eval/bakeoff/schema.py -- the same rules the trace's frozen
acceptance checks enforce) and the ADR-0001 Decision-section consistency
rules. Also pins the A4 eval-set identity (sha256 manifest) and exercises the
schema's negative branches plus collect.py's refusal path, so the guardrail
fails on real drift rather than passing vacuously.

Stdlib-only imports; runs in the plain pytest matrix without the model stack.
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO_ROOT / "eval" / "bakeoff" / "schema.py"
RESULTS_REL = "eval/bakeoff/results/bakeoff-results.json"


def _load_schema():
    spec = importlib.util.spec_from_file_location("bakeoff_schema", SCHEMA_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["bakeoff_schema"] = module
    spec.loader.exec_module(module)
    return module


def _load_results():
    return json.loads((REPO_ROOT / RESULTS_REL).read_text(encoding="utf-8"))


def test_bakeoff_results_schema_and_adr_consistency():
    schema = _load_schema()
    violations, data = schema.load_and_validate(str(REPO_ROOT))
    assert not violations, "bake-off artifact violations: %s" % violations
    assert data is not None and data["threads"] == 8
    # The full 4x3 grid must be present as scored combinations: every exact
    # (embedding, reranker) pair, not merely a count of unique pairs.
    expected_pairs = {
        (embedding, reranker)
        for embedding in schema.EMBEDDING_IDS
        for reranker in (schema.ETTIN_NAME, schema.MINILM_ID, schema.BGE_RERANKER_ID)
    }

    # normalize the org-qualified ettin spelling used in combos to the
    # schema's canonical constant before comparing
    def _norm(pair):
        embedding, reranker = pair
        if reranker.endswith("/" + schema.ETTIN_NAME):
            reranker = schema.ETTIN_NAME
        return (embedding, reranker)

    actual_pairs = {_norm((c["embedding"], c["reranker"])) for c in data["combos"]}
    assert (
        actual_pairs == expected_pairs
    ), "scored combos drift from the full 4x3 grid: missing=%s extra=%s" % (
        sorted(expected_pairs - actual_pairs),
        sorted(actual_pairs - expected_pairs),
    )


def test_bakeoff_eval_set_matches_committed_manifest():
    """The bake-off numbers are only valid for the exact A4 eval set they were
    measured against; the committed sha256 manifest pins that set."""
    manifest = json.loads(
        (REPO_ROOT / "eval/bakeoff/results/eval-set-hashes.json").read_text(
            encoding="utf-8"
        )
    )
    assert manifest, "eval-set hash manifest is empty"
    for rel, expected in sorted(manifest.items()):
        path = REPO_ROOT / rel
        assert path.is_file(), "pinned eval-set file missing: %s" % rel
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        assert digest == expected, "eval-set file changed since the bake-off: %s" % rel


def test_schema_rejects_drifted_artifacts():
    """Negative cases: each mutation below must produce at least one violation,
    proving the schema branches are live rather than passing vacuously."""
    schema = _load_schema()
    data = _load_results()

    def violated(mutated):
        return schema.validate_results(mutated, "mutated")

    # threads pin
    mutated = copy.deepcopy(data)
    mutated["threads"] = 4
    assert any("threads" in v for v in violated(mutated))
    # missing candidate
    mutated = copy.deepcopy(data)
    del mutated["embeddings"]["Qwen/Qwen3-Embedding-0.6B"]
    assert any("Qwen/Qwen3-Embedding-0.6B" in v for v in violated(mutated))
    # placeholder license
    mutated = copy.deepcopy(data)
    mutated["rerankers"][schema.MINILM_ID]["license"] = "TBD"
    assert any("license" in v for v in violated(mutated))
    # out-of-range metric
    mutated = copy.deepcopy(data)
    mutated["embeddings"][schema.EMBEDDING_IDS[0]]["quality"]["recall@5"] = 1.5
    assert any("recall@5" in v for v in violated(mutated))
    # non-positive cpu latency
    mutated = copy.deepcopy(data)
    first_reranker = next(iter(mutated["rerankers"]))
    mutated["rerankers"][first_reranker]["cpu"]["top15_ms_p50"] = 0
    assert any("top15_ms_p50" in v for v in violated(mutated))
    # wrong dims type
    mutated = copy.deepcopy(data)
    mutated["embeddings"][schema.EMBEDDING_IDS[0]]["dims"] = "384"
    assert any("dims" in v for v in violated(mutated))
    # duplicate combo entries (the set-based count check would miss this)
    mutated = copy.deepcopy(data)
    mutated["combos"].append(copy.deepcopy(mutated["combos"][0]))
    unique_pairs = {(c["embedding"], c["reranker"]) for c in mutated["combos"]}
    assert len(mutated["combos"]) > len(unique_pairs)


def test_adr_consistency_rejects_dims_drift():
    schema = _load_schema()
    data = _load_results()
    adr_text = (REPO_ROOT / "docs/adr/0001-embedding-reranker.md").read_text(
        encoding="utf-8"
    )
    assert not schema.validate_adr_consistency(adr_text, data)

    # drift the embedding the ADR actually names in its Decision section
    decision_bodies = [
        body
        for title, body in schema._level2_sections(
            (REPO_ROOT / "docs/adr/0001-embedding-reranker.md").read_text(
                encoding="utf-8"
            )
        )
        if title == "Decision"
    ]
    decision = decision_bodies[0]
    winner = next(cid for cid in schema.EMBEDDING_IDS if cid in decision)
    true_dims = data["embeddings"][winner]["dims"]
    drifted = json.loads(json.dumps(data))
    drifted["embeddings"][winner]["dims"] = true_dims + 1
    assert schema.validate_adr_consistency(
        adr_text, drifted
    ), "ADR consistency must fail when the recorded dims drift from the ADR"


def test_collect_refuses_schema_violations(tmp_path):
    """collect.main must refuse to write when the merged artifact would violate
    the schema (the refusal path is load-bearing for the decision artifact)."""
    collect_path = REPO_ROOT / "eval" / "bakeoff" / "collect.py"
    spec = importlib.util.spec_from_file_location("bakeoff_collect", collect_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["bakeoff_collect"] = module
    spec.loader.exec_module(module)

    quality = _load_results()
    quality["threads"] = 4  # schema violation injected at the source
    for record in quality["rerankers"].values():
        record.setdefault("summary_basis", "test")  # collect reads this key
    quality_path = tmp_path / "quality.json"
    cost_path = tmp_path / "cost.json"
    meta_path = tmp_path / "meta.json"
    quality_path.write_text(json.dumps(quality), encoding="utf-8")

    # Build a minimal cost/meta pair consistent with the quality artifact.
    cost = {
        "rows": {
            hf_id: {
                "top15_ms_p50": 1.0,
                "top30_ms_p50": 2.0,
                "onnx": "x",
                "onnx_quant": "test",
            }
            for hf_id in list(quality["embeddings"]) + list(quality["rerankers"])
        }
    }
    cost_path.write_text(json.dumps(cost), encoding="utf-8")
    meta = {
        hf_id: {"license": record["license"], "revision": "test"}
        for hf_id, record in quality["provenance"].items()
    }
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    out_path = tmp_path / "out.json"
    rc = module.main(
        [
            "--quality",
            str(quality_path),
            "--cost",
            str(cost_path),
            "--meta",
            str(meta_path),
            "--out",
            str(out_path),
        ]
    )
    assert rc == 1, "collect must refuse schema-violating inputs"
    assert not out_path.exists(), "collect must not write the artifact on refusal"


def test_thread_cap_constants():
    """Pin the two thread constants: the stock #52 driver keeps its 4-thread
    default; the bake-off pins 8 (end-user CPU profile) and passes it
    explicitly."""
    bench_spec = importlib.util.spec_from_file_location(
        "onnx_bench_driver", REPO_ROOT / "bench" / "onnx_bench_driver.py"
    )
    bench = importlib.util.module_from_spec(bench_spec)
    sys.modules["onnx_bench_driver"] = bench
    bench_spec.loader.exec_module(bench)
    assert bench.THREADS == 4

    candidates_spec = importlib.util.spec_from_file_location(
        "bakeoff_candidates", REPO_ROOT / "eval" / "bakeoff" / "candidates.py"
    )
    candidates = importlib.util.module_from_spec(candidates_spec)
    sys.modules["bakeoff_candidates"] = candidates
    candidates_spec.loader.exec_module(candidates)
    assert candidates.THREADS == 8


@pytest.mark.parametrize(
    "rel",
    [
        "eval/bakeoff/results/bakeoff-results.json",
        "eval/bakeoff/results/eval-set-hashes.json",
        "eval/bakeoff/results/assets-meta.json",
    ],
)
def test_committed_provenance_files_present(rel):
    assert (REPO_ROOT / rel).is_file(), (
        "committed provenance artifact missing: %s" % rel
    )
