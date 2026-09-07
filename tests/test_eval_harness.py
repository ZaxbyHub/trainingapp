"""Tier-0 eval harness unit tests (issue #54).

Mirrors the frozen acceptance checks: question-set schema, runner metric
math, the strict abstain policy, report rendering, and the deterministic
backend's embedder behavior. No server boots here — the integration file
and the CI eval-report job cover the end-to-end path.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
EVAL_DIR = REPO_ROOT / "eval"
QUESTIONS_PATH = EVAL_DIR / "questions.jsonl"
README_PATH = EVAL_DIR / "README.md"

GREETING_KEYWORDS = {
    "hello",
    "hi",
    "hey",
    "greetings",
    "good morning",
    "good afternoon",
    "good evening",
    "howdy",
    "what's up",
}


def _load_module(name: str, relpath: str):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / relpath)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


runner = _load_module("eval_runner", "eval/runner.py")
ci_serve = _load_module("eval_ci_serve", "eval/ci_serve.py")


def _load_rows():
    rows = []
    for line in QUESTIONS_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            rows.append(json.loads(line))
    return rows


class TestQuestionSetSchema:
    def test_row_count_in_contract_range(self):
        assert 50 <= len(_load_rows()) <= 80

    def test_header_documents_schema_and_followup(self):
        text = QUESTIONS_PATH.read_text(encoding="utf-8")
        header = "\n".join(
            line for line in text.splitlines()[:30] if line.startswith("#")
        )
        assert "expected_training_slide_id" in header
        assert "#77" in header or "follow-up" in header.lower()

    def test_unique_ids(self):
        ids = [row["id"] for row in _load_rows()]
        assert len(set(ids)) == len(ids)

    def test_required_fields(self):
        for row in _load_rows():
            for key in ("id", "question", "expected_doc_id", "category"):
                assert key in row, f"{row.get('id')}: missing {key}"
            assert isinstance(row["question"], str) and row["question"].strip()

    def test_out_of_corpus_rows_consistent(self):
        rows = _load_rows()
        ooc = [r for r in rows if r["expected_doc_id"] is None]
        assert len(ooc) >= 5
        for row in ooc:
            assert row["category"] == "out-of-corpus"
        for row in rows:
            if row["expected_doc_id"] is not None:
                assert row["category"] != "out-of-corpus"

    def test_every_expected_doc_exists_in_corpus(self):
        for row in _load_rows():
            if row["expected_doc_id"] is not None:
                assert (EVAL_DIR / "corpus" / row["expected_doc_id"]).is_file(), row[
                    "id"
                ]

    def test_categories_documented_in_readme(self):
        readme = README_PATH.read_text(encoding="utf-8")
        for row in _load_rows():
            assert row["category"] in readme, row["id"]

    def test_no_question_starts_with_greeting_keyword(self):
        # rag_engine.py short-circuits greetings before retrieval; such a
        # question would measure nothing.
        for row in _load_rows():
            first = row["question"].strip().lower()
            assert not any(
                first == kw or first.startswith(kw + " ") for kw in GREETING_KEYWORDS
            ), row["id"]


class TestSourceMatching:
    def test_exact_match(self):
        assert runner.source_matches("travel-policy.md", "travel-policy.md")

    def test_final_path_component_match(self):
        assert runner.source_matches("docs/travel-policy.md", "travel-policy.md")
        assert runner.source_matches("docs\\travel-policy.md", "travel-policy.md")

    def test_no_match(self):
        assert not runner.source_matches("other-doc.md", "travel-policy.md")

    def test_rank_first_occurrence(self):
        sources = ["a.md", "sub/b.md", "travel-policy.md"]
        assert runner.rank_of_expected(sources, "b.md") == 2
        assert runner.rank_of_expected(sources, "missing.md") == 0


class TestAbstainPolicy:
    def test_empty_sources_is_abstain(self):
        assert runner.is_abstain([], "I couldn't find any relevant information.")

    def test_nonempty_sources_is_not_abstain(self):
        assert not runner.is_abstain(["travel-policy.md"], "Some answer.")

    def test_cancelled_is_not_abstain(self):
        assert not runner.is_abstain([], "[Cancelled]")

    def test_fallback_phrase_with_sources_flagged_separately(self):
        answer = "I couldn't find any relevant information in the documents."
        assert runner.is_fallback_phrase_answer(["doc.md"], answer)
        # ...and it is NOT an abstain (strict sources-empty rule)
        assert not runner.is_abstain(["doc.md"], answer)

    def test_fallback_phrase_without_sources_not_flagged(self):
        answer = "I couldn't find any relevant information in the documents."
        assert not runner.is_fallback_phrase_answer([], answer)


class TestPercentile:
    def test_single_value(self):
        assert runner.percentile([5.0], 50) == 5.0

    def test_p50_median(self):
        assert runner.percentile([1.0, 2.0, 3.0, 4.0], 50) == 2.5

    def test_p95_interpolates(self):
        vals = [float(i) for i in range(1, 101)]
        assert runner.percentile(vals, 95) == pytest.approx(95.05)

    def test_empty(self):
        assert runner.percentile([], 50) == 0.0


class TestQuestionFilePrevalidation:
    def test_missing_file_exits_2(self, tmp_path):
        with pytest.raises(SystemExit) as excinfo:
            runner.load_questions(tmp_path / "nope.jsonl")
        assert excinfo.value.code == 2

    def test_fewer_than_five_ooc_exits_2(self, tmp_path):
        path = tmp_path / "questions.jsonl"
        lines = ["# header note about expected_training_slide_id follow-up (#77)"]
        for i in range(55):
            ooc = i >= 52  # only 3 out-of-corpus rows
            lines.append(
                json.dumps(
                    {
                        "id": f"q{i:02d}",
                        "question": f"question {i}?",
                        "expected_doc_id": None if ooc else "doc.md",
                        "category": "out-of-corpus" if ooc else "policy",
                    }
                )
            )
        path.write_text("\n".join(lines), encoding="utf-8")
        with pytest.raises(SystemExit) as excinfo:
            runner.load_questions(path)
        assert excinfo.value.code == 2


class TestReportRendering:
    def _sample_report(self):
        return {
            "schema": "eval-report/1",
            "base_url": "http://127.0.0.1:9999",
            "timestamp": "2026-09-07T00:00:00+00:00",
            "label": "test-label",
            "question_count": 56,
            "in_corpus_count": 50,
            "out_of_corpus_count": 6,
            "error_count": 0,
            "fallback_count": 1,
            "backend_stats": {"embedding_model": "x", "llm_backend": "y"},
            "metrics": {
                "recall_at_k": {"1": 0.5, "3": 0.7, "5": 0.8},
                "mrr": 0.6,
                "abstain_accuracy": 0.5,
                "abstain_total": 6,
                "abstain_hits": 3,
                "latency_ms": {"p50": 10.0, "p95": 20.0, "mean": 12.0},
            },
            "per_category": {"policy": {"count": 7, "recall_at_3": 0.9, "mrr": 0.8}},
            "results": [
                {
                    "id": "q51",
                    "category": "out-of-corpus",
                    "expected_doc_id": None,
                    "latency_ms": 5.0,
                    "error": None,
                    "sources": [],
                    "answer": "abstain",
                    "abstained": True,
                    "fallback_phrase": False,
                    "rank": None,
                }
            ],
        }

    def test_markdown_contains_header_and_metric_families(self):
        md = runner.render_markdown(self._sample_report())
        assert "http://127.0.0.1:9999" in md
        assert "2026-09-07T00:00:00+00:00" in md
        lowered = md.lower()
        for token in ("recall", "mrr", "abstain", "latency"):
            assert token in lowered

    def test_markdown_lists_abstain_rows(self):
        md = runner.render_markdown(self._sample_report())
        assert "q51" in md


class TestStubEmbedder:
    def test_deterministic_same_text_same_vector(self):
        import numpy as np

        v1 = ci_serve._hash_vector("What is the mileage rate for travel?")
        v2 = ci_serve._hash_vector("What is the mileage rate for travel?")
        assert v1.shape == (ci_serve.EMBEDDING_DIM,)
        assert np.array_equal(v1, v2)

    def test_separable_for_zero_token_overlap(self):
        import numpy as np

        # Zero token overlap after stopword filtering + plural folding:
        # separability is only guaranteed there (feature hashing collides on
        # shared tokens by design).
        a = ci_serve._hash_vector("mileage reimbursement travel")
        b = ci_serve._hash_vector("defibrillator evacuation extinguisher")
        assert float(np.dot(a, b)) < 0.5

    def test_stopwords_only_text_is_zero_vector(self):
        import numpy as np

        v = ci_serve._hash_vector("the is of and to")
        assert float(np.linalg.norm(v)) == 0.0

    def test_plural_folding_matches(self):
        a = ci_serve._hash_vector("keyboard")
        b = ci_serve._hash_vector("keyboards")
        assert float(a @ b) == pytest.approx(1.0)


class _FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _FakeClient:
    """Scripted httpx.Client stand-in driving runner.run_eval deterministically."""

    def __init__(self, scripted):
        self._scripted = scripted  # question text -> (status, payload)

    def get(self, path, timeout=None):
        if path.endswith("/health"):
            return _FakeResponse(200, {"status": "ok", "engine_ready": True})
        if path.endswith("/stats"):
            return _FakeResponse(200, {"embedding_model": "fake-embed"})
        raise AssertionError(f"unexpected GET {path}")

    def post(self, path, json=None, timeout=None):
        status, payload = self._scripted[json["question"]]
        return _FakeResponse(status, payload)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestRunEvalMetricMath:
    """Drives runner.run_eval end to end with scripted responses and asserts
    the EXACT metric values, so any regression in the recall@k / MRR /
    abstain-accuracy formulas (e.g. an off-by-one denominator) fails here."""

    @pytest.fixture()
    def report(self, monkeypatch):
        questions = [
            {
                "id": "q1",
                "question": "q1 text",
                "expected_doc_id": "docA.md",
                "expected_page": None,
                "expected_training_slide_id": None,
                "category": "policy",
            },
            {
                "id": "q2",
                "question": "q2 text",
                "expected_doc_id": "docB.md",
                "expected_page": None,
                "expected_training_slide_id": None,
                "category": "policy",
            },
            {
                "id": "q3",
                "question": "q3 text",
                "expected_doc_id": "docA.md",
                "expected_page": None,
                "expected_training_slide_id": None,
                "category": "policy",
            },
            {
                "id": "q4",
                "question": "q4 text",
                "expected_doc_id": None,
                "expected_page": None,
                "expected_training_slide_id": None,
                "category": "out-of-corpus",
            },
            {
                "id": "q5",
                "question": "q5 text",
                "expected_doc_id": None,
                "expected_page": None,
                "expected_training_slide_id": None,
                "category": "out-of-corpus",
            },
            {
                "id": "q6",
                "question": "q6 text",
                "expected_doc_id": "docC.md",
                "expected_page": None,
                "expected_training_slide_id": None,
                "category": "policy",
            },
        ]
        # Hand-computed expectations:
        #   q1: rank 2 (hit for k>=2)   q2: rank 1 (hit)   q3: rank 0 (miss;
        #   fallback-phrase answer with non-empty sources -> fallback_count)
        #   q4: sources [] -> abstain HIT   q5: retrieved noise -> abstain MISS
        #   q6: HTTP 500 -> error row, excluded from every denominator
        # recall@1 = 1/3, recall@3 = 2/3, recall@5 = 2/3
        # MRR = (0.5 + 1.0 + 0.0) / 3 = 0.5 ; abstain = 1/2
        scripted = {
            "q1 text": (
                200,
                {
                    "question": "q1 text",
                    "answer": "ans1",
                    "sources": ["docB.md", "docA.md"],
                    "context_length": 10,
                    "inference_time": 0.1,
                },
            ),
            "q2 text": (
                200,
                {
                    "question": "q2 text",
                    "answer": "ans2",
                    "sources": ["docB.md", "docC.md"],
                    "context_length": 10,
                    "inference_time": 0.1,
                },
            ),
            "q3 text": (
                200,
                {
                    "question": "q3 text",
                    "answer": "I couldn't find any relevant "
                    "information in the documents.",
                    "sources": ["docC.md", "docB.md"],
                    "context_length": 10,
                    "inference_time": 0.1,
                },
            ),
            "q4 text": (
                200,
                {
                    "question": "q4 text",
                    "answer": "I couldn't find any relevant "
                    "information in the documents.",
                    "sources": [],
                    "context_length": 0,
                    "inference_time": 0.1,
                },
            ),
            "q5 text": (
                200,
                {
                    "question": "q5 text",
                    "answer": "noise answer",
                    "sources": ["docA.md"],
                    "context_length": 10,
                    "inference_time": 0.1,
                },
            ),
            "q6 text": (500, {"detail": "boom"}),
        }

        def fake_client():
            return _FakeClient(scripted)

        monkeypatch.setattr(runner.httpx, "Client", fake_client)
        return runner.run_eval(
            base_url="http://fake",
            questions=questions,
            n_results=10,
            timeout=5.0,
            label="unit-test",
        )

    def test_recall_at_k_exact(self, report):
        assert report["metrics"]["recall_at_k"] == {
            "1": pytest.approx(1 / 3),
            "3": pytest.approx(2 / 3),
            "5": pytest.approx(2 / 3),
        }

    def test_mrr_exact(self, report):
        assert report["metrics"]["mrr"] == pytest.approx(0.5)

    def test_abstain_exact(self, report):
        assert report["metrics"]["abstain_total"] == 2
        assert report["metrics"]["abstain_hits"] == 1
        assert report["metrics"]["abstain_accuracy"] == pytest.approx(0.5)

    def test_error_rows_excluded_and_counted(self, report):
        assert report["error_count"] == 1
        assert report["in_corpus_count"] == 4  # q6 is in-corpus but errored
        # denominators exclude the error row: 3 successful in-corpus rows
        assert report["metrics"]["recall_at_k"]["1"] == pytest.approx(1 / 3)

    def test_fallback_counted_separately_from_abstain(self, report):
        # q3 retrieved (sources non-empty) with a fallback-phrase answer
        assert report["fallback_count"] == 1
        # and it did NOT inflate abstain accuracy: q4 is the only abstain hit
        assert report["metrics"]["abstain_hits"] == 1

    def test_per_category_math(self, report):
        # policy = q1 (rank 2), q2 (rank 1), q3 (miss); q6 errored -> excluded
        policy = report["per_category"]["policy"]
        assert policy["count"] == 3
        assert policy["recall_at_3"] == pytest.approx(2 / 3)
        assert policy["mrr"] == pytest.approx(0.5)

    def test_backend_stats_recorded(self, report):
        assert report["backend_stats"]["embedding_model"] == "fake-embed"
        assert report["label"] == "unit-test"
