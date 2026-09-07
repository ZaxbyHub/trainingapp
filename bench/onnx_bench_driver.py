#!/usr/bin/env python3
"""ONNX embed/rerank microbenchmark (issue #52 bench harness).

Measures CPU encoder cost for the three candidate embed/rerank models:
  * bge-small-en-v1.5            (desktop embedding, onnx/model.onnx)
  * snowflake-arctic-embed-m-v1.5 (web_ui embedding, model_quantized.onnx
    preferred with model.onnx fallback)
  * ettin-reranker-32m-v1         (web_ui reranker, model_quantized.onnx
    preferred with model.onnx fallback)

This measures encoder cost (latency/throughput), not retrieval quality; pooling
choice does not meaningfully change cost and is documented here. Rows carry a
machine tag (BENCH_MACHINE_TAG, default "devstation").

Usage:
  python bench/onnx_bench_driver.py --assets-dir models --json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

EMBED_MODELS = [
    {
        "model": "bge-small-en-v1.5",
        "dir": "bge-small-en-v1.5",
        "candidates": ["onnx/model.onnx"],
    },
    {
        "model": "snowflake-arctic-embed-m-v1.5",
        "dir": "snowflake-arctic-embed-m-v1.5",
        "candidates": ["onnx/model_quantized.onnx", "onnx/model.onnx"],
    },
]
RERANK_MODELS = [
    {
        "model": "ettin-reranker-32m-v1",
        "dir": "ettin-reranker-32m-v1",
        "candidates": ["onnx/model_quantized.onnx", "onnx/model.onnx"],
    },
]
THREADS = 4  # mirrors the desktop n_threads default (config.py:57)


def machine_tag() -> str:
    return (os.environ.get("BENCH_MACHINE_TAG", "") or "devstation").strip()


def find_model(assets: Path, entry: dict) -> Path | None:
    for rel in entry["candidates"]:
        p = assets / entry["dir"] / rel
        if p.is_file() and p.stat().st_size > 1024:
            return p
    return None


def make_session(model_path: Path):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = THREADS
    opts.inter_op_num_threads = 1
    return ort.InferenceSession(
        str(model_path), sess_options=opts, providers=["CPUExecutionProvider"]
    )


def feed_inputs(session, encoding) -> dict:
    """Map a tokenizers Encoding onto whatever inputs the ONNX graph declares."""
    ids = [encoding.ids]
    mask = [encoding.attention_mask]
    # Encodings from tokenizers without token_type_ids omit the attribute.
    types = [getattr(encoding, "type_ids", None) or [0] * len(encoding.ids)]
    feed = {}
    for inp in session.get_inputs():
        name = inp.name.lower()
        if "input_ids" in name:
            feed[inp.name] = ids
        elif "attention_mask" in name:
            feed[inp.name] = mask
        elif "token_type" in name:
            feed[inp.name] = types
    missing = [i.name for i in session.get_inputs() if i.name not in feed]
    if missing:
        raise RuntimeError(f"model requires inputs we did not provide: {missing}")
    return feed


def mean_pool(last_hidden, mask):
    import numpy as np

    mask = np.asarray(mask, dtype=np.float32)[:, :, None]
    summed = (last_hidden * mask).sum(axis=1)
    counts = np.clip(mask.sum(axis=1), 1e-9, None)
    pooled = summed / counts
    norm = np.linalg.norm(pooled, axis=1, keepdims=True)
    return pooled / np.clip(norm, 1e-9, None)


def find_tokenizer(model_path: Path) -> Path | None:
    """Tokenizer file may live beside the onnx file or at the model-dir root."""
    for cand in (
        model_path.parent / "tokenizer.json",
        model_path.parent.parent / "tokenizer.json",
    ):
        if cand.is_file():
            return cand
    return None


def bench_embed(assets: Path, entry: dict) -> dict:
    row = {
        "surface": "onnx-embed",
        "model": entry["model"],
        "kind": "embed",
        "machine": machine_tag(),
        "threads": THREADS,
    }
    model_path = find_model(assets, entry)
    if model_path is None:
        row.update(
            {
                "outcome": "fail",
                "error": f"model file not found under {assets / entry['dir'] / 'onnx'}",
            }
        )
        return row
    tok_path = find_tokenizer(model_path)
    if tok_path is None:
        row.update(
            {
                "outcome": "fail",
                "error": f"tokenizer not found beside or above {model_path}",
            }
        )
        return row
    try:
        from tokenizers import Tokenizer

        session = make_session(model_path)
        tokenizer = Tokenizer.from_file(str(tok_path))

        query = "How do I reset my training password?"
        docs = [
            f"Document chunk {i}: procedures for module {i % 7} of the course."
            for i in range(16)
        ]

        # Single-query encode latency (median of 20 after 3 warmups).
        enc = tokenizer.encode(query)
        feed = feed_inputs(session, enc)
        for _ in range(3):
            session.run(None, feed)
        lat = []
        for _ in range(20):
            t0 = time.perf_counter()
            session.run(None, feed)
            lat.append((time.perf_counter() - t0) * 1000.0)
        lat.sort()
        encode_ms = round(lat[len(lat) // 2], 3)

        # Batch throughput (16 docs).
        batch_encs = [tokenizer.encode(d) for d in docs]
        max_len = max(len(e.ids) for e in batch_encs)
        pad_id = tokenizer.token_to_id("[PAD]") or 0

        def pad(e):
            ids = e.ids + [pad_id] * (max_len - len(e.ids))
            mask = e.attention_mask + [0] * (max_len - len(e.attention_mask))
            e_types = getattr(e, "type_ids", None) or [0] * len(e.ids)
            types = e_types + [0] * (max_len - len(e_types))
            return ids, mask, types

        padded = [pad(e) for e in batch_encs]
        feed_b = {}
        for inp in session.get_inputs():
            name = inp.name.lower()
            if "input_ids" in name:
                feed_b[inp.name] = [p[0] for p in padded]
            elif "attention_mask" in name:
                feed_b[inp.name] = [p[1] for p in padded]
            elif "token_type" in name:
                feed_b[inp.name] = [p[2] for p in padded]
        t0 = time.perf_counter()
        out_b = session.run(None, feed_b)
        # Guard against a sub-tick measurement dividing by zero.
        batch_s = max(time.perf_counter() - t0, 1e-9)
        mean_pool(
            out_b[0],
            feed_b[
                [
                    i.name
                    for i in session.get_inputs()
                    if "attention_mask" in i.name.lower()
                ][0]
            ],
        )

        row.update(
            {
                "model_file": str(model_path),
                "encode_ms": encode_ms,
                "embeddings_per_second": round(len(docs) / batch_s, 1),
                "outcome": "pass" if encode_ms > 0 else "fail",
            }
        )
    except Exception as exc:
        row.update({"outcome": "fail", "error": str(exc)[:300]})
    return row


def bench_rerank(assets: Path, entry: dict) -> dict:
    row = {
        "surface": "onnx-rerank",
        "model": entry["model"],
        "kind": "rerank",
        "machine": machine_tag(),
        "threads": THREADS,
    }
    model_path = find_model(assets, entry)
    if model_path is None:
        row.update(
            {
                "outcome": "fail",
                "error": f"model file not found under {assets / entry['dir'] / 'onnx'}",
            }
        )
        return row
    tok_path = find_tokenizer(model_path)
    if tok_path is None:
        row.update(
            {
                "outcome": "fail",
                "error": f"tokenizer not found beside or above {model_path}",
            }
        )
        return row
    try:
        from tokenizers import Tokenizer

        session = make_session(model_path)
        tokenizer = Tokenizer.from_file(str(tok_path))

        query = "How do I reset my training password?"
        corpus = [
            f"Chunk {i}: password reset steps vary by module {i % 9}."
            for i in range(32)
        ]

        def score(n_candidates: int) -> float:
            encs = [tokenizer.encode(query, d) for d in corpus[:n_candidates]]
            feeds = [feed_inputs(session, e) for e in encs]
            for f in feeds[:2]:
                session.run(None, f)
            lat = []
            for f in feeds:
                t0 = time.perf_counter()
                session.run(None, f)
                lat.append((time.perf_counter() - t0) * 1000.0)
            return round(sum(lat) / len(lat), 2)

        top15_ms = score(15)
        top30_ms = score(30)
        row.update(
            {
                "model_file": str(model_path),
                "top15_ms": top15_ms,
                "top30_ms": top30_ms,
                "outcome": "pass" if top15_ms > 0 and top30_ms > 0 else "fail",
            }
        )
    except Exception as exc:
        row.update({"outcome": "fail", "error": str(exc)[:300]})
    return row


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="ONNX embed/rerank CPU microbenchmark (cost, not quality)."
    )
    parser.add_argument("--assets-dir", type=str, default=str(REPO_ROOT / "models"))
    parser.add_argument(
        "--json",
        nargs="?",
        const="-",
        default=None,
        help="optionally write the JSON rows to this file "
        "(JSON always goes to stdout)",
    )
    args = parser.parse_args(argv)

    assets = Path(args.assets_dir)
    rows = [bench_embed(assets, e) for e in EMBED_MODELS]
    rows += [bench_rerank(assets, e) for e in RERANK_MODELS]
    text = json.dumps({"rows": rows}, ensure_ascii=True, indent=2)
    print(text)
    if args.json and args.json != "-":
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(text + "\n", encoding="utf-8")
    return 0 if all(r.get("outcome") == "pass" for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
