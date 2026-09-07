# Benchmark Results (issue #52, WS-A PR 2/8)

One place for **measured** performance numbers: decode tok/s, first-token
latency, and embed/rerank cost for the candidate models, per machine.

**Provenance rules**

1. Every number in the tables below comes from a recorded driver run
   (`bench/llama_bench_driver.py`, `bench/wllama_bench_driver.mjs`,
   `bench/onnx_bench_driver.py`) merged via `bench/append_results.py`.
   No number is hand-patched; a value without a corresponding run is PENDING.
2. Rows are **machine-tagged**. A row's `machine` cell names the hardware the
   measurement came from. Dev-station numbers must never be read as
   reference-laptop numbers (or vice versa); evidence is invalidated when the
   machine changes — re-run, do not hand-patch.
3. A GPU fault during a Vulkan attempt is recorded as an outcome row, never hidden (fault rows carry the upstream issue link).
4. Tests read machine-tagged thresholds from the `bench-floors` block at the
   bottom of this file (`bench/floors.py`); a machine with no floors rows
   simply falls back to legacy bounds rather than inventing thresholds.

**Version pins used by the drivers:** `@wllama/wllama` 3.5.1 (the web_ui
package.json pin), llama.cpp external binary b10825 (llama-bench, CPU and
Vulkan builds), onnxruntime 1.27.0.

## Machine registry

### devstation

| field | value |
|---|---|
| CPU model | AMD Ryzen 9 5950X 16-Core Processor (16C/32T) |
| RAM | 128 GB (137328820224 bytes) |
| OS build | Microsoft Windows 10.0.26200 |
| GPU + driver | Intel(R) Arc(TM) Pro B50 Graphics, driver 32.0.101.8805 |
| llama.cpp | llama-cpp-python 0.3.35; external llama-bench b10825 (cpu-x64 + vulkan-x64) |
| wllama | @wllama/wllama 3.5.1 (node v24.16.0, headless Edge CDP) |
| onnxruntime | 1.27.0 (CPU EP, intra_op=4) |

### reference-i5

The reference laptop (Intel i5 mobile, 16 GB RAM, Iris Xe iGPU). **All
reference-i5 rows are PENDING until the operator runs the commands in
"Reproducing on the reference laptop" below.** Never fill these rows from a
different machine.

| field | value |
|---|---|
| CPU model | PENDING |
| RAM | PENDING |
| OS build | PENDING |
| GPU + driver | PENDING (integrated GPU; record the driver version exactly) |
| llama.cpp | PENDING |
| wllama | PENDING |
| onnxruntime | PENDING |

## Native llama.cpp CPU results

One row per (model x quant x threads x prompt length); decode tok/s over the
generated tokens after the first, `first_token_ms` measured from generation
start to the first streamed token (llama-bench engine reports a value derived
from prompt-processing throughput and marks it `derived`). All 36
reference-i5 matrix cells are PENDING until the laptop run; dev-station
cells are appended per recorded run.

| machine | model | quant | threads | prompt_tokens | decode_tok_s | first_token_ms | peak_rss_mb | engine | outcome |
|---|---|---|---|---|---|---|---|---|---|
| devstation | lfm2.5-vl-450m | Q4_K_M | 4 | 1024 | 95.97 | 1200.1 | 496.7 | llama-cpp-python | pass |
| devstation | lfm2.5-vl-450m | Q4_K_M | 8 | 1024 | 80.15 | 1311.9 | 497.3 | llama-cpp-python | pass |
| devstation | gemma-4-e2b-it | Q4_K_M | 4 | 1024 | 3.65 | 36813 | 2761.2 | llama-cpp-python | pass |
| devstation | gemma-4-e2b-it | Q4_K_M | 8 | 1024 | 2.12 | 17575.1 | 2761.4 | llama-cpp-python | pass |

## Vulkan attempt

Recorded pass/fail/crash per machine. A crash row references
llama.cpp issue #17389 (Gemma-3n family crash on Intel integrated GPUs),
the known failure mode motivating the crash-as-data rule.

