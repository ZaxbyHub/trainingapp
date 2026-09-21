"""Candidate registry for the A5 embedding/reranker bake-off (issue #55).

Canonical HF ids verified against the live HF API on 2026-09-20:
  - cross-encoder/ms-marco-MiniLM-L6-v2 IS the canonical repo id (88.6M
    downloads, apache-2.0). The hyphenated "MiniLM-L-6-v2" spelling 307-aliases
    to it and is NOT canonical; the audit_report.md claim embedded in the issue
    text has the direction backwards. ADR-0001 records this correction.
  - cross-encoder/ettin-reranker-32m-v1 is the canonical upstream of the staged
    models/ettin-reranker-32m-v1 directory (apache-2.0).
  - google/embeddinggemma-300m is lowercase-canonical (the CamelCase spelling
    aliases to it).

Query/passage prompt formats follow each model's published usage. Where the
downloaded model ships a sentence-transformers prompts config, the runtime
prefers it and records the effective strings in the results meta; the strings
below are the documented fallback and the sanity record.

ONNX assets for CPU-cost measurement come from the canonical repo when it
ships an onnx/ tree and from the official onnx-community mirrors otherwise
(same weights, conversion provenance recorded in assets-meta.json).
"""

from __future__ import annotations

EMBEDDING_CANDIDATES = {
    "BAAI/bge-small-en-v1.5": {
        "kind": "embed",
        "staged_dir": "models/bge-small-en-v1.5",
        "dims_expected": 384,
        "query_prompt": "Represent this sentence for searching relevant passages: {text}",
        "passage_prompt": "{text}",
        "prompt_source": "BAAI bge-small-en-v1.5 model card retrieval usage",
    },
    "Snowflake/snowflake-arctic-embed-m-v1.5": {
        "kind": "embed",
        "staged_dir": "models/snowflake-arctic-embed-m-v1.5",
        "dims_expected": 768,
        "query_prompt": "Represent this sentence for searching relevant passages: {text}",
        "passage_prompt": "{text}",
        "prompt_source": "Snowflake arctic-embed model card retrieval usage",
    },
    "google/embeddinggemma-300m": {
        "kind": "embed",
        "staged_dir": None,
        "dims_expected": 768,
        "query_prompt": "task: search result | query: {text}",
        "passage_prompt": "title: none | text: {text}",
        "prompt_source": "google/embeddinggemma-300m model card retrieval prompts",
    },
    "Qwen/Qwen3-Embedding-0.6B": {
        "kind": "embed",
        "staged_dir": None,
        "dims_expected": 1024,
        "query_prompt": (
            "Instruct: Given a web search query, retrieve relevant passages "
            "that answer the query\nQuery: {text}"
        ),
        "passage_prompt": "{text}",
        "prompt_source": "Qwen3-Embedding model card retrieval usage",
    },
}

RERANKER_CANDIDATES = {
    "cross-encoder/ettin-reranker-32m-v1": {
        "kind": "rerank",
        "staged_dir": "models/ettin-reranker-32m-v1",
    },
    "cross-encoder/ms-marco-MiniLM-L6-v2": {
        "kind": "rerank",
        "staged_dir": None,
    },
    "BAAI/bge-reranker-v2-m3": {
        "kind": "rerank",
        "staged_dir": None,
    },
}

# Control embedding the per-reranker summary rows are measured on (the current
# desktop pair member), kept fixed so reranker rows are comparable to each other.
CONTROL_EMBEDDING = "BAAI/bge-small-en-v1.5"

# Bake-off thread cap (end-user CPU profile per the interactive user's
# instruction). Distinct from bench/onnx_bench_driver.THREADS=4, the stock
# #52 driver's default; bakeoff_cost passes this value explicitly.
THREADS = 8

RETRIEVAL_POOL = 30  # candidate chunks fed to a reranker stage
FINAL_CUT = 10  # contract-max sources kept for ranking metrics (eval/runner default)
