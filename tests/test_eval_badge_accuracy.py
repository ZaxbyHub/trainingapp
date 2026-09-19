"""C5 (issue #72) eval badge-accuracy metric tests.

The eval harness reports badge_accuracy: the fraction of successful questions
where the emitted `grounding` value matches the expected grounded/general
label (derived from corpus coverage: a question with an expected document is
expected to ground; an out-of-corpus question is expected general). The
metric is report-only — no hard gate. These tests pin the math, the
report.json keys, and the REPORT.md row.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval import runner  # noqa: E402


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
    def __init__(self, scripted):
        self._scripted = scripted

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


def _payload(question, grounding, sources=("docA.md",)):
    return (
        200,
        {
            "question": question,
            "answer": "answer text",
            "sources": list(sources),
            "context_length": 10,
            "inference_time": 0.1,
            "grounding": grounding,
        },
    )


def _questions():
    return [
        {
            "id": "b1",
            "question": "b1 text",
            "expected_doc_id": "docA.md",
            "expected_page": None,
            "expected_training_slide_id": None,
            "category": "policy",
        },
        {
            "id": "b2",
            "question": "b2 text",
            "expected_doc_id": "docB.md",
            "expected_page": None,
            "expected_training_slide_id": None,
            "category": "policy",
        },
        {
            "id": "b3",
            "question": "b3 text",
            "expected_doc_id": None,
            "expected_page": None,
            "expected_training_slide_id": None,
            "category": "out-of-corpus",
        },
        {
            "id": "b4",
            "question": "b4 text",
            "expected_doc_id": None,
            "expected_page": None,
            "expected_training_slide_id": None,
            "category": "out-of-corpus",
        },
    ]


def _run(monkeypatch, scripted):
    monkeypatch.setattr(runner.httpx, "Client", lambda: _FakeClient(scripted))
    return runner.run_eval(
        base_url="http://fake",
        questions=_questions(),
        n_results=10,
        timeout=5.0,
        label="badge-unit-test",
    )


def test_badge_accuracy_all_match(monkeypatch):
    report = _run(
        monkeypatch,
        {
            "b1 text": _payload("b1 text", "grounded"),
            "b2 text": _payload("b2 text", "grounded"),
            "b3 text": _payload("b3 text", "general", sources=()),
            "b4 text": _payload("b4 text", "general", sources=()),
        },
    )
    metrics = report["metrics"]
    assert metrics["badge_total"] == 4
    assert metrics["badge_matches"] == 4
    assert metrics["badge_accuracy"] == 1.0


def test_badge_accuracy_counts_mismatches(monkeypatch):
    """Asymmetric 1-match/3-miss fixture (PRR-006): inverting the match
    predicate would yield 0.75, distinguishable from the correct 0.25."""
    report = _run(
        monkeypatch,
        {
            # b1 emits general although it is expected grounded -> miss
            "b1 text": _payload("b1 text", "general"),
            "b2 text": _payload("b2 text", "grounded"),
            # b3 emits grounded although expected general -> miss
            "b3 text": _payload("b3 text", "grounded", sources=()),
            # b4 emits grounded although expected general -> miss
            "b4 text": _payload("b4 text", "grounded", sources=()),
        },
    )
    metrics = report["metrics"]
    assert metrics["badge_total"] == 4
    assert metrics["badge_matches"] == 1
    assert metrics["badge_accuracy"] == 0.25


def test_badge_accuracy_excludes_error_rows_and_invalid_values(monkeypatch):
    report = _run(
        monkeypatch,
        {
            "b1 text": (500, {"detail": "boom"}),
            # invalid enum value counts in the denominator (successful row)
            # but can never match
            "b2 text": _payload("b2 text", "sort-of"),
            "b3 text": _payload("b3 text", "general", sources=()),
            "b4 text": _payload("b4 text", "general", sources=()),
        },
    )
    metrics = report["metrics"]
    assert metrics["badge_total"] == 3
    assert metrics["badge_matches"] == 2
    assert metrics["badge_accuracy"] == pytest.approx(2 / 3)


def test_report_markdown_includes_badge_row(monkeypatch):
    report = _run(
        monkeypatch,
        {
            "b1 text": _payload("b1 text", "grounded"),
            "b2 text": _payload("b2 text", "grounded"),
            "b3 text": _payload("b3 text", "general", sources=()),
            "b4 text": _payload("b4 text", "general", sources=()),
        },
    )
    markdown = runner.render_markdown(report)
    assert "| badge accuracy | 1.000 (4/4;" in markdown
    assert "report-only" in markdown


def test_missing_grounding_key_is_a_contract_error(monkeypatch):
    """A response without grounding fails ask_one's required-key check, so
    the row becomes an error row and cannot silently pass badge scoring."""
    report = _run(
        monkeypatch,
        {
            "b1 text": (
                200,
                {
                    "question": "b1 text",
                    "answer": "answer text",
                    "sources": ["docA.md"],
                    "context_length": 10,
                    "inference_time": 0.1,
                },
            ),
            "b2 text": _payload("b2 text", "grounded"),
            "b3 text": _payload("b3 text", "general", sources=()),
            "b4 text": _payload("b4 text", "general", sources=()),
        },
    )
    row = next(r for r in report["results"] if r["id"] == "b1")
    assert row["error"] is not None
    assert "grounding" in row["error"]
    assert report["metrics"]["badge_total"] == 3
