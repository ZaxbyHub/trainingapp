"""CPU-cost driver for the A5 bake-off (issue #55): measures per-candidate
latency at top-15/top-30 candidate counts on q8 ONNX graphs with an 8-thread
cap (end-user CPU profile per the interactive user's instruction).

Reuses the #52 microbenchmark harness (bench/onnx_bench_driver.py):
`make_session` (with the bake-off's 8-thread override) and `feed_inputs`.

  embeddings: top15/top30_ms_p50 = p50 over 20 trials of total wall time for
  (query encode through the graph + cosine against 15/30 pre-embedded
  candidate vectors). Pooling is applied for cost completeness only (it does
  not meaningfully change encoder cost; same caveat as the #52 driver).

  rerankers: top15/top30_ms_p50 = p50 over 20 trials of total wall time to
  sequentially score 15/30 (query, passage) pairs (the #52 driver's
  per-pair mean is kept as `pair_mean_ms` for continuity).

Output: eval/bakeoff/results/cost.json. Run in the repo .venv:
  python eval/bakeoff/bakeoff_cost.py
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(REPO_ROOT / "bench"))

import onnx_bench_driver as bench_driver  # noqa: E402  (#52 harness)
from candidates import EMBEDDING_CANDIDATES, RERANKER_CANDIDATES, THREADS  # noqa: E402

OUT_REL = "eval/bakeoff/results/cost.json"
META_REL = "eval/bakeoff/assets/assets-meta.json"

WARMUP_TRIALS = 3
TRIALS = 20


def log(message: str) -> None:
    print("[cost] %s" % message, flush=True)


def load_tokenizer(tokenizer_dir: Path, hf_id: str = "", staged_dir: str | None = None):
    from tokenizers import Tokenizer

    candidates = [
        tokenizer_dir / "tokenizer.json",
        tokenizer_dir.parent / "tokenizer.json",
    ]
    if staged_dir:
        for base in (REPO_ROOT / staged_dir, Path(r"E:\ZCode	rainingapp") / staged_dir):
            candidates += [base / "tokenizer.json", base / "onnx" / "tokenizer.json"]
    for candidate in candidates:
        if candidate.is_file():
            return Tokenizer.from_file(str(candidate))
    if hf_id:
        from huggingface_hub import hf_hub_download

        local = Path(hf_hub_download(repo_id=hf_id, filename="tokenizer.json"))
        return Tokenizer.from_file(str(local))
    raise RuntimeError("no tokenizer.json found for %s" % hf_id)


def pooled(feed, outputs, output_names):
    """sentence_embedding output when present, else mean-pool last_hidden."""
    import numpy as np

    if "sentence_embedding" in output_names:
        return np.asarray(outputs[output_names.index("sentence_embedding")])
    hidden = np.asarray(outputs[0])
    mask = np.asarray(feed["attention_mask"], dtype=np.float32)[:, :, None]
    summed = (hidden * mask).sum(axis=1)
    return summed / np.clip(mask.sum(axis=1), 1e-9, None)


def augment_decoder_feed(session, feed: dict, seq_len: int) -> dict:
    """Qwen3-Embedding's mirror graph is a decoder-with-cache export: it
    declares position_ids and per-layer past_key_values inputs. For embedding
    use there is no past -- feed position ids and zero-length caches derived
    from each input's declared shape."""
    import numpy as np

    raw_ids = feed["input_ids"]
    batch = raw_ids.shape[0] if hasattr(raw_ids, "shape") else len(raw_ids)
    for inp in session.get_inputs():
        name = inp.name
        if name == "position_ids" and name not in feed:
            feed[name] = np.arange(seq_len, dtype=np.int64)[None, :].repeat(
                batch, axis=0
            )
        elif name.startswith("past_key_values.") and name not in feed:
            shape = inp.shape
            feed[name] = np.zeros((batch, shape[1], 0, shape[3]), dtype=np.float32)
    return feed


