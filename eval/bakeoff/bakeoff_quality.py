"""Quality driver for the A5 bake-off (issue #55): measures every embedding
and reranker candidate on the A4 tier-0 eval set (eval/questions.jsonl +
eval/corpus) with per-candidate canonical prompting, using metric
definitions identical to eval/runner.py (recall@{1,3,5} over the ranked
source list with the doc-id-or-basename match rule; MRR counting unmatched
in-corpus rows as 0 in the denominator).

Encoder paths (see fetch_assets.py provenance):
  - sentence-transformers for bge-small (staged), arctic (canonical repo),
    and the cross-encoder rerankers;
  - transformers + model-card last-token pooling for Qwen3-Embedding-0.6B
    (its ST config declares pooling_mode_lasttoken, unsupported by the
    pinned sentence-transformers 2.7);
  - the official onnx-community fp32 ONNX export for EmbeddingGemma-300M
    (canonical Google weights are gated; the mirror graph outputs
    `sentence_embedding` pooled, model-card prompts verified against the
    mirror README).

Fairness rules (eval/bakeoff/README.md):
  - the corpus is chunked ONCE with the production chunker
    (document_processor.DocumentProcessor defaults) and shared by all
    candidates;
  - each candidate embeds queries/passages through its own canonical prompt
    format (effective strings recorded in the output meta);
  - the reranker stage scores the shared top-30 retrieval pool per
    (embedding, reranker) pair, re-ranks, cuts to 10 (contract max);
  - reranker summary rows are measured on the fixed control embedding
    (candidates.CONTROL_EMBEDDING); the full 4x3 grid lands in `combos`.

Output: eval/bakeoff/results/quality.json. Run in the repo .venv:
  python eval/bakeoff/bakeoff_quality.py
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
sys.path.insert(0, str(REPO_ROOT))

from candidates import (  # noqa: E402
    CONTROL_EMBEDDING,
    EMBEDDING_CANDIDATES,
    FINAL_CUT,
    RERANKER_CANDIDATES,
    RETRIEVAL_POOL,
    THREADS,
)

QUESTIONS_REL = "eval/questions.jsonl"
CORPUS_REL = "eval/corpus"
OUT_REL = "eval/bakeoff/results/quality.json"


def _resolve_main_checkout() -> Path | None:
    """Sibling main checkout used for locally staged models (git-excluded).

    Resolution: $TRAININGAPP_MAIN_CHECKOUT, else the conventional sibling
    directory next to this worktree, when it exists. Never required -- the
    drivers fall back to hub downloads when staged models are absent.
    """
    import os

    override = os.environ.get("TRAININGAPP_MAIN_CHECKOUT")
    if override:
        candidate = Path(override)
        return candidate if candidate.is_dir() else None
    sibling = REPO_ROOT.parent / "trainingapp"
    return sibling if sibling.is_dir() else None


MAIN_TREE = _resolve_main_checkout()


def log(message: str) -> None:
    print("[quality] %s" % message, flush=True)


class STEncoder:
    """sentence-transformers backed encoder (bge-small, arctic)."""

    def __init__(self, load_targets: list[str]):
        from sentence_transformers import SentenceTransformer

        self.source = None
        last_error = None
        for target in load_targets:
            try:
                self.model = SentenceTransformer(target, device="cpu")
                self.source = target
                return
            except Exception as exc:  # noqa: BLE001 - try the next source
                last_error = exc
        raise RuntimeError("no load source worked: %s" % last_error)

    def encode(self, texts: list[str], batch_size: int = 16):
        return self.model.encode(
            texts,
            normalize_embeddings=True,
            show_progress_bar=False,
            batch_size=batch_size,
            convert_to_numpy=True,
        )

    def prompts(self) -> dict:
        return dict(getattr(self.model, "prompts", None) or {})


class TransformersLastTokenEncoder:
    """Qwen3-Embedding path: transformers AutoModel + last-token pooling."""

    def __init__(self, model_id: str):
        import torch
        from transformers import AutoModel, AutoTokenizer

        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        self.model = AutoModel.from_pretrained(model_id, torch_dtype=torch.float32)
        self.model.eval()
        self.source = model_id

    def encode(self, texts: list[str], batch_size: int = 8):
        import numpy as np

        outputs = []
        with self.torch.no_grad():
            for start in range(0, len(texts), batch_size):
                batch = texts[start : start + batch_size]
                encoded = self.tokenizer(
                    batch,
                    padding=True,
                    truncation=True,
                    max_length=512,
                    return_tensors="pt",
                )
                result = self.model(**encoded)
                hidden = result.last_hidden_state
                # Last-token pooling (Qwen3-Embedding reference last_token_pool):
                # under LEFT padding the final position holds the last real
                # token; under RIGHT padding it sits at attention_mask.sum-1.
                # The mask-derived index below is correct for both sides.
                mask = encoded["attention_mask"]
                if self.tokenizer.padding_side == "left":
                    seq = hidden[:, -1]
                else:
                    last_index = mask.sum(dim=1) - 1
                    seq = hidden[self.torch.arange(hidden.size(0)), last_index]
                seq = self.torch.nn.functional.normalize(seq, p=2, dim=1)
                outputs.append(seq.cpu().numpy().astype(np.float32))
        import numpy as np

        return np.vstack(outputs)

    def prompts(self) -> dict:
        return {}


class OnnxEmbedEncoder:
    """EmbeddingGemma path: official onnx-community fp32 graph.

    The graph outputs `sentence_embedding` (pooled) directly per the mirror
    model card; fallback to mean-pooling last_hidden_state covers graphs
    without that output.
    """

    def __init__(self, graph: Path, tokenizer_dir: Path, threads: int):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(graph), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self.tokenizer = Tokenizer.from_file(str(tokenizer_dir / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=512)
        self.source = str(graph)
        self._output_names = [o.name for o in self.session.get_outputs()]

    def _feed(self, ids, mask):
        feed = {}
        for inp in self.session.get_inputs():
            name = inp.name.lower()
            if "input_ids" in name:
                feed[inp.name] = ids
            elif "attention_mask" in name:
                feed[inp.name] = mask
        return feed

    def encode(self, texts: list[str], batch_size: int = 8):
        import numpy as np

        chunks = []
        for start in range(0, len(texts), batch_size):
            batch = texts[start : start + batch_size]
            encodings = [self.tokenizer.encode(t) for t in batch]
            max_len = max(len(e.ids) for e in encodings)
            ids = np.zeros((len(batch), max_len), dtype=np.int64)
            mask = np.zeros((len(batch), max_len), dtype=np.int64)
            for row, enc in enumerate(encodings):
                length = len(enc.ids)
                ids[row, :length] = enc.ids
                mask[row, :length] = 1
            result = self.session.run(None, self._feed(ids, mask))
            names = self._output_names
            if "sentence_embedding" in names:
                pooled = result[names.index("sentence_embedding")]
            else:
                hidden = result[0]
                m = mask[:, :, None].astype(np.float32)
                pooled = (hidden * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)
            norms = np.linalg.norm(pooled, axis=1, keepdims=True)
            chunks.append((pooled / np.clip(norms, 1e-9, None)).astype(np.float32))
        return np.vstack(chunks)

    def prompts(self) -> dict:
        return {}


def build_encoder(
    hf_id: str, spec: dict, threads: int, quality_plan: str, quality_onnx=None
):
    staged = spec.get("staged_dir")
    staged_paths = [str(REPO_ROOT / staged)]
    if MAIN_TREE:
        staged_paths.append(str(MAIN_TREE / staged))
    if quality_plan == "staged-st":
        return STEncoder(staged_paths or [hf_id])
    if quality_plan == "canonical-st":
        return STEncoder([hf_id])
    if quality_plan == "canonical-transformers":
        return TransformersLastTokenEncoder(hf_id)
    if quality_plan == "mirror-onnx-fp32":
        graph = REPO_ROOT / quality_onnx
        return OnnxEmbedEncoder(graph, graph.parent, threads)
    raise RuntimeError("unknown quality plan %s" % quality_plan)


def load_cross_encoder_compat(hf_id: str, spec: dict):
    """CrossEncoder loader with an ettin-era tokenizer_config compatibility
    shim: cross-encoder/ettin-reranker-32m-v1 declares tokenizer_class
    "TokenizersBackend" (a transformers 5.x class) which the pinned
    transformers 4.57 rejects. On that exact failure, stage a patched copy
    (tokenizer_class -> PreTrainedTokenizerFast) under the gitignored assets
    dir and load from there. Any other error propagates for the normal
    source-fallback loop.
    """
    import json
    import shutil

    from sentence_transformers import CrossEncoder

    staged = spec.get("staged_dir")
    targets = []
    if staged:
        targets.append(str(REPO_ROOT / staged))
        if MAIN_TREE:
            targets.append(str(MAIN_TREE / staged))
    targets.append(hf_id)

    def attempt(target):
        return CrossEncoder(target, device="cpu", max_length=512)

    last_error = None
    saw_tokenizers_backend = False
    for target in targets:
        try:
            return attempt(target), target, None
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if "TokenizersBackend" in str(exc):
                saw_tokenizers_backend = True
    if not saw_tokenizers_backend:
        raise last_error

    # All sources failed on the TokenizersBackend declaration: patch a copy.
    from huggingface_hub import snapshot_download

    snap = Path(
        snapshot_download(
            repo_id=hf_id,
            allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model"],
        )
    )
    compat_dir = REPO_ROOT / ("eval/bakeoff/assets/%s-compat" % hf_id.split("/")[-1])
    if compat_dir.exists():
        shutil.rmtree(compat_dir)
    compat_dir.mkdir(parents=True)
    for item in snap.iterdir():
        if item.is_file():
            shutil.copyfile(item, compat_dir / item.name)
    tok_config_path = compat_dir / "tokenizer_config.json"
    tok_config = json.loads(tok_config_path.read_text(encoding="utf-8"))
    tok_config["tokenizer_class"] = "PreTrainedTokenizerFast"
    tok_config_path.write_text(json.dumps(tok_config, indent=2), encoding="utf-8")
    return (
        attempt(str(compat_dir)),
        str(compat_dir),
        (
            "tokenizer_class TokenizersBackend (transformers 5.x) not available under the "
            "pinned transformers 4.57; loaded via patched copy with "
            "PreTrainedTokenizerFast under eval/bakeoff/assets/%s-compat"
            % hf_id.split("/")[-1]
        ),
    )


class EttinModulesCrossEncoder:
    """ettin-reranker-32m-v1 is a sentence-transformers MODULES-based
    cross-encoder (config architectures=ModernBertModel): Transformer over the
    (query, passage) pair -> CLS pooling -> Dense 384x384 GELU -> LayerNorm ->
    Dense 384x1 = score. sentence-transformers 2.7's CrossEncoder cannot load
    that layout (it builds a RANDOM ForSequenceClassification head -- verified:
    'classifier.* / head.* newly initialized'), and NO ONNX export of this
    model carries the trained head (upstream onnx/ exports output
    last_hidden_state only). This class scores through the trained module
    weights, which is the model card's intended CrossEncoder usage.

    The repo-staged models/ettin-reranker-32m-v1/onnx graphs (shipped by the
    browser and Electron surfaces) output fabricated 'logits' from an
    untrained appended head -- recorded as a production finding in ADR-0001,
    not measured here.
    """

    def __init__(self, model_dir: str):
        import torch
        from safetensors.torch import load_file
        from tokenizers import Tokenizer
        from transformers import AutoModel

        self.torch = torch
        self.model_dir = Path(model_dir)
        self.model = AutoModel.from_pretrained(model_dir)
        self.model.eval()
        self.tokenizer = Tokenizer.from_file(str(self.model_dir / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding(pad_id=0)
        dense1 = load_file(str(self.model_dir / "2_Dense" / "model.safetensors"))
        layernorm = load_file(str(self.model_dir / "3_LayerNorm" / "model.safetensors"))
        dense2 = load_file(str(self.model_dir / "4_Dense" / "model.safetensors"))
        with torch.no_grad():
            self.w1 = dense1["linear.weight"]
            self.ln = torch.nn.LayerNorm(layernorm["norm.weight"].shape[0])
            self.ln.weight.copy_(layernorm["norm.weight"])
            self.ln.bias.copy_(layernorm["norm.bias"])
            self.w2 = dense2["linear.weight"]
            self.b2 = dense2["linear.bias"]
        self.source = model_dir

    def predict(self, pairs, batch_size: int = 16):
        import numpy as np

        scores: list[float] = []
        with self.torch.no_grad():
            for start in range(0, len(pairs), batch_size):
                batch = pairs[start : start + batch_size]
                encodings = [
                    self.tokenizer.encode(query, passage) for query, passage in batch
                ]
                max_len = max(len(e.ids) for e in encodings)
                ids = np.zeros((len(batch), max_len), dtype=np.int64)
                mask = np.zeros((len(batch), max_len), dtype=np.int64)
                for row, enc in enumerate(encodings):
                    ids[row, : len(enc.ids)] = enc.ids
                    mask[row, : len(enc.ids)] = 1
                hidden = self.model(
                    input_ids=self.torch.tensor(ids),
                    attention_mask=self.torch.tensor(mask),
                ).last_hidden_state
                pooled = hidden[:, 0]
                x = self.torch.nn.functional.gelu(pooled @ self.w1.T)
                x = self.ln(x)
                x = x @ self.w2.T + self.b2
                scores.extend(float(v) for v in x.reshape(-1).tolist())
        return scores


def load_questions(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rows.append(json.loads(line))
    return rows


def build_corpus_docs() -> tuple[list[dict], dict]:
    """Chunk the A4 corpus with the production chunker (read-only)."""
    from document_processor import DocumentProcessor

    processor = DocumentProcessor()
    docs: list[dict] = []
    corpus_dir = REPO_ROOT / CORPUS_REL
    chunker_meta = {
        "chunk_size": processor.chunk_size,
        "chunk_overlap": processor.chunk_overlap,
    }
    for path in sorted(corpus_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(corpus_dir)
        if path.suffix.lower() == ".md":
            text = path.read_text(encoding="utf-8")
        elif path.suffix.lower() == ".json":
            try:
                slide = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                continue
            if not isinstance(slide, dict):
                continue
            parts = [
                str(slide.get("slide_title", "")),
                str(slide.get("on_screen_text", "")),
                str(slide.get("transcript_source", "")),
            ]
            text = "\n".join(p for p in parts if p)
        else:
            continue
        for chunk in processor.chunk_text(text, source=path.name):
            content = getattr(chunk, "content", None)
            if content is None:
                content = chunk if isinstance(chunk, str) else ""
            docs.append({"source": path.name, "text": content, "rel": str(rel)})
    return docs, chunker_meta


def rank_metrics(questions, ranked_sources_by_qid, k_values=(1, 3, 5)):
    """Identical to eval/runner.py recall/MRR semantics (doc-id-or-basename)."""
    ranks = {}
    for row in questions:
        qid = row["id"]
        expected = row.get("expected_doc_id")
        sources = ranked_sources_by_qid.get(qid, [])
        rank = None
        if expected is not None:
            expected_name = str(expected).replace(chr(92), "/").rsplit("/", 1)[-1]
            for index, source in enumerate(sources, start=1):
                basename = str(source).replace(chr(92), "/").rsplit("/", 1)[-1]
                if source == expected or basename == expected_name:
                    rank = index
                    break
        ranks[qid] = rank
    in_corpus = [row for row in questions if row.get("expected_doc_id") is not None]
    if not in_corpus:
        return {"recall@1": 0.0, "recall@3": 0.0, "recall@5": 0.0, "mrr": 0.0}, ranks
    metrics = {}
    for k in k_values:
        hits = sum(
            1
            for row in in_corpus
            if ranks[row["id"]] is not None and 0 < ranks[row["id"]] <= k
        )
        metrics["recall@%d" % k] = hits / len(in_corpus)
    metrics["mrr"] = sum(
        1.0 / ranks[row["id"]] for row in in_corpus if ranks[row["id"]]
    ) / len(in_corpus)
    return metrics, ranks


def ranked_sources_from_pool(pool, key_fn):
    scored = sorted(pool, key=key_fn, reverse=True)
    seen: set[str] = set()
    ranked: list[str] = []
    for item in scored:
        source = item[1]
        if source not in seen:
            seen.add(source)
            ranked.append(source)
        if len(ranked) >= FINAL_CUT:
            break
    return ranked


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--questions", default=str(REPO_ROOT / QUESTIONS_REL))
    parser.add_argument("--out", default=str(REPO_ROOT / OUT_REL))
    parser.add_argument("--threads", type=int, default=THREADS)
    parser.add_argument(
        "--meta", default=str(REPO_ROOT / "eval/bakeoff/assets/assets-meta.json")
    )
    args = parser.parse_args(argv)

    import numpy as np
    import torch

    torch.set_num_threads(args.threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass  # already initialized in-process

    assets_meta = {}
    meta_path = Path(args.meta)
    if meta_path.is_file():
        assets_meta = json.loads(meta_path.read_text(encoding="utf-8"))

    questions = load_questions(Path(args.questions))
    in_corpus = [row for row in questions if row.get("expected_doc_id") is not None]
    out_of_corpus = [row for row in questions if row.get("expected_doc_id") is None]
    log(
        "questions: %d in-corpus / %d out-of-corpus"
        % (len(in_corpus), len(out_of_corpus))
    )

    docs, chunker_meta = build_corpus_docs()
    log("corpus chunks: %d (chunker %s)" % (len(docs), chunker_meta))

    embeddings_out: dict[str, dict] = {}
    combos: list[dict] = []
    prompt_evidence: dict[str, dict] = {}
    deviations: list[str] = []
    retrieval_pools: dict[str, dict] = {}
    exec_log: list[dict] = []

    for hf_id, spec in EMBEDDING_CANDIDATES.items():
        started = time.time()
        entry = assets_meta.get(hf_id, {})
        quality_plan = entry.get("quality_source", "canonical-st")
        encoder = build_encoder(
            hf_id, spec, args.threads, quality_plan, entry.get("quality_onnx")
        )
        log("loaded %s via %s" % (hf_id, encoder.source))

        shipped_prompts = encoder.prompts()
        query_tpl = shipped_prompts.get("query") or spec["query_prompt"]
        passage_tpl = (
            shipped_prompts.get("document")
            or shipped_prompts.get("passage")
            or spec["passage_prompt"]
        )
        prompt_evidence[hf_id] = {
            "query": query_tpl,
            "passage": passage_tpl,
            "origin": (
                "sentence-transformers-config"
                if shipped_prompts
                else spec["prompt_source"]
            ),
        }

        probe = encoder.encode(["dimension probe"])
        dims = int(np.asarray(probe).shape[1])
        if dims != spec["dims_expected"]:
            deviations.append(
                "%s: measured dims %d != registry expectation %d (measured value emitted)"
                % (hf_id, dims, spec["dims_expected"])
            )

        passages = [passage_tpl.format(text=doc["text"]) for doc in docs]
        corpus_vecs = encoder.encode(passages)
        pool_by_qid: dict[str, list[tuple[float, str, str]]] = {}
        ranked_by_qid: dict[str, list[str]] = {}
        for row in questions:
            query = query_tpl.format(text=row["question"])
            qvec = encoder.encode([query])
            scores = (corpus_vecs @ qvec[0]).tolist()
            order = sorted(range(len(docs)), key=lambda i: scores[i], reverse=True)
            pool_by_qid[row["id"]] = [
                (scores[i], docs[i]["source"], docs[i]["text"])
                for i in order[:RETRIEVAL_POOL]
            ]
            ranked_by_qid[row["id"]] = ranked_sources_from_pool(
                pool_by_qid[row["id"]], lambda item: item[0]
            )
        retrieval_pools[hf_id] = pool_by_qid
        metrics, _ranks = rank_metrics(questions, ranked_by_qid)
        elapsed = round(time.time() - started, 1)
        embeddings_out[hf_id] = {
            "dims": dims,
            "quality": metrics,
            "load_source": str(encoder.source),
            "quality_path": quality_plan,
        }
        exec_log.append(
            {"candidate": hf_id, "seconds": elapsed, "kind": "embed-quality"}
        )
        log("%s: dims=%d %s (%.1fs)" % (hf_id, dims, metrics, elapsed))

    reranker_models: dict[str, object] = {}
    for hf_id, spec in RERANKER_CANDIDATES.items():
        if hf_id == "cross-encoder/ettin-reranker-32m-v1":
            ettin_dir = REPO_ROOT / "eval/bakeoff/assets/ettin-reranker-32m-v1-compat"
            cross = EttinModulesCrossEncoder(str(ettin_dir))
            reranker_models[hf_id] = cross
            log("loaded reranker %s via trained modules pipeline" % hf_id)
            deviations.append(
                "%s: scored through the trained ST modules pipeline "
                "(Transformer+CLS+Dense+LayerNorm+Dense) because ST 2.7 CrossEncoder "
                "cannot load the modules layout and no ONNX export carries the trained "
                "head; the repo-staged onnx graphs (browser/Electron artifacts) emit "
                "logits from an untrained appended head and are excluded from quality "
                "measurement -- see ADR-0001" % hf_id
            )
            continue
        cross, source, compat_note = load_cross_encoder_compat(hf_id, spec)
        reranker_models[hf_id] = cross
        log("loaded reranker %s via %s" % (hf_id, source))
        if compat_note:
            deviations.append("%s: %s" % (hf_id, compat_note))

    rerank_summary: dict[str, list[dict]] = {hf_id: [] for hf_id in RERANKER_CANDIDATES}
    for emb_id, pool_by_qid in retrieval_pools.items():
        for rerank_id, cross in reranker_models.items():
            started = time.time()
            ranked_by_qid: dict[str, list[str]] = {}
            for row in questions:
                pool = pool_by_qid.get(row["id"], [])
                if pool:
                    pairs = [(row["question"], text) for _s, _src, text in pool]
                    scores = [float(s) for s in cross.predict(pairs)]
                    fused = list(zip(scores, [src for _s, src, _t in pool]))
                else:
                    fused = []
                ranked_by_qid[row["id"]] = ranked_sources_from_pool(
                    fused, lambda item: item[0]
                )
            metrics, _ranks = rank_metrics(questions, ranked_by_qid)
            combos.append(
                {
                    "embedding": emb_id,
                    "reranker": rerank_id,
                    "recall@1": metrics["recall@1"],
                    "recall@3": metrics["recall@3"],
                    "recall@5": metrics["recall@5"],
                    "mrr": metrics["mrr"],
                }
            )
            rerank_summary[rerank_id].append({"embedding": emb_id, **metrics})
            log("combo %s + %s: %s" % (emb_id, rerank_id, metrics))
            exec_log.append(
                {
                    "candidate": "%s + %s" % (emb_id, rerank_id),
                    "seconds": round(time.time() - started, 1),
                    "kind": "combo",
                }
            )

    rerankers_out: dict[str, dict] = {}
    for rerank_id, rows in rerank_summary.items():
        control_rows = [r for r in rows if r["embedding"] == CONTROL_EMBEDDING]
        chosen = control_rows[0] if control_rows else max(rows, key=lambda r: r["mrr"])
        rerankers_out[rerank_id] = {
            "quality": {
                "recall@1": chosen["recall@1"],
                "recall@3": chosen["recall@3"],
                "recall@5": chosen["recall@5"],
                "mrr": chosen["mrr"],
            },
            "summary_basis": (
                "control embedding %s" % CONTROL_EMBEDDING
                if control_rows
                else "best-of-grid (control row unavailable)"
            ),
            "per_embedding": rows,
        }

    out = {
        "threads": args.threads,
        "hardware": platform.processor() or platform.machine(),
        "python": platform.python_version(),
        "in_corpus": len(in_corpus),
        "out_of_corpus": len(out_of_corpus),
        "chunker": chunker_meta,
        "chunks": len(docs),
        "embeddings": embeddings_out,
        "rerankers": rerankers_out,
        "combos": combos,
        "prompts_used": prompt_evidence,
        "deviations": deviations,
        "execution_log": exec_log,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    log("wrote %s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