| machine | model | bin | decode_tok_s | outcome | crash |
|---|---|---|---|---|---|
| reference-i5 | gemma-4-e2b-it Q4_K_M | llama-bench (vulkan build) | PENDING | PENDING | PENDING |
| devstation | gemma-4-e2b-it Q4_K_M | llama-bench (vulkan build) | 402.57 | pass | - |

## wllama (browser WASM) results

`threaded` = served with COOP/COEP (crossOriginIsolated, SharedArrayBuffer
available, n_threads = min(hardwareConcurrency, 4)); `single` = headers
stripped (corporate-proxy simulation), crossOriginIsolated false, n_threads 1.

| machine | model | mode | threads | prompt_tokens | decode_tok_s | first_token_ms | outcome |
|---|---|---|---|---|---|---|---|
| reference-i5 | lfm2.5-vl-450m | threaded | 4 | 256 | PENDING | PENDING | PENDING |
| reference-i5 | lfm2.5-vl-450m | single | 1 | 256 | PENDING | PENDING | PENDING |
| devstation | lfm2.5-vl-450m | threaded | 4 | 256 | 51.83 | 658.1 | pass |
| devstation | lfm2.5-vl-450m | single | 1 | 256 | 52.34 | 662.9 | pass |

## ONNX embed/rerank cost

CPU encoder cost (latency, not quality): `encode_ms` = median single-query
encode; `embeddings_per_second` = 16-doc batch throughput; `top15_ms` /
`top30_ms` = mean per-query cross-encoder scoring at 15/30 candidates.
Thread count: 4 (mirrors the desktop `n_threads` default, config.py:57).

| machine | model | encode_ms | embeddings_per_second | outcome |
|---|---|---|---|---|
| reference-i5 | bge-small-en-v1.5 | PENDING | PENDING | PENDING |
| reference-i5 | snowflake-arctic-embed-m-v1.5 | PENDING | PENDING | PENDING |
| devstation | bge-small-en-v1.5 | 3.317 | 526.2 | pass |
| devstation | snowflake-arctic-embed-m-v1.5 | 4.954 | 288.6 | pass |

| machine | model | top15_ms | top30_ms | outcome |
|---|---|---|---|---|
| reference-i5 | ettin-reranker-32m-v1 | PENDING | PENDING | PENDING |
| devstation | ettin-reranker-32m-v1 | 2.66 | 2.67 | pass |

## Reproducing on the reference laptop

```
# 1. stage assets (embed weights, ONNX models, the candidate GGUFs)
python bench/fetch_models.py --embed-weights --onnx
python bench/fetch_models.py --gguf LiquidAI/LFM2.5-1.2B-Instruct-GGUF:model-Q4_K_M.gguf:models/lfm2.5-1.2b-instruct/model-Q4_K_M.gguf
python bench/fetch_models.py --gguf LiquidAI/LFM2.5-1.2B-Instruct-GGUF:model-Q5_K_M.gguf:models/lfm2.5-1.2b-instruct/model-Q5_K_M.gguf
python bench/fetch_models.py --gguf google/gemma-3-1b-it-GGUF:model-Q4_K_M.gguf:models/gemma-3-1b-it/model-Q4_K_M.gguf  # gated repo: accept the license on HF first
python bench/fetch_models.py --gguf google/gemma-3-1b-it-GGUF:model-Q5_K_M.gguf:models/gemma-3-1b-it/model-Q5_K_M.gguf
python bench/fetch_models.py --gguf unsloth/gemma-4-E2B-it-GGUF:model-Q5_K_M.gguf:models/gemma-4-e2b-it/model-Q5_K_M.gguf

# 2. tag the machine and run the matrix (CPU), then the Vulkan attempt
set BENCH_MACHINE_TAG=reference-i5
set LLAMA_BENCH_BIN=<path to llama-bench.exe>
python bench/llama_bench_driver.py --print-machine

:: --- Git Bash / WSL (recommended): full 36-cell matrix ---
export BENCH_MACHINE_TAG=reference-i5
for model in gemma-4-e2b-it lfm2.5-1.2b-instruct gemma-3-1b-it; do
  for quant in Q4_K_M Q5_K_M; do
    for threads in 4 8; do
      for prompt in 1024 2048 3072; do
        python bench/llama_bench_driver.py --run-one --model "$model" --quant "$quant" --threads "$threads" --prompt-tokens "$prompt" --max-tokens 128 --json
      done
    done
  done
done
python bench/llama_bench_driver.py --vulkan-attempt --json

:: --- cmd.exe interactive equivalent (type %Q with single percent signs) ---
:: for %Q in (Q4_K_M Q5_K_M) do for %T in (4 8) do for %P in (1024 2048 3072) do python bench/llama_bench_driver.py --run-one --model gemma-4-e2b-it --quant %Q --threads %T --prompt-tokens %P --max-tokens 128 --json
:: (repeat per model, or save as a .bat file doubling the percent signs)

# 3. wllama browser matrix
node bench/wllama_bench_driver.mjs --run --model models/lfm2.5-vl-450m/model.gguf

# 4. ONNX embed/rerank cost
python bench/onnx_bench_driver.py --assets-dir models

# 5. merge rows (append_results refuses duplicates; never hand-edit numbers)
python bench/append_results.py --row-file <row.json>   # per emitted row

# 6. fill the reference-i5 floors block below from the recorded rows, then
#    run the perf suites for real PASS/FAIL evidence:
set BENCH_FLOORS_MACHINE=reference-i5
python -m pytest tests/test_rag_performance.py tests/test_low_end_hardware.py -v
```

