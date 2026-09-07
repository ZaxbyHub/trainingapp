#!/usr/bin/env python3
"""Native llama.cpp benchmark driver (issue #52 bench harness).

Measures decode tok/s, first-token latency and peak RSS for the candidate GGUF
models on CPU, and records a Vulkan attempt (crash-as-data) via an external
llama.cpp build.

Engines, in auto order:
  * llama-cpp-python - the shipping desktop stack (llm_interface.GGUFBackend
    wraps llama_cpp.Llama, so this measures exactly what the app runs).
  * llama-bench      - an external llama.cpp binary (also the only path that
    exercises a Vulkan build; pass --bin or set LLAMA_BENCH_BIN).

Rows carry a machine tag from BENCH_MACHINE_TAG (default "devstation");
reference-laptop runs set BENCH_MACHINE_TAG=reference-i5 so dev-station numbers
can never be mistaken for the reference baseline.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# The three candidate model families named by issue #52. Ids carry the
# substrings the acceptance matrix matches on ("gemma"+"e2b", "lfm2",
# "gemma"+"1b"); keep that true if ids are ever renamed.
MODEL_FAMILIES = [
    {"model": "gemma-4-e2b-it", "dir": "gemma-4-e2b-it", "file_stem": "model"},
    {
        "model": "lfm2.5-1.2b-instruct",
        "dir": "lfm2.5-1.2b-instruct",
        "file_stem": "model",
    },
    {"model": "gemma-3-1b-it", "dir": "gemma-3-1b-it", "file_stem": "model"},
]
QUANTS = ("Q4_K_M", "Q5_K_M")
THREAD_CHOICES = (4, 8)  # config.py:57 desktop default is 4; 8 is the #53 sweep arm
PROMPT_CHOICES = (1024, 2048, 3072)

LLAMA_CPP_ISSUE_17389 = "https://github.com/ggml-org/llama.cpp/issues/17389"


def build_matrix() -> list:
    cells = []
    for fam in MODEL_FAMILIES:
        for quant in QUANTS:
            for threads in THREAD_CHOICES:
                for prompt_tokens in PROMPT_CHOICES:
                    cells.append(
                        {
                            "model": fam["model"],
                            "quant": quant,
                            "threads": threads,
                            "prompt_tokens": prompt_tokens,
                        }
                    )
    return cells


def assets_dir() -> Path:
    return Path(os.environ.get("BENCH_ASSETS_DIR", str(REPO_ROOT / "models")))


def default_model_path(model: str, quant: str) -> Path:
    for fam in MODEL_FAMILIES:
        if fam["model"] == model:
            return assets_dir() / fam["dir"] / f"{fam['file_stem']}-{quant}.gguf"
    raise SystemExit(f"unknown model family: {model}")


def machine_tag() -> str:
    return (os.environ.get("BENCH_MACHINE_TAG", "") or "devstation").strip()


def capture_machine_tuple() -> dict:
    info = {
        "machine": machine_tag(),
        "platform": sys.platform,
        "python": sys.version.split()[0],
    }
    try:
        import psutil

        info["ram_total_gb"] = round(psutil.virtual_memory().total / (1024**3), 1)
    except Exception:
        info["ram_total_gb"] = None
    try:
        if sys.platform == "win32":
            out = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "(Get-CimInstance Win32_Processor).Name; "
                    "(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name; "
                    "(Get-CimInstance Win32_VideoController | "
                    "Select-Object -First 1).DriverVersion; "
                    "[System.Environment]::OSVersion.Version.ToString()",
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            lines = [ln.strip() for ln in (out.stdout or "").splitlines() if ln.strip()]
            if len(lines) >= 4:
                info["cpu_model"] = lines[0]
                info["gpu_model"] = lines[1]
                info["gpu_driver"] = lines[2]
                info["os_build"] = lines[3]
        else:
            import platform

            info["cpu_model"] = platform.processor()
            info["os_build"] = platform.release()
    except Exception:
        pass
    try:
        import llama_cpp

        info["llama_cpp_python"] = getattr(llama_cpp, "__version__", "unknown")
    except Exception:
        info["llama_cpp_python"] = None
    bin_path = os.environ.get("LLAMA_BENCH_BIN", "")
    info["llama_bench"] = bin_path or None
    return info


class RssSampler:
    """Peak-RSS sampler (MB) over the current process tree."""

    def __init__(self, interval_s: float = 0.05):
        self.interval_s = interval_s
        self.peak_mb = 0.0
        self._stop = threading.Event()
        self._thread = None

    def _sample_once(self) -> float:
        total = 0.0
        try:
            import psutil

            proc = psutil.Process()
            total = proc.memory_info().rss
            for child in proc.children(recursive=True):
                try:
                    total += child.memory_info().rss
                except Exception:
                    pass
        except Exception:
            pass
        return total / (1024.0 * 1024.0)

    def start(self):
        def loop():
            while not self._stop.is_set():
                self.peak_mb = max(self.peak_mb, self._sample_once())
                self._stop.wait(self.interval_s)

        self.peak_mb = self._sample_once()
        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def stop(self) -> float:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        self.peak_mb = max(self.peak_mb, self._sample_once())
        return round(self.peak_mb, 1)


def make_prompt(tokenizer, target_tokens: int) -> str:
    """Deterministic prompt of approximately target_tokens tokens."""
    base = (
        "Training documentation explains how the on-device assistant retrieves "
        "answers from indexed course material using hybrid search. "
    )
    text = base * max(1, target_tokens // 16 + 1)
    ids = tokenizer.encode(text)[:target_tokens]
    return tokenizer.decode(ids)


def model_display_name(model_path: Path) -> str:
    """RESULTS.md model cell for a GGUF path: the directory name for the
    canonical asset layouts (model.gguf, model-<QUANT>.gguf, gguf.gguf),
    the file stem otherwise."""
    if model_path.stem in ("model", "gguf") or model_path.stem.startswith("model-"):
        return model_path.parent.name
    return model_path.stem


def run_with_llama_cpp(
    model_path: Path, quant: str, threads: int, prompt_tokens: int, max_tokens: int
) -> dict:
    try:
        import llama_cpp
    except ImportError as exc:
        raise RuntimeError(
            "llama_cpp is not importable; install llama-cpp-python or set "
            "LLAMA_BENCH_BIN to an external llama-bench binary"
        ) from exc

    row = {
        "surface": "native",
        "engine": "llama-cpp-python",
        "llama_cpp_python": getattr(llama_cpp, "__version__", "unknown"),
        "model": model_display_name(model_path),
        "model_path": str(model_path),
        "quant": quant,
        "threads": threads,
        "prompt_tokens": prompt_tokens,
        "max_tokens": max_tokens,
        "machine": machine_tag(),
    }
    sampler = RssSampler()
    sampler.start()
    t0 = time.perf_counter()
    llm = llama_cpp.Llama(
        model_path=str(model_path),
        n_ctx=prompt_tokens + max_tokens + 128,
        n_threads=threads,
        verbose=False,
    )
    load_s = time.perf_counter() - t0

    prompt = make_prompt(llm.tokenizer(), prompt_tokens)
    # Warmup (unmeasured): primes allocator and KV-cache paths.
    llm.create_completion(prompt=prompt[:256], max_tokens=4, temperature=0.0)

    first_token_ms = None
    t_first = None
    t_end = None
    n_generated = 0
    stream = llm.create_completion(
        prompt=prompt, max_tokens=max_tokens, temperature=0.0, stream=True
    )
    for _ in stream:
        now = time.perf_counter()
        if t_first is None:
            t_first = now
            first_token_ms = (now - t0) * 1000.0
        n_generated += 1
        t_end = now
    peak_rss_mb = sampler.stop()

    decode_s = (
        (t_end - t_first)
        if (t_first and t_end and t_end > t_first and n_generated > 1)
        else 0.0
    )
    row.update(
        {
            "load_s": round(load_s, 3),
            "first_token_ms": round(first_token_ms, 1)
            if first_token_ms is not None
            else None,
            "tokens_generated": n_generated,
            "decode_tokens_per_second": round((n_generated - 1) / decode_s, 2)
            if decode_s > 0
            else None,
            "peak_rss_mb": peak_rss_mb,
            "outcome": "pass" if n_generated > 0 else "fail",
        }
    )
    return row


def run_with_llama_bench(
    llama_bench_bin: str,
    model_path: Path,
    quant: str,
    threads: int,
    prompt_tokens: int,
    max_tokens: int,
    extra_args=None,
) -> dict:
    cmd = [
        llama_bench_bin,
        "-m",
        str(model_path),
        "-p",
        str(prompt_tokens),
        "-n",
        str(max_tokens),
        "-t",
        str(threads),
        "-r",
        "1",
        "-o",
        "json",
    ]
    if extra_args:
        cmd.extend(extra_args)
    sampler = RssSampler()
    sampler.start()
    timed_out = False
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, errors="replace", timeout=900
        )
    except subprocess.TimeoutExpired:
        timed_out = True
    peak_rss_mb = sampler.stop()
    row = {
        "surface": "native",
        "engine": "llama-bench",
        "model": model_display_name(model_path),
        "model_path": str(model_path),
        "quant": quant,
        "threads": threads,
        "prompt_tokens": prompt_tokens,
        "max_tokens": max_tokens,
        "machine": machine_tag(),
        "peak_rss_mb": peak_rss_mb,
    }
    if timed_out:
        row.update(
            {
                "outcome": "fail",
                "error": "llama-bench timed out after 900s",
            }
        )
        return row
    if proc.returncode != 0:
        row.update(
            {
                "outcome": "fail",
                "exit_code": proc.returncode,
                "stderr_tail": (proc.stderr or "")[-400:],
            }
        )
        return row
    try:
        results = json.loads(proc.stdout)
        pp_tps = tg_tps = None
        for first in results if isinstance(results, list) else [results]:
            if not isinstance(first, dict):
                continue
            # llama.cpp >= b6xxx schema: one object per test with n_prompt /
            # n_gen and avg_ts (tokens/second). Legacy schema used avg_pp/avg_tg.
            if first.get("n_prompt") and not first.get("n_gen"):
                pp_tps = pp_tps or float(
                    first.get("avg_ts") or first.get("avg_pp") or 0
                )
            elif first.get("n_gen") or first.get("avg_tg"):
                tg_tps = tg_tps or float(
                    first.get("avg_ts") or first.get("avg_tg") or 0
                )
        row.update(
            {
                "prompt_processing_tokens_per_second": round(pp_tps, 2)
                if pp_tps
                else None,
                "decode_tokens_per_second": round(tg_tps, 2) if tg_tps else None,
                # llama-bench has no first-token metric; derive from prompt
                # processing throughput and mark it derived, never measured.
                "first_token_ms": round(prompt_tokens / pp_tps * 1000.0, 1)
                if pp_tps
                else None,
                "first_token_ms_derived": True,
                "outcome": "pass" if tg_tps else "fail",
            }
        )
    except Exception as exc:
        row.update(
            {
                "outcome": "fail",
                "parse_error": str(exc),
                "stdout_tail": (proc.stdout or "")[-400:],
            }
        )
    return row


def run_vulkan_attempt(vulkan_bin: str, model_path, quant_arg: str = "Q4_K_M") -> dict:
    """Recorded Vulkan attempt: crash-as-data, this mode always exits 0."""

    def model_label() -> str:
        # RESULTS.md vulkan table documents the model cell as "<model> <quant>"
        # so appended rows are reproducible from the driver alone.
        return f"{model_display_name(model_path)} {quant_arg}"

    row = {
        "surface": "native-vulkan",
        "engine": "llama-bench",
        # Portable label for RESULTS.md (absolute paths are machine-specific);
        # the full path is preserved in bin_path for provenance.
        "bin": "llama-bench (vulkan build)",
        "bin_path": vulkan_bin,
        "model": model_label() if model_path else None,
        "machine": machine_tag(),
    }
    if not vulkan_bin or not Path(vulkan_bin).is_file():
        row.update(
            {
                "outcome": "fail",
                "error": f"vulkan llama-bench binary not found: {vulkan_bin!r}",
            }
        )
        return row
    if model_path is None or not Path(model_path).is_file():
        row.update(
            {
                "outcome": "fail",
                "error": "no local GGUF available for the vulkan attempt",
            }
        )
        return row
    cmd = [
        vulkan_bin,
        "-m",
        str(model_path),
        "-p",
        "512",
        "-n",
        "64",
        "-t",
        "4",
        "-ngl",
        "99",
        "-r",
        "1",
        "-o",
        "json",
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, errors="replace", timeout=600
        )
    except subprocess.TimeoutExpired:
        row.update(
            {
                "outcome": "crash",
                "error": "timeout after 600s",
                "known_issue": LLAMA_CPP_ISSUE_17389,
            }
        )
        return row
    row["exit_code"] = proc.returncode
    # Windows GPU-driver faults surface as large exception codes
    # (e.g. 3221225477 = STATUS_ACCESS_VIOLATION), not small errno values.
    if proc.returncode == 0:
        try:
            results = json.loads(proc.stdout)
            tg_tps = pp_tps = None
            for first in results if isinstance(results, list) else [results]:
                if not isinstance(first, dict):
                    continue
                if first.get("n_prompt") and not first.get("n_gen"):
                    pp_tps = pp_tps or float(
                        first.get("avg_ts") or first.get("avg_pp") or 0
                    )
                elif first.get("n_gen") or first.get("avg_tg"):
                    tg_tps = tg_tps or float(
                        first.get("avg_ts") or first.get("avg_tg") or 0
                    )
            row.update(
                {
                    "outcome": "pass" if tg_tps else "fail",
                    "decode_tokens_per_second": round(tg_tps, 2) if tg_tps else None,
                    "prompt_processing_tokens_per_second": round(pp_tps, 2)
                    if pp_tps
                    else None,
                }
            )
        except Exception as exc:
            row.update({"outcome": "fail", "parse_error": str(exc)})
    elif proc.returncode < 0 or proc.returncode > 128:
        row.update(
            {
                "outcome": "crash",
                "stderr_tail": (proc.stderr or "")[-400:],
                "known_issue": LLAMA_CPP_ISSUE_17389,
            }
        )
    else:
        row.update({"outcome": "fail", "stderr_tail": (proc.stderr or "")[-400:]})
    return row


def emit(rows, json_path: None = None) -> None:
    payload = rows if len(rows) > 1 else rows[0]
    text = json.dumps(payload, ensure_ascii=True, indent=2)
    print(text)
    if json_path and json_path != "-":
        Path(json_path).parent.mkdir(parents=True, exist_ok=True)
        Path(json_path).write_text(text + "\n", encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Native llama.cpp benchmark driver (CPU matrix + recorded "
        "Vulkan attempt, crash-as-data)."
    )
    parser.add_argument(
        "--list-matrix",
        action="store_true",
        help="print the full benchmark matrix as JSON cells",
    )
    parser.add_argument(
        "--run-one",
        action="store_true",
        help="run a single (model, quant, threads, prompt) cell",
    )
    parser.add_argument(
        "--vulkan-attempt",
        action="store_true",
        help="attempt inference on Vulkan via an external "
        "llama-bench binary; records pass/fail/crash as data",
    )
    parser.add_argument(
        "--print-machine",
        action="store_true",
        help="print the captured machine tuple and exit",
    )
    parser.add_argument("--model-path", type=str, default=None)
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="model family id (resolves a default path under " "BENCH_ASSETS_DIR)",
    )
    parser.add_argument("--quant", type=str, default="Q4_K_M", choices=list(QUANTS))
    parser.add_argument("--threads", type=int, default=4, choices=list(THREAD_CHOICES))
    parser.add_argument("--prompt-tokens", type=int, default=1024)
    parser.add_argument("--max-tokens", type=int, default=64)
    parser.add_argument(
        "--engine", choices=("auto", "python", "llama-bench"), default="auto"
    )
    parser.add_argument(
        "--bin",
        type=str,
        default=None,
        help="external llama-bench binary (defaults to LLAMA_BENCH_BIN)",
    )
    parser.add_argument(
        "--ngl",
        type=int,
        default=None,
        help="-ngl value forwarded to llama-bench (GPU layers)",
    )
    parser.add_argument(
        "--json",
        nargs="?",
        const="-",
        default=None,
        help="optionally write the JSON row(s) to this file "
        "(JSON always goes to stdout)",
    )
    args = parser.parse_args(argv)

    if args.print_machine:
        emit([capture_machine_tuple()], args.json)
        return 0

    if args.list_matrix:
        emit([{"cells": build_matrix()}], args.json)
        return 0

    if args.vulkan_attempt:
        if args.model_path:
            model_path = Path(args.model_path)
        else:
            candidate = default_model_path("gemma-4-e2b-it", "Q4_K_M")
            if candidate.is_file():
                model_path = candidate
            else:
                alt = assets_dir() / "lfm2.5-vl-450m" / "model.gguf"
                model_path = alt if alt.is_file() else None
        vulkan_bin = args.bin or os.environ.get("LLAMA_BENCH_BIN", "")
        emit([run_vulkan_attempt(vulkan_bin, model_path, args.quant)], args.json)
        return 0  # crash-as-data: the attempt mode never fails the harness

    if args.run_one:
        if args.model_path:
            model_path = Path(args.model_path)
        elif args.model:
            model_path = default_model_path(args.model, args.quant)
        else:
            parser.error("--run-one requires --model-path or --model")
            return 2
        if not model_path.is_file():
            print(
                json.dumps(
                    {"outcome": "fail", "error": f"model file not found: {model_path}"},
                    ensure_ascii=True,
                )
            )
            return 1
        bench_bin = args.bin or os.environ.get("LLAMA_BENCH_BIN", "")
        use_python = args.engine == "python" or (
            args.engine == "auto" and not bench_bin
        )
        if use_python:
            try:
                row = run_with_llama_cpp(
                    model_path,
                    args.quant,
                    args.threads,
                    args.prompt_tokens,
                    args.max_tokens,
                )
            except RuntimeError as exc:
                print(
                    json.dumps(
                        {"outcome": "fail", "error": str(exc)}, ensure_ascii=True
                    )
                )
                return 1
        else:
            if not bench_bin or not Path(bench_bin).is_file():
                print(
                    json.dumps(
                        {
                            "outcome": "fail",
                            "error": f"llama-bench binary not found: {bench_bin!r}",
                        },
                        ensure_ascii=True,
                    )
                )
                return 1
            extra = ["-ngl", str(args.ngl)] if args.ngl is not None else None
            row = run_with_llama_bench(
                bench_bin,
                model_path,
                args.quant,
                args.threads,
                args.prompt_tokens,
                args.max_tokens,
                extra_args=extra,
            )
        emit([row], args.json)
        return 0 if row.get("outcome") == "pass" else 1

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