def percentile_50(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def measure_embed(session, tokenizer, query: str, candidate_vecs, n: int) -> float:
    import numpy as np

    enc = tokenizer.encode(query)
    try:
        feed = bench_driver.feed_inputs(session, enc)
    except RuntimeError:
        feed = {"input_ids": [enc.ids], "attention_mask": [enc.attention_mask]}
    feed = augment_decoder_feed(session, feed, len(enc.ids))
    vecs = candidate_vecs[:n]

    def once() -> float:
        start = time.perf_counter()
        outputs = session.run(None, feed)
        emb = pooled(feed, outputs, [o.name for o in session.get_outputs()])
        emb = emb.reshape(-1)
        norm = np.linalg.norm(emb)
        unit = emb / max(norm, 1e-9)
        _ = unit @ vecs.T
        return (time.perf_counter() - start) * 1000.0

    for _ in range(WARMUP_TRIALS):
        once()
    return percentile_50([once() for _ in range(TRIALS)])


def measure_rerank(session, tokenizer, query: str, corpus: list[str], n: int) -> float:
    def once() -> float:
        start = time.perf_counter()
        for passage in corpus[:n]:
            enc = tokenizer.encode(query, passage)
            feed = bench_driver.feed_inputs(session, enc)
            feed = augment_decoder_feed(session, feed, len(enc.ids))
            session.run(None, feed)
        return (time.perf_counter() - start) * 1000.0

    for _ in range(2):
        once()
    return percentile_50([once() for _ in range(TRIALS)])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(REPO_ROOT / OUT_REL))
    parser.add_argument("--threads", type=int, default=THREADS)
    parser.add_argument("--meta", default=str(REPO_ROOT / META_REL))
    args = parser.parse_args(argv)

    meta = json.loads(Path(args.meta).read_text(encoding="utf-8"))
    query = "How do I reset my training password?"
    corpus = [
        "Chunk %d: password reset steps vary by module %d." % (i, i % 9)
        for i in range(30)
    ]

    rows: dict[str, dict] = {}
    exec_log: list[dict] = []

    for hf_id, spec in list(EMBEDDING_CANDIDATES.items()) + list(
        RERANKER_CANDIDATES.items()
    ):
        entry = meta.get(hf_id, {})
        onnx_rel = entry.get("onnx_path")
        if not onnx_rel:
            raise RuntimeError("%s has no onnx_path in assets meta" % hf_id)
        graph = REPO_ROOT / onnx_rel
        tokenizer_dir = graph.parent
        started = time.time()
        session = bench_driver.make_session(graph, threads=args.threads)
        staged_dir = (
            hf_id in EMBEDDING_CANDIDATES
            and EMBEDDING_CANDIDATES[hf_id].get("staged_dir")
        ) or (
            hf_id in RERANKER_CANDIDATES
            and RERANKER_CANDIDATES[hf_id].get("staged_dir")
        )
        tokenizer = load_tokenizer(tokenizer_dir, hf_id=hf_id, staged_dir=staged_dir)

        if hf_id in EMBEDDING_CANDIDATES:
            # Pre-embed 30 candidate passages once, then time query-vs-N search.
            import numpy as np

            encs = [tokenizer.encode(p) for p in corpus]
            max_len = max(len(e.ids) for e in encs)
            ids = np.zeros((len(encs), max_len), dtype=np.int64)
            mask = np.zeros((len(encs), max_len), dtype=np.int64)
            for row, enc in enumerate(encs):
                ids[row, : len(enc.ids)] = enc.ids
                mask[row, : len(enc.ids)] = 1
            types = np.zeros_like(ids)
            feed = {}
            mask_key = None
            for inp in session.get_inputs():
                name = inp.name.lower()
                if "input_ids" in name:
                    feed[inp.name] = ids
                elif "attention_mask" in name:
                    feed[inp.name] = mask
                    mask_key = inp.name
                elif "token_type" in name:
                    feed[inp.name] = types
            feed = augment_decoder_feed(session, feed, max_len)
            outputs = session.run(None, feed)
            if mask_key is None:
                mask_key = "attention_mask"
            pooled_feed = {"attention_mask": feed[mask_key]}
            vecs = pooled(pooled_feed, outputs, [o.name for o in session.get_outputs()])
            norms = np.linalg.norm(vecs, axis=1, keepdims=True)
            candidate_vecs = (vecs / np.clip(norms, 1e-9, None)).astype(np.float32)

            top15 = measure_embed(session, tokenizer, query, candidate_vecs, 15)
            top30 = measure_embed(session, tokenizer, query, candidate_vecs, 30)
            rows[hf_id] = {
                "kind": "embed",
                "top15_ms_p50": round(top15, 3),
                "top30_ms_p50": round(top30, 3),
                "onnx": onnx_rel,
                "onnx_quant": entry.get("onnx_quant"),
            }
        else:
            top15 = measure_rerank(session, tokenizer, query, corpus, 15)
            top30 = measure_rerank(session, tokenizer, query, corpus, 30)
            per_pair_15 = top15 / 15.0
            rows[hf_id] = {
                "kind": "rerank",
                "top15_ms_p50": round(top15, 3),
                "top30_ms_p50": round(top30, 3),
                "pair_mean_ms_top15": round(per_pair_15, 3),
                "onnx": onnx_rel,
                "onnx_quant": entry.get("onnx_quant"),
            }
        elapsed = round(time.time() - started, 1)
        exec_log.append({"candidate": hf_id, "seconds": elapsed, "kind": "cost"})
        log("%s: %s" % (hf_id, rows[hf_id]))

    out = {
        "threads": args.threads,
        "hardware": platform.processor() or platform.machine(),
        "machine_tag": "bakeoff-i55",
        "rows": rows,
        "execution_log": exec_log,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    log("wrote %s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