## bench-floors (machine-tagged thresholds consumed by tests)

```bench-floors
{
  "floors": [
    {"surface": "onnx-embed", "model": "bge-small-en-v1.5", "machine": "devstation", "metric": "encode_ceiling_ms", "value": 6.6, "direction": "ceiling", "provenance": "devstation onnx row 3.317ms x2 slack"},
    {"surface": "onnx-embed", "model": "bge-small-en-v1.5", "machine": "devstation", "metric": "embeddings_per_second_floor", "value": 263, "direction": "floor", "provenance": "devstation onnx row 526.2/s /2 slack"},
    {"surface": "onnx-embed", "model": "snowflake-arctic-embed-m-v1.5", "machine": "devstation", "metric": "encode_ceiling_ms", "value": 9.9, "direction": "ceiling", "provenance": "devstation onnx row 4.954ms x2 slack"},
    {"surface": "onnx-embed", "model": "snowflake-arctic-embed-m-v1.5", "machine": "devstation", "metric": "embeddings_per_second_floor", "value": 144, "direction": "floor", "provenance": "devstation onnx row 288.6/s /2 slack"},
    {"surface": "onnx-rerank", "model": "ettin-reranker-32m-v1", "machine": "devstation", "metric": "top15_ceiling_ms", "value": 5.32, "direction": "ceiling", "provenance": "devstation onnx row 2.66ms x2 slack"},
    {"surface": "onnx-rerank", "model": "ettin-reranker-32m-v1", "machine": "devstation", "metric": "top30_ceiling_ms", "value": 5.34, "direction": "ceiling", "provenance": "devstation onnx row 2.67ms x2 slack"},
    {"surface": "native", "model": "lfm2.5-vl-450m", "machine": "devstation", "metric": "decode_floor_tps", "value": 40.0, "direction": "floor", "provenance": "devstation native row 95.97 tok/s (t=4) /2 slack"},
    {"surface": "native", "model": "gemma-4-e2b-it", "machine": "devstation", "metric": "decode_floor_tps", "value": 1.0, "direction": "floor", "provenance": "devstation native row 3.65 tok/s (t=4) - floor set well below to avoid CPU-state flakiness; the laptop row replaces this"}
  ]
}
```

Floors for the `rag` suite thresholds (query p95, ingestion ceilings) are
deliberately NOT recorded for devstation: the bench drivers measure encoder
and LLM cost, not the full ChromaDB query path, so no honest derivation
exists yet — those thresholds stay on legacy bounds until the reference-laptop
run records them (per the runbook step 6).

Floor rows are added per machine after that machine's runs are recorded
(`direction`: `floor` = metric must be >= value, `ceiling` = metric must be
<= value; `provenance` names the recorded row a threshold derives from).
`BENCH_FLOORS_MACHINE` selects the machine; a machine with no rows falls back
to the suites' legacy generous bounds. This block is parsed by
`bench/floors.py` — do not change its fence marker or JSON shape.
