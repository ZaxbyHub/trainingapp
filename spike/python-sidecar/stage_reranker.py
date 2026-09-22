# Populates spike/python-sidecar/staged_reranker/ with the reranker model
# files (HF snapshot layout) so probe_reranker.spec can bundle them as
# bundled_reranker/ for probe leg B. Copies from the local HF cache when the
# model is already there; downloads it otherwise. Run with the sidecar venv:
#   python spike/python-sidecar/stage_reranker.py
import os
import shutil
from pathlib import Path

SPECDIR = Path(__file__).resolve().parent
TARGET = SPECDIR / "staged_reranker"
MODEL_ID = "cross-encoder/ms-marco-MiniLM-L6-v2"


def snapshot_from_cache() -> Path | None:
    hub = (
        Path(os.environ.get("HF_HOME", str(Path.home() / ".cache" / "huggingface")))
        / "hub"
    )
    d = hub / ("models--" + MODEL_ID.replace("/", "--"))
    if not d.exists():
        return None
    snaps = d / "snapshots"
    if not snaps.exists():
        return None
    for child in sorted(snaps.iterdir()):
        if child.is_dir():
            return child
    return None


def main() -> int:
    src = snapshot_from_cache()
    if src is None:
        print("stage_reranker: not in HF cache; downloading via huggingface_hub")
        from huggingface_hub import snapshot_download

        src = Path(snapshot_download(MODEL_ID))
    if TARGET.exists():
        shutil.rmtree(TARGET)
    shutil.copytree(
        src, TARGET, ignore=shutil.ignore_patterns("*.msgpack", "*.h5", "*.onnx")
    )
    n = sum(1 for _ in TARGET.rglob("*") if _.is_file())
    print(f"stage_reranker: staged {n} files -> {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
