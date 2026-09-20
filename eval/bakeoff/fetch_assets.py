"""Fetch bake-off assets for the A5 candidates (issue #55).

Per-candidate plan (recorded in assets-meta.json as provenance):

  quality source
    bge-small-en-v1.5     staged models/ tree (tracked in git, ST-loadable)
    snowflake-arctic-embed-m-v1.5
                           canonical Snowflake repo (staged tree is ONNX-only)
    google/embeddinggemma-300m
                           official onnx-community ONNX fp32 export (the
                           canonical Google repo is gated; no HF token on this
                           machine). Quality runs through the ONNX graph with
                           the model-card prompts; the graph outputs
                           `sentence_embedding` (pooled) directly.
    Qwen3-Embedding-0.6B  canonical Qwen repo via transformers with model-card
                           last-token pooling (repo ST config declares
                           pooling_mode_lasttoken, which sentence-transformers
                           2.7 does not implement)
    ettin / ms-marco-MiniLM / bge-reranker-v2-m3
                           canonical repos via CrossEncoder

  cost asset (always dynamic-int8/q8 ONNX under eval/bakeoff/assets/)
    bge-small        local quantize_dynamic of the staged fp32 graph
    arctic           staged shipped q8 graph (models/.../model_quantized.onnx)
    gemma            onnx-community mirror model_quantized.onnx(.onnx_data)
    qwen             onnx-community mirror model_quantized.onnx
    minilm           local quantize_dynamic of the in-repo fp32 graph
    ettin            staged shipped q8 graph
    bge-reranker     onnx-community mirror model_quantized.onnx

Run inside the repo .venv:  python eval/bakeoff/fetch_assets.py
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MAIN_TREE = (
    REPO_ROOT.parent / "trainingapp" if REPO_ROOT.name != "trainingapp" else None
)
sys.path.insert(0, str(Path(__file__).resolve().parent))

from candidates import EMBEDDING_CANDIDATES, RERANKER_CANDIDATES  # noqa: E402

ASSETS_DIR = REPO_ROOT / "eval" / "bakeoff" / "assets"
META_REL = "eval/bakeoff/assets/assets-meta.json"
# Staged models the git worktree does not carry (main-tree-only, git-excluded).
MAIN_TREE_STAGED = Path(r"E:\ZCode\trainingapp") / "models"

TOKENIZER_FILES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "config.json",
    "added_tokens.json",
)

GEMMA_MIRROR = "onnx-community/embeddinggemma-300m-ONNX"
QWEN_MIRROR = "onnx-community/Qwen3-Embedding-0.6B-ONNX"
BGE_RERANK_MIRROR = "onnx-community/bge-reranker-v2-m3-ONNX"
MINILM_CANONICAL = "cross-encoder/ms-marco-MiniLM-L6-v2"


def log(message: str) -> None:
    print("[fetch_assets] %s" % message, flush=True)


def hf_api():
    from huggingface_hub import HfApi

    return HfApi()


def license_and_revision(api, repo_id: str) -> tuple[str, str]:
    info = api.model_info(repo_id)
    license_tag = "unlisted"
    for tag in info.tags or []:
        if tag.startswith("license:"):
            license_tag = tag.split(":", 1)[1]
            break
    return license_tag, str(info.sha)


def snapshot_weights(repo_id: str) -> str:
    from huggingface_hub import snapshot_download

    return str(
        snapshot_download(
            repo_id=repo_id,
            allow_patterns=[
                "*.json",
                "*.txt",
                "*.safetensors",
                "*.model",
                "1_Pooling/*",
                "2_Normalize/*",
                "modules.json",
                "sentence_bert_config.json",
            ],
        )
    )


def download_file(repo_id: str, filename: str) -> Path:
    from huggingface_hub import hf_hub_download

    return Path(hf_hub_download(repo_id=repo_id, filename=filename))


def quantize_dynamic_int8(src: Path, dst: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(str(src), str(dst), weight_type=QuantType.QInt8, per_channel=False)


def stage_pair(repo_id: str, filenames: list[str], target_dir: Path) -> None:
    """Download one or more files (graph + optional external data) into target."""
    target_dir.mkdir(parents=True, exist_ok=True)
    for filename in filenames:
        log("  downloading %s/%s" % (repo_id, filename))
        local = download_file(repo_id, filename)
        shutil.copyfile(local, target_dir / Path(filename).name)


def stage_tokenizers(repo_id: str, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    for name in TOKENIZER_FILES:
        try:
            local = download_file(repo_id, name)
        except Exception:  # noqa: BLE001 - optional per-repo file
            continue
        shutil.copyfile(local, target_dir / name)


def staged_file(rel: str) -> Path | None:
    """Resolve a staged models/ file: worktree first, then main tree."""
    for base in (REPO_ROOT / "models", MAIN_TREE_STAGED):
        candidate = base / rel
        if candidate.is_file():
            return candidate
    return None


def ensure_cost_asset(entry: dict, plan: dict) -> None:
    name = plan["asset_name"]
    target_dir = ASSETS_DIR / name / "onnx"
    final = target_dir / "model_quantized.onnx"
    if final.is_file():
        entry["onnx_path"] = "eval/bakeoff/assets/%s/onnx/model_quantized.onnx" % name
        entry.setdefault("onnx_quant", plan.get("quant_note", "dynamic-int8"))
        return

    kind = plan["cost_kind"]
    if kind == "mirror-pair":  # graph + external data, both shipped quantized
        stage_pair(
            plan["repo"],
            ["onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data"],
            target_dir,
        )
        entry["onnx_quant"] = "shipped-int8 (mirror)"
    elif kind == "mirror-single":
        stage_pair(plan["repo"], ["onnx/model_quantized.onnx"], target_dir)
        entry["onnx_quant"] = "shipped-int8 (mirror)"
    elif kind == "local-quantize":  # fp32 source, quantize here
        target_dir.mkdir(parents=True, exist_ok=True)
        src = plan["source"]()
        fp32 = target_dir / "model_fp32_src.onnx"
        if plan.get("source_pair"):
            pair = plan["source_pair"]()
            fp32_data = target_dir / (fp32.name + "_data")
            shutil.copyfile(pair, fp32_data)
        shutil.copyfile(src, fp32)
        log("  quantizing %s -> dynamic int8" % fp32.name)
        quantize_dynamic_int8(fp32, final)
        fp32.unlink()
        (target_dir / (fp32.name + "_data")).unlink(missing_ok=True)
        entry["onnx_quant"] = "dynamic-int8 (local)"
    elif kind == "copy-staged":
        src = plan["source"]()
        target_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, final)
        entry["onnx_quant"] = "shipped q8 (staged models/)"
    entry["onnx_path"] = "eval/bakeoff/assets/%s/onnx/model_quantized.onnx" % name


def build_plans() -> dict[str, dict]:
    plans: dict[str, dict] = {}

    plans["BAAI/bge-small-en-v1.5"] = {
        "asset_name": "bge-small-en-v1.5",
        "cost_kind": "local-quantize",
        "source": lambda: staged_file("bge-small-en-v1.5/onnx/model.onnx"),
        "tokenizer_repo": "BAAI/bge-small-en-v1.5",
        "quality": "staged-st",
    }
    plans["Snowflake/snowflake-arctic-embed-m-v1.5"] = {
        "asset_name": "snowflake-arctic-embed-m-v1.5",
        "cost_kind": "copy-staged",
        "source": lambda: staged_file(
            "snowflake-arctic-embed-m-v1.5/onnx/model_quantized.onnx"
        ),
        "quality": "canonical-st",
    }
    plans["google/embeddinggemma-300m"] = {
        "asset_name": "embeddinggemma-300m",
        "cost_kind": "mirror-pair",
        "repo": GEMMA_MIRROR,
        "quality": "mirror-onnx-fp32",
        "quality_repo": GEMMA_MIRROR,
    }
    plans["Qwen/Qwen3-Embedding-0.6B"] = {
        "asset_name": "qwen3-embedding-0.6b",
        "cost_kind": "mirror-single",
        "repo": QWEN_MIRROR,
        "quality": "canonical-transformers",
    }
    plans["cross-encoder/ettin-reranker-32m-v1"] = {
        "asset_name": "ettin-reranker-32m-v1",
        "cost_kind": "copy-staged",
        "source": lambda: staged_file(
            "ettin-reranker-32m-v1/onnx/model_quantized.onnx"
        ),
        "quality": "canonical-st",
    }
    plans["cross-encoder/ms-marco-MiniLM-L6-v2"] = {
        "asset_name": "ms-marco-minilm-l6-v2",
        "cost_kind": "local-quantize",
        "source": lambda: download_file(MINILM_CANONICAL, "onnx/model.onnx"),
        "tokenizer_repo": MINILM_CANONICAL,
        "quality": "canonical-st",
    }
    plans["BAAI/bge-reranker-v2-m3"] = {
        "asset_name": "bge-reranker-v2-m3",
        "cost_kind": "mirror-single",
        "repo": BGE_RERANK_MIRROR,
        "quality": "canonical-st",
    }
    return plans


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-fetch existing assets")
    parser.add_argument(
        "--only",
        default=None,
        help="comma-separated candidate ids to (re)fetch; default all missing",
    )
    args = parser.parse_args(argv)

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    api = hf_api()
    meta_path = REPO_ROOT / META_REL
    meta: dict[str, dict] = {}
    if meta_path.is_file() and not args.force:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))

    plans = build_plans()
    order = list(EMBEDDING_CANDIDATES) + list(RERANKER_CANDIDATES)
    if args.only:
        wanted = {part.strip() for part in args.only.split(",")}
        order = [hf_id for hf_id in order if hf_id in wanted]

    for hf_id in order:
        plan = plans[hf_id]
        entry = dict(meta.get(hf_id, {}))
        entry["hf_id"] = hf_id
        entry["kind"] = "embed" if hf_id in EMBEDDING_CANDIDATES else "rerank"
        license_repo = hf_id
        entry["license"], entry["revision"] = license_and_revision(api, license_repo)
        log("%s: license=%s" % (hf_id, entry["license"]))

        entry["quality_source"] = plan["quality"]
        if plan["quality"] == "canonical-st":
            log("  snapshot weights (canonical)")
            entry["weights_cache"] = snapshot_weights(hf_id)
        elif plan["quality"] == "canonical-transformers":
            log("  snapshot weights (canonical, transformers path)")
            entry["weights_cache"] = snapshot_weights(hf_id)
        elif plan["quality"] == "staged-st":
            entry["staged_dir"] = "models/" + plan["asset_name"]

        started = time.time()
        ensure_cost_asset(entry, plan)
        if plan.get("tokenizer_repo"):
            stage_tokenizers(
                plan["tokenizer_repo"], ASSETS_DIR / plan["asset_name"] / "onnx"
            )
        if plan.get("quality_repo"):
            # Gemma: stage tokenizer from the mirror next to the graphs, and
            # fetch the fp32 pair for the quality run.
            stage_tokenizers(
                plan["quality_repo"], ASSETS_DIR / plan["asset_name"] / "onnx"
            )
            fp32_dir = ASSETS_DIR / plan["asset_name"] / "onnx"
            if not (fp32_dir / "model.onnx").is_file():
                stage_pair(
                    plan["quality_repo"],
                    ["onnx/model.onnx", "onnx/model.onnx_data"],
                    fp32_dir,
                )
            entry["quality_onnx"] = (
                "eval/bakeoff/assets/%s/onnx/model.onnx" % plan["asset_name"]
            )

        entry["fetched_seconds"] = round(time.time() - started, 1)
        meta[hf_id] = entry
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        log("  recorded (%ss)" % entry["fetched_seconds"])

    log("assets meta written to %s" % META_REL)
    return 0


if __name__ == "__main__":
    sys.exit(main())
