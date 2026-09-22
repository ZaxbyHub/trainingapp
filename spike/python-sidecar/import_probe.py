# Issue #57 sidecar boot bisection: import each heavy dependency in order
# inside the frozen onedir to pinpoint which native import kills the process
# (the full api_server entry segfaults pre-output, so Python-side bisection
# needs this driver). Packaged by import_probe.spec with the same bundle as
# the sidecar.
import os

MODS = [
    "numpy",
    "llama_cpp",
    "torch",
    "sentence_transformers",
    "onnxruntime",
    "chromadb.config",
    "chromadb",
    "uvicorn",
    "sse_starlette",
    "api_server",
]


def main() -> int:
    print("IMPORT-PROBE begin", flush=True)
    if os.environ.get("LLAMA_TEST_FIRST") == "1":
        try:
            from llama_cpp import Llama

            path = os.environ["RAG_GGUF_PATH"]
            print(f"LLAMA-FIRST loading {path}", flush=True)
            Llama(
                model_path=path, n_ctx=512, n_threads=4, verbose=True
            )  # noqa: F841 - load is the test
            print("LLAMA-FIRST load OK", flush=True)
        except BaseException as exc:  # noqa: BLE001 - crash-as-data probe
            print(
                f"LLAMA-FIRST FAIL {type(exc).__name__}: {str(exc)[:300]}", flush=True
            )
    for mod in MODS:
        try:
            __import__(mod)
            print(f"IMPORT {mod} OK", flush=True)
        except BaseException as exc:  # noqa: BLE001 - crash-as-data probe
            print(
                f"IMPORT {mod} FAIL {type(exc).__name__}: {str(exc)[:250]}", flush=True
            )
    if os.environ.get("LLAMA_TEST") == "1":
        try:
            from llama_cpp import Llama

            path = os.environ["RAG_GGUF_PATH"]
            print(f"LLAMA-TEST loading {path}", flush=True)
            Llama(
                model_path=path, n_ctx=512, n_threads=4, verbose=True
            )  # noqa: F841 - load is the test
            print("LLAMA-TEST load OK", flush=True)
        except BaseException as exc:  # noqa: BLE001 - crash-as-data probe
            print(f"LLAMA-TEST FAIL {type(exc).__name__}: {str(exc)[:300]}", flush=True)
    print("IMPORT-PROBE done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
