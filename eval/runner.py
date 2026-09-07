#!/usr/bin/env python3
"""Tier-0 eval runner (issue #54, WS-A PR 4/8).

Scores a backend that implements the frozen Document Q&A API contract
(contracts/api.openapi.yaml) over the curated question set in
eval/questions.jsonl. Backend-agnostic: point --base-url at any conforming
server (the Python api_server.py today, the Electron host from WS-B #61
later, or eval/ci_serve.py for a deterministic no-weights run).

Metrics (all computed from ONE POST /ask per question, n_results clamped to
the contract maximum of 10):
- recall@k (k in 1,3,5): fraction of in-corpus questions whose
  expected_doc_id appears in the first k entries of the response's ranked
  `sources` list. A source matches when it equals expected_doc_id OR its
  final path component does (the Python backend ingests files by display
  filename, so sources are basenames; the path-component fallback keeps the
  rule portable across backends that return fuller paths).
- MRR: mean over in-corpus questions of 1/rank of the first matching source
  (0.0 when absent).
- abstain accuracy: fraction of successful out-of-corpus questions whose
  response abstained. Abstain policy (strict): a response abstains if and
  only if `sources` is empty - the engine's no-retrieval abstain path. A
  non-empty-sources answer containing the rag_engine fallback phrases is NOT
  an abstain (retrieval succeeded; the LLM could not use it) - those rows
  are counted separately as fallback_count. A "[Cancelled]" answer is an
  error row, not an abstain.
- latency: p50/p95 in milliseconds over SUCCESSFUL requests only. Error rows
  are excluded from every metric denominator and reported via error_count.

Exit codes: 0 = run completed (scores are informational; a low score is a
measurement, not a failure), 1 = structural failure (backend unreachable,
every question errored, or malformed responses), 2 = the question file
failed pre-validation.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_QUESTIONS = Path(__file__).resolve().parent / "questions.jsonl"
DEFAULT_REPORT = Path(__file__).resolve().parent / "REPORT.md"
DEFAULT_JSON = Path(__file__).resolve().parent / "report.json"

CONTRACT_MAX_N_RESULTS = 10
RECALL_KS = (1, 3, 5)
CANCELLED_MARKER = "[cancelled]"
# rag_engine.py's "retrieved but LLM could not use it" phrases - tracked as
# fallback_count, NEVER as abstain (those responses carry non-empty sources).
FALLBACK_PHRASES = [
    "i could not find this information",
    "i couldn't find any relevant information",
    "the documents do not contain information",
    "i don't have information",
]
REQUIRED_RESPONSE_KEYS = (
    "question",
    "answer",
    "sources",
    "context_length",
    "inference_time",
)


def load_questions(path: Path) -> list[dict]:
    """Parse and pre-validate the question set; exit 2 on any schema problem."""
    rows: list[dict] = []
    header_seen = False
    try:
        handle = path.open("r", encoding="utf-8")
    except OSError as exc:
        _fail(f"{path}: cannot open question file ({exc})")
    with handle as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line:
                continue
            if line.startswith("#"):
                header_seen = True
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                _fail(f"{path}:{lineno}: invalid JSON ({exc})")
            missing = [
                k
                for k in ("id", "question", "expected_doc_id", "category")
                if k not in row
            ]
            if missing:
                _fail(f"{path}:{lineno}: missing fields {missing}")
            if not isinstance(row["id"], str) or not row["id"]:
                _fail(f"{path}:{lineno}: id must be a non-empty string")
            if not isinstance(row["question"], str) or not row["question"].strip():
                _fail(f"{path}:{lineno}: question must be a non-empty string")
            if not isinstance(row["category"], str) or not row["category"]:
                _fail(f"{path}:{lineno}: category must be a non-empty string")
            rows.append(row)
    if not header_seen:
        _fail(f"{path}: missing '#' header comment block (schema + follow-up note)")
    ids = [r["id"] for r in rows]
    if len(set(ids)) != len(ids):
        _fail(f"{path}: duplicate question ids")
    ooc = [r for r in rows if r["expected_doc_id"] is None]
    if len(ooc) < 5:
        _fail(f"{path}: fewer than 5 out-of-corpus rows ({len(ooc)})")
    for row in rows:
        if row["expected_doc_id"] is None and row["category"] != "out-of-corpus":
            _fail(
                f"{path}: {row['id']}: null expected_doc_id requires category 'out-of-corpus'"
            )
        if row["expected_doc_id"] is not None and row["category"] == "out-of-corpus":
            _fail(
                f"{path}: {row['id']}: out-of-corpus rows must have null expected_doc_id"
            )
    if not (50 <= len(rows) <= 80):
        _fail(f"{path}: row count {len(rows)} outside the 50-80 contract")
    return rows


def _fail(message: str) -> None:
    print(f"runner: {message}", file=sys.stderr)
    sys.exit(2)


def source_matches(source: str, expected_doc_id: str) -> bool:
    """True when a returned source string identifies the expected document."""
    if source == expected_doc_id:
        return True
    normalized = source.replace("\\", "/")
    return normalized.rsplit("/", 1)[-1] == expected_doc_id


def rank_of_expected(sources: list[str], expected_doc_id: str) -> int:
    """1-based rank of the first matching source, or 0 when absent."""
    for idx, source in enumerate(sources, 1):
        if source_matches(source, expected_doc_id):
            return idx
    return 0


def is_abstain(sources: list, answer: str) -> bool:
    """Strict abstain rule: no sources retrieved (see module docstring)."""
    if answer.strip().lower().startswith(CANCELLED_MARKER):
        return False  # cancellation is an error row, never an abstain
    return len(sources) == 0


def is_fallback_phrase_answer(sources: list, answer: str) -> bool:
    """Retrieval succeeded (sources non-empty) but the answer is a fallback phrase."""
    lowered = answer.lower()
    return bool(sources) and any(phrase in lowered for phrase in FALLBACK_PHRASES)


def percentile(values: list[float], pct: float) -> float:
    """Linear-interpolation percentile over an unsorted list of floats."""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * pct / 100.0
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    frac = pos - low
    return ordered[low] * (1.0 - frac) + ordered[high] * frac


def ask_one(
    client: httpx.Client, base_url: str, question: str, n_results: int, timeout: float
):
    """POST one question to /ask. Returns (result_dict, latency_ms, error_or_None)."""
    payload = {
        "question": question,
        "n_results": max(1, min(n_results, CONTRACT_MAX_N_RESULTS)),
    }
    start = time.perf_counter()
    try:
        response = client.post(f"{base_url}/ask", json=payload, timeout=timeout)
    except httpx.HTTPError as exc:
        return None, 0.0, f"transport error: {type(exc).__name__}: {exc}"
    latency_ms = (time.perf_counter() - start) * 1000.0
    if response.status_code != 200:
        detail = ""
        try:
            detail = str(response.json().get("detail", ""))[:200]
        except Exception:
            pass
        return None, latency_ms, f"HTTP {response.status_code} {detail}".strip()
    try:
        body = response.json()
    except ValueError:
        return None, latency_ms, "response is not valid JSON"
    missing = [k for k in REQUIRED_RESPONSE_KEYS if k not in body]
    if missing:
        return None, latency_ms, f"response missing contract keys {missing}"
    return body, latency_ms, None


def run_eval(
    base_url: str,
    questions: list[dict],
    n_results: int,
    timeout: float,
    label: str,
    k_values=RECALL_KS,
) -> dict:
    """Drive the backend once per question and assemble the report dict."""
    results = []
    with httpx.Client() as client:
        try:
            health = client.get(f"{base_url}/health", timeout=timeout)
            health.raise_for_status()
        except httpx.HTTPError as exc:
            print(f"runner: backend {base_url} failed /health: {exc}", file=sys.stderr)
            sys.exit(1)
        stats = None
        try:
            stats_response = client.get(f"{base_url}/stats", timeout=timeout)
            if stats_response.status_code == 200:
                stats = stats_response.json()
        except httpx.HTTPError:
            stats = None

        for row in questions:
            body, latency_ms, error = ask_one(
                client, base_url, row["question"], n_results, timeout
            )
            entry = {
                "id": row["id"],
                "category": row["category"],
                "expected_doc_id": row["expected_doc_id"],
                "latency_ms": round(latency_ms, 1),
                "error": error,
                "sources": [],
                "answer": None,
                "abstained": False,
                "fallback_phrase": False,
                "rank": None,
            }
            if body is not None:
                answer = str(body.get("answer", ""))
                sources = body.get("sources")
                sources = [str(s) for s in sources] if isinstance(sources, list) else []
                if answer.strip().lower().startswith(CANCELLED_MARKER):
                    entry["error"] = "generation cancelled ([Cancelled] answer)"
                else:
                    entry["sources"] = sources
                    entry["answer"] = answer
                    entry["abstained"] = is_abstain(sources, answer)
                    entry["fallback_phrase"] = is_fallback_phrase_answer(
                        sources, answer
                    )
                    if row["expected_doc_id"] is not None:
                        entry["rank"] = rank_of_expected(
                            sources, row["expected_doc_id"]
                        )
            results.append(entry)

    in_corpus = [r for r in results if r["expected_doc_id"] is not None]
    out_of_corpus = [r for r in results if r["expected_doc_id"] is None]
    ok_in = [r for r in in_corpus if r["error"] is None]
    ok_ooc = [r for r in out_of_corpus if r["error"] is None]
    successful = [r for r in results if r["error"] is None]
    error_count = sum(1 for r in results if r["error"] is not None)

    recall_at_k = {
        str(k): (
            sum(1 for r in ok_in if r["rank"] is not None and 0 < r["rank"] <= k)
            / len(ok_in)
            if ok_in
            else 0.0
        )
        for k in k_values
    }
    mrr = (
        sum(1.0 / r["rank"] for r in ok_in if r["rank"]) / len(ok_in) if ok_in else 0.0
    )
    abstain_hits = sum(1 for r in ok_ooc if r["abstained"])
    abstain_accuracy = (abstain_hits / len(ok_ooc)) if ok_ooc else 0.0
    latencies = [r["latency_ms"] for r in successful]
    fallback_count = sum(1 for r in successful if r["fallback_phrase"])

    per_category = {}
    for category, rows in Counter(r["category"] for r in ok_in).items():
        subset = [r for r in ok_in if r["category"] == category]
        per_category[category] = {
            "count": len(subset),
            "recall_at_3": (
                sum(1 for r in subset if r["rank"] is not None and 0 < r["rank"] <= 3)
                / len(subset)
            ),
            "mrr": sum(1.0 / r["rank"] for r in subset if r["rank"]) / len(subset),
        }

    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    report = {
        "schema": "eval-report/1",
        "base_url": base_url,
        "timestamp": timestamp,
        "label": label,
        "question_count": len(results),
        "in_corpus_count": len(in_corpus),
        "out_of_corpus_count": len(out_of_corpus),
        "error_count": error_count,
        "fallback_count": fallback_count,
        "backend_stats": {
            "embedding_model": (stats or {}).get("embedding_model"),
            "llm_backend": (stats or {}).get("llm_backend"),
            "document_count": (stats or {}).get("document_count"),
            "chunk_count": (stats or {}).get("chunk_count"),
        },
        "metrics": {
            "recall_at_k": recall_at_k,
            "mrr": mrr,
            "abstain_accuracy": abstain_accuracy,
            "abstain_total": len(ok_ooc),
            "abstain_hits": abstain_hits,
            "latency_ms": {
                "p50": round(percentile(latencies, 50), 1),
                "p95": round(percentile(latencies, 95), 1),
                "mean": round(sum(latencies) / len(latencies), 1) if latencies else 0.0,
            },
        },
        "per_category": per_category,
        "results": results,
    }
    return report


def render_markdown(report: dict) -> str:
    """Render the human-readable REPORT.md for a completed run."""
    metrics = report["metrics"]
    lines = [
        "# Tier-0 Eval Report",
        "",
        f"- base_url: `{report['base_url']}`",
        f"- timestamp: {report['timestamp']}",
        f"- label: {report['label']}",
        f"- backend: embedding_model={report['backend_stats']['embedding_model']!r}, "
        f"llm_backend={report['backend_stats']['llm_backend']!r}",
        f"- questions: {report['question_count']} "
        f"(in-corpus {report['in_corpus_count']}, out-of-corpus {report['out_of_corpus_count']}, "
        f"errors {report['error_count']})",
        "",
        "## Metrics",
        "",
        "| metric | value |",
        "|---|---|",
        *[f"| recall@{k} | {metrics['recall_at_k'][str(k)]:.3f} |" for k in (1, 3, 5)],
        f"| MRR | {metrics['mrr']:.3f} |",
        f"| abstain accuracy | {metrics['abstain_accuracy']:.3f} "
        f"({metrics['abstain_hits']}/{metrics['abstain_total']}) |",
        f"| latency p50 (ms) | {metrics['latency_ms']['p50']:.1f} |",
        f"| latency p95 (ms) | {metrics['latency_ms']['p95']:.1f} |",
        f"| fallback-phrase answers | {report['fallback_count']} |",
        "",
        "## Per-category (in-corpus, successful rows)",
        "",
        "| category | count | recall@3 | MRR |",
        "|---|---|---|---|",
    ]
    for category, stats in sorted(report["per_category"].items()):
        lines.append(
            f"| {category} | {stats['count']} | {stats['recall_at_3']:.3f} | {stats['mrr']:.3f} |"
        )
    lines += [
        "",
        "## Abstain rows (out-of-corpus)",
        "",
        "| id | abstained | error |",
        "|---|---|---|",
    ]
    for r in report["results"]:
        if r["expected_doc_id"] is None:
            lines.append(
                f"| {r['id']} | {str(r['abstained']).lower()} | {r['error'] or '-'} |"
            )
    error_rows = [r for r in report["results"] if r["error"] is not None]
    if error_rows:
        lines += ["", "## Errors", ""]
        for r in error_rows:
            lines.append(f"- {r['id']}: {r['error']}")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--base-url",
        required=True,
        help="base URL of a backend implementing the frozen /ask contract",
    )
    parser.add_argument("--questions", type=Path, default=DEFAULT_QUESTIONS)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--json-out", type=Path, default=DEFAULT_JSON)
    parser.add_argument(
        "--label",
        default="unlabeled",
        help="backend provenance label recorded in the report header",
    )
    parser.add_argument(
        "--n-results",
        type=int,
        default=CONTRACT_MAX_N_RESULTS,
        help=f"n_results for /ask (contract max {CONTRACT_MAX_N_RESULTS})",
    )
    parser.add_argument(
        "--timeout", type=float, default=60.0, help="per-request seconds"
    )
    args = parser.parse_args(argv)

    if not args.label.strip():
        parser.error("--label must be a non-empty provenance label")

    questions = load_questions(args.questions)
    report = run_eval(
        base_url=args.base_url.rstrip("/"),
        questions=questions,
        n_results=args.n_results,
        timeout=args.timeout,
        label=args.label,
    )
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(render_markdown(report), encoding="utf-8")

    metrics = report["metrics"]
    print(
        f"eval: {report['question_count']} questions vs {report['base_url']} "
        f"[{report['label']}] recall@5={metrics['recall_at_k']['5']:.3f} "
        f"mrr={metrics['mrr']:.3f} "
        f"abstain={metrics['abstain_hits']}/{metrics['abstain_total']} "
        f"p50={metrics['latency_ms']['p50']:.0f}ms p95={metrics['latency_ms']['p95']:.0f}ms "
        f"errors={report['error_count']}"
    )

    if report["error_count"] == report["question_count"]:
        print("runner: every question errored - backend is unusable", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
