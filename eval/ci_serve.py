#!/usr/bin/env python3
"""Deterministic no-weights backend for the tier-0 eval harness (issue #54).

Serves the REAL api_server.app over real HTTP with exactly two things
replaced, so the full contract path (FastAPI routes -> RAGEngine.query ->
vector store retrieval -> similarity floor -> empty-context abstain) runs
end to end without model weights:

1. the sentence-transformer encoder is replaced by a deterministic
   feature-hashing embedder (md5 token buckets, signed, L2-normalized) so
   retrieval works offline and identically on every machine;
2. `engine.llm` is replaced by a scripted extractive LLM that never emits
   the rag_engine fallback phrases or abstain markers, so the measured
   abstain behavior comes only from the engine's own empty-context path.

This follows two in-repo precedents: contracts/tests/run_conformance.py
(stub engine installed into a running api_server) and tests/conftest.py
(SentenceTransformer patched for tests).

BOOT ORDER IS LOAD-BEARING (plan-critic Round 1): the environment is set and
`vector_store.SentenceTransformer` is replaced BEFORE api_server is imported,
because the lifespan constructs RAGEngine (and through it the EmbeddingModel)
at startup, and vector_store resolves the SentenceTransformer name from its
module namespace at call time (vector_store.py:128/135).

Similarity-floor calibration: RAG_MIN_SIMILARITY is set to a value derived
for the hashing embedder, NOT the 0.3 default (calibrated for bge-small).
Derivation is recorded in eval/README.md. Hybrid search and reranking are
disabled so the stub's cosine semantics are stable across machines.

Usage:
  python eval/ci_serve.py --port 8091                 # serve until killed
  python eval/ci_serve.py --port 8091 --eval-report out/REPORT.md \
      --eval-json out/report.json                     # one eval run, then exit

The server binds 127.0.0.1 only. Reports written in Mode B carry the label
"deterministic-stub" by default: its numbers are smoke signals for the
pipeline, never comparable with weighted-run quality numbers.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
CORPUS_DIR = EVAL_DIR / "corpus"
DEFAULT_LABEL = "deterministic-stub"

# Calibrated for the feature-hashing embedder below (see eval/README.md
# "Deterministic backend calibration"): separates in-corpus questions from
# out-of-corpus noise with margin under pure cosine similarity.
STUB_MIN_SIMILARITY = "0.12"
EMBEDDING_DIM = 256
STUB_MARKER = "_eval_hashing_stub"

sys.path.insert(0, str(REPO_ROOT))


# Small deterministic stopword set: shared function words inflate the cosine
# noise floor between unrelated texts under feature hashing, which would bury
# the content-token signal the stub exists to exercise (see eval/README.md
# calibration section).
_STOPWORDS = frozenset(
    """a an the is are was were be been being do does did done i you we they it he she
    to of in on for with and or but can could should would will shall may might must
    what which who whom whose when where why how my your our their his her its this that
    these those there here at by from as if not no nor so than then too very get got
    has have had into out up down over under about after before between during each
    some any all both few more most other same such only own same s t don should""".split()
)


def _normalize(token: str) -> str:
    # Naive singular/plural folding so question plurals match doc plurals
    # ("keyboards" vs "keyboard"). Deliberately crude and deterministic.
    if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


def _tokenize(text: str) -> list[str]:
    return [
        _normalize(token)
        for token in re.findall(r"[a-z0-9]+", text.lower())
        if token not in _STOPWORDS
    ]


def _hash_vector(text: str) -> "np.ndarray":  # noqa: F821 - numpy imported lazily
    import numpy as np

    vec = np.zeros(EMBEDDING_DIM, dtype="float32")
    for token in _tokenize(text):
        digest = int(hashlib.md5(token.encode("utf-8")).hexdigest(), 16)
        bucket = digest % EMBEDDING_DIM
        sign = 1.0 if (digest >> 64) & 1 else -1.0
        vec[bucket] += sign
    norm = float(np.linalg.norm(vec))
    if norm > 0.0:
        vec /= norm
    return vec


class _HashingSentenceTransformer:
    """Drop-in stand-in for sentence_transformers.SentenceTransformer."""

    _eval_hashing_stub = True

    def __init__(self, model_name=None, **kwargs):
        self.model_name = model_name

    def encode(self, sentences, **kwargs):
        import numpy as np

        if isinstance(sentences, str):
            return _hash_vector(sentences)
        return np.stack([_hash_vector(s) for s in sentences])

    def get_sentence_embedding_dimension(self) -> int:
        return EMBEDDING_DIM


class _ScriptedLLM:
    """Extractive stand-in for SmartLLM: answers from the retrieved context.

    Deliberately NEVER emits the rag_engine fallback phrases or the
    empty-context message, so abstain signals can only originate from the
    engine's retrieval floor.
    """

    backend_name = "scripted-eval-stub"

    def get_info(self):
        return {"backend": self.backend_name}

    def answer_question(
        self,
        question,
        context,
        sources,
        config,
        conversation_history=None,
        stream_callback=None,
        cancellation_event=None,
    ):
        if stream_callback:
            for token in _answer_tokens(question, context):
                stream_callback(token)
        return _extractive_answer(question, context)


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def _extractive_answer(question: str, context: str) -> str:
    chunks = [c.strip() for c in context.split("\n\n---\n\n") if c.strip()]
    if not chunks:
        return f"Based on the retrieved documents, here is what was found about: {question}"
    picked: list[str] = []
    for chunk in chunks:
        picked.extend(_sentences(chunk)[:2])
        if len(picked) >= 3:
            break
    return " ".join(picked[:3])


def _answer_tokens(question: str, context: str):
    answer = _extractive_answer(question, context)
    for i in range(0, len(answer), 24):
        yield answer[i : i + 24]


def configure_environment() -> None:
    """Set the RAG_* environment the stub backend needs. Call BEFORE api_server import.

    RAG_DB_PATH is forced (not setdefault) to a fresh temp dir: the stub must
    never touch an operator's real doc_qa_db, even when one is configured."""
    os.environ["RAG_DB_PATH"] = tempfile.mkdtemp(prefix="eval-ci-serve-")
    os.environ["RAG_MIN_SIMILARITY"] = STUB_MIN_SIMILARITY
    os.environ["RAG_HYBRID_SEARCH"] = "false"
    os.environ["RAG_RERANKING_ENABLED"] = "false"


