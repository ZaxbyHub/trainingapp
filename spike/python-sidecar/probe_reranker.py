# Issue #57 spike: reranker packaging-risk probe (three legs).
#
# The frozen build packages sentence-transformers 2.7 (repo pin <3.0.0),
# whose CrossEncoder does NOT accept the local_files_only kwarg that
# reranking.py:62 passes - so the exact production call shape cannot even
# execute (recorded as its own packaging finding). The three legs separate
# the questions honestly:
#
#   leg A - EXACT reranking.py:62 call shape, isolated empty HF_HOME.
#           Expected under the repo pin: TypeError (kwarg rejected) ->
#           outcome=INCOMPATIBLE_KWARG.
#   leg B - the cache-only lookup MECHANISM: model id by HF repo id, no
#           kwarg, HF_HUB_OFFLINE=1 + isolated empty HF cache. Expected:
#           OSError cache-miss -> outcome=REPRODUCED (this is the verdict
#           leg for reranker_local_files_only_reproduced).
#   leg C - the staged-model counterfactual: CrossEncoder over the model
#           files bundled into the build (bundled_reranker/) -> outcome=
#           LOADED_STAGED proves the packaged build CAN carry the reranker.
#
# Prints one line per leg; exits 0 either way (crash-as-data probe).
import os
import sys
import tempfile
from pathlib import Path


def frozen_base() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # noqa: SLF001 - PyInstaller convention
    return Path(__file__).resolve().parent


def staged_dir() -> Path:
    return frozen_base() / "bundled_reranker"


def fresh_modules() -> None:
    for mod in ("sentence_transformers", "huggingface_hub", "transformers"):
        sys.modules.pop(mod, None)


def classify(exc: Exception) -> str:
    """Honest verdict classification - never mislabel a failure class."""
    text = str(exc)
    if (
        "dynamic link library" in text
        or "WinError 1114" in text
        or "WinError 126" in text
    ):
        return f"PACKAGING_BLOCKED detail={type(exc).__name__}: {text[:300]}"
    if type(exc).__name__ == "TypeError" and "local_files_only" in text:
        return f"INCOMPATIBLE_KWARG detail={type(exc).__name__}: {text[:300]}"
    if "huggingface.co" in text or "cached files" in text:
        return f"REPRODUCED detail={type(exc).__name__}: {text[:300]}"
    return f"FAILED detail={type(exc).__name__}: {text[:300]}"


def main() -> int:
    if getattr(sys, "frozen", False):
        lib = frozen_base() / "torch" / "lib"
        if lib.is_dir():
            os.add_dll_directory(str(lib))

    with tempfile.TemporaryDirectory(prefix="spike-empty-hf-") as empty:
        os.environ["HF_HOME"] = empty
        os.environ["HF_HUB_OFFLINE"] = "1"

        # Leg A: exact reranking.py:62 call shape (kwarg included).
        fresh_modules()
        try:
            from sentence_transformers import CrossEncoder  # noqa: E402

            CrossEncoder("cross-encoder/ms-marco-MiniLM-L6-v2", local_files_only=True)
            print(
                "PROBE leg=A outcome=LOADED detail=kwarg accepted and cache existed",
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 - crash-as-data
            print(f"PROBE leg=A outcome={classify(exc)}".replace("\n", " "), flush=True)

        # Leg B: cache-only lookup mechanism, no kwarg, offline + empty cache.
        fresh_modules()
        try:
            from sentence_transformers import CrossEncoder  # noqa: E402

            CrossEncoder("cross-encoder/ms-marco-MiniLM-L6-v2")
            print("PROBE leg=B outcome=LOADED detail=unexpectedly loaded", flush=True)
        except Exception as exc:  # noqa: BLE001 - crash-as-data
            print(f"PROBE leg=B outcome={classify(exc)}".replace("\n", " "), flush=True)

    # Leg C: staged local model files (offline-safe; no kwarg needed).
    fresh_modules()
    try:
        os.environ["HF_HUB_OFFLINE"] = "1"
        from sentence_transformers import CrossEncoder  # noqa: E402

        target = staged_dir()
        if target.exists() and any(target.iterdir()):
            CrossEncoder(str(target))
            print(f"PROBE leg=C outcome=LOADED_STAGED detail={target}", flush=True)
        else:
            print(
                f"PROBE leg=C outcome=NO_STAGED_MODEL detail={target} missing",
                flush=True,
            )
    except Exception as exc:  # noqa: BLE001 - crash-as-data
        print(f"PROBE leg=C outcome={classify(exc)}".replace("\n", " "), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
