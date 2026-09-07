#!/usr/bin/env python3
"""Stage benchmark model assets (issue #52 bench harness).

Verifies/downloads every asset the drivers consume into models/ (or
BENCH_ASSETS_DIR). Weights are never committed to the repo (.gitignore already
excludes *.gguf/*.safetensors); this is the documented operator staging step.

  --check            print the status of every asset and exit (0 = all present)
  --embed-weights    download BAAI/bge-small-en-v1.5 model.safetensors (for the
                     sentence-transformers RAG-perf suites)
  --onnx             verify/download the three ONNX models (bge onnx is
                     LFS-tracked: verified, not downloaded; arctic + ettin are
                     downloaded when missing)
  --gguf REPO:FILE:DEST  download one GGUF (repeatable), e.g.
                     LiquidAI/LFM2.5-1.2B-Instruct-GGUF:model-Q4_K_M.gguf:models/lfm2.5-1.2b-instruct/model-Q4_K_M.gguf
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

BGE_SAFETENSORS = (
    "BAAI/bge-small-en-v1.5",
    "model.safetensors",
    "models/bge-small-en-v1.5/model.safetensors",
)
ONNX_ASSETS = [
    # (label, repo-or-None (LFS-tracked, verify only), [candidate files], dest dir)
    (
        "bge-small-en-v1.5 (onnx, LFS-tracked)",
        None,
        ["onnx/model.onnx"],
        "models/bge-small-en-v1.5",
    ),
    (
        "snowflake-arctic-embed-m-v1.5 (onnx)",
        "Snowflake/snowflake-arctic-embed-m-v1.5",
        ["onnx/model_quantized.onnx", "onnx/model.onnx"],
        "models/snowflake-arctic-embed-m-v1.5",
    ),
    (
        "ettin-reranker-32m-v1 (onnx)",
        None,
        ["onnx/model_quantized.onnx", "onnx/model.onnx"],
        "models/ettin-reranker-32m-v1",
    ),
]


def is_lfs_pointer(p: Path) -> bool:
    try:
        return p.read_bytes()[:32].startswith(b"version https://git-lfs")
    except Exception:
        return False


def _asset_path(assets_root: Path, models_relative: str) -> Path:
    """Resolve a 'models/...' repo-relative path against --assets-dir."""
    rel = Path(models_relative)
    if rel.parts and rel.parts[0] == "models":
        rel = Path(*rel.parts[1:])
    return assets_root / rel


def asset_status(assets_root: Path) -> list:
    rows = []
    ggufs = [
        ("gemma-4-e2b-it Q4_K_M", "models/gemma-4-e2b-it/model.gguf"),
        ("lfm2.5-vl-450m Q4_K_M", "models/lfm2.5-vl-450m/model.gguf"),
        ("gemma-4-e2b-it Q5_K_M", "models/gemma-4-e2b-it/model-Q5_K_M.gguf"),
        (
            "lfm2.5-1.2b-instruct Q4_K_M",
            "models/lfm2.5-1.2b-instruct/model-Q4_K_M.gguf",
        ),
        (
            "lfm2.5-1.2b-instruct Q5_K_M",
            "models/lfm2.5-1.2b-instruct/model-Q5_K_M.gguf",
        ),
        ("gemma-3-1b-it Q4_K_M", "models/gemma-3-1b-it/model-Q4_K_M.gguf"),
        ("gemma-3-1b-it Q5_K_M", "models/gemma-3-1b-it/model-Q5_K_M.gguf"),
    ]
    repo, fname, dest = BGE_SAFETENSORS
    p = _asset_path(assets_root, dest)
    rows.append(
        {
            "asset": f"{repo}:{fname}",
            "path": str(p),
            "present": p.is_file()
            and p.stat().st_size > 1024
            and not is_lfs_pointer(p),
        }
    )
    for label, _, candidates, dest_dir in ONNX_ASSETS:
        found = None
        for cand in candidates:
            cp = _asset_path(assets_root, dest_dir) / cand
            if cp.is_file() and cp.stat().st_size > 1024 and not is_lfs_pointer(cp):
                found = str(cp)
                break
        rows.append({"asset": label, "path": found, "present": found is not None})
    for label, rel in ggufs:
        p = _asset_path(assets_root, rel)
        rows.append(
            {
                "asset": label,
                "path": str(p) if p.is_file() else None,
                "present": p.is_file() and p.stat().st_size > 1024,
            }
        )
    return rows


def download(repo: str, fname: str, dest: Path) -> None:
    import shutil

    from huggingface_hub import hf_hub_download

    target = hf_hub_download(repo_id=repo, filename=fname)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(target, dest)
    print(f"staged {repo}:{fname} -> {dest}")


def resolve_ettin_repo() -> str:
    """Resolve the ettin reranker HF repo id from the local config (never guess)."""
    cfg_paths = [
        REPO_ROOT / "models/ettin-reranker-32m-v1/config.json",
        REPO_ROOT / "models/ettin-reranker-32m-v1/onnx/config.json",
    ]
    for cp in cfg_paths:
        if cp.is_file():
            try:
                data = json.loads(cp.read_text(encoding="utf-8"))
                name = data.get("_name_or_path", "")
                if name and "/" in str(name):
                    return str(name)
            except Exception:
                pass
    try:
        from huggingface_hub import HfApi

        matches = list(HfApi().list_models(search="ettin-reranker-32m-v1"))
        exact = [m.id for m in matches if m.id.endswith("ettin-reranker-32m-v1")]
        if len(exact) == 1:
            return exact[0]
    except Exception:
        pass
    raise SystemExit(
        "could not resolve the ettin reranker HF repo id from local config or "
        "hub search; pass it explicitly via --onnx-repo "
        "ettin=<org/repo>"
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--embed-weights", action="store_true")
    parser.add_argument("--onnx", action="store_true")
    parser.add_argument(
        "--onnx-repo",
        action="append",
        default=[],
        help="override a repo id, e.g. ettin=org/repo",
    )
    parser.add_argument(
        "--gguf", action="append", default=[], help="REPO:FILE:DEST (repeatable)"
    )
    parser.add_argument("--assets-dir", type=str, default=str(REPO_ROOT / "models"))
    args = parser.parse_args(argv)

    assets_root = Path(args.assets_dir)
    if args.check:
        rows = asset_status(assets_root)
        for r in rows:
            print(
                f"[{'OK ' if r['present'] else 'MISSING'}] {r['asset']} -> {r['path']}"
            )
        return 0 if all(r["present"] for r in rows) else 1

    overrides = dict(o.split("=", 1) for o in args.onnx_repo if "=" in o)
    if args.embed_weights:
        repo, fname, dest = BGE_SAFETENSORS
        download(repo, fname, _asset_path(assets_root, dest))
    if args.onnx:
        for label, repo, candidates, dest_dir in ONNX_ASSETS:
            for cand in candidates:
                staged = _asset_path(assets_root, dest_dir) / cand
                if staged.is_file() and not is_lfs_pointer(staged):
                    print(f"[OK] {label}: {cand} already staged")
                    break
            else:
                if repo is None:
                    if label.startswith("ettin"):
                        repo = overrides.get("ettin") or resolve_ettin_repo()
                    else:
                        print(
                            f"[!!] {label}: LFS-tracked file missing/pointer; "
                            "run: git lfs pull"
                        )
                        continue
                download(
                    repo,
                    candidates[0],
                    _asset_path(assets_root, dest_dir) / candidates[0],
                )
    for spec in args.gguf:
        parts = spec.split(":")
        if len(parts) != 3:
            raise SystemExit(f"--gguf expects REPO:FILE:DEST, got: {spec}")
        repo, fname, dest = parts
        download(repo, fname, _asset_path(assets_root, dest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