def install_stub_encoder() -> None:
    """Replace the encoder class in the vector_store module namespace."""
    import vector_store

    vector_store.SentenceTransformer = _HashingSentenceTransformer


def build_patched_lifespan():
    """Wrap api_server.lifespan: after the real startup, ingest the corpus,
    verify the stub encoder is actually live, and install the scripted LLM."""
    import api_server

    original_lifespan = api_server.lifespan

    @asynccontextmanager
    async def patched_lifespan(app):
        async with original_lifespan(app):
            engine = api_server.engine
            if engine is None or getattr(engine, "vector_store", None) is None:
                raise RuntimeError("eval ci_serve: RAGEngine did not start")
            ingest_corpus(engine)
            model = getattr(engine.vector_store.embedder, "model", None)
            if getattr(model, "_eval_hashing_stub", False) is not True:
                raise RuntimeError(
                    "eval ci_serve: stub encoder is not live - the real "
                    "sentence-transformer would be used, invalidating the run"
                )
            engine.llm = _ScriptedLLM()
            yield

    return patched_lifespan


def ingest_corpus(engine) -> int:
    """Ingest every eval/corpus/*.md via the real ingestion path."""
    total = 0
    for doc in sorted(CORPUS_DIR.glob("*.md")):
        stats = engine.ingest_file(str(doc), source_name=doc.name)
        if not stats.get("success"):
            raise RuntimeError(f"eval ci_serve: failed to ingest {doc.name}: {stats}")
        total += stats.get("chunks_added", 0)
    return total


def wait_for_health(base_url: str, timeout_s: float = 120.0) -> None:
    import urllib.request

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout_s
    last_error = None
    while time.monotonic() < deadline:
        try:
            with opener.open(f"{base_url}/health", timeout=2.0) as response:
                if response.status == 200:
                    return
        except Exception as exc:  # noqa: BLE001 - any boot symptom retries
            last_error = exc
        time.sleep(0.5)
    raise RuntimeError(
        f"eval ci_serve: backend not healthy within {timeout_s}s ({last_error})"
    )


def serve_blocking(port: int) -> None:
    import uvicorn

    import api_server

    api_server.app.router.lifespan_context = build_patched_lifespan()
    print(
        f"eval ci_serve: serving deterministic-stub on http://127.0.0.1:{port}",
        flush=True,
    )
    uvicorn.run(api_server.app, host="127.0.0.1", port=port, log_level="warning")


def run_one_eval(port: int, report: Path, json_out: Path, label: str) -> int:
    """Mode B: serve in a thread, run the runner over real HTTP, tear down."""
    import uvicorn

    import api_server

    api_server.app.router.lifespan_context = build_patched_lifespan()
    config = uvicorn.Config(
        api_server.app, host="127.0.0.1", port=port, log_level="warning"
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{port}"
    try:
        wait_for_health(base_url)
        print(f"eval ci_serve: healthy on {base_url} [{label}]", flush=True)
        completed = subprocess.run(
            [
                sys.executable,
                str(EVAL_DIR / "runner.py"),
                "--base-url",
                base_url,
                "--report",
                str(report),
                "--json-out",
                str(json_out),
                "--label",
                label,
            ],
            cwd=str(REPO_ROOT),
        )
        return completed.returncode
    finally:
        server.should_exit = True
        thread.join(timeout=30.0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--eval-report",
        type=Path,
        default=None,
        help="Mode B: run one eval against this server, write REPORT.md, exit",
    )
    parser.add_argument(
        "--eval-json",
        type=Path,
        default=None,
        help="Mode B: machine-readable report path",
    )
    parser.add_argument("--label", default=DEFAULT_LABEL)
    args = parser.parse_args(argv)

    configure_environment()
    install_stub_encoder()

    if args.eval_report or args.eval_json:
        report = args.eval_report or (EVAL_DIR / "REPORT.md")
        json_out = args.eval_json or (EVAL_DIR / "report.json")
        return run_one_eval(args.port, report, json_out, args.label)
    serve_blocking(args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
