# A5 Bake-off — Embedding and Reranker Selection (issue #55, ADR-0001)

Measured comparison of 4 embedding and 3 reranker candidates on the A4 tier-0
eval set, feeding `docs/adr/0001-embedding-reranker.md`. Decision artifact:
`results/bakeoff-results.json` (schema-validated by `schema.py`; the same
rules are enforced in CI by `tests/test_bakeoff_artifacts.py`).

## Method

- **Eval set (read-only):** `eval/questions.jsonl` (54 in-corpus + 6
  out-of-corpus) and `eval/corpus/` (8 markdown docs + 6 Storyline slide
  fixtures). The bake-off never modifies these; the A4 file set is hash-pinned
  by the issue-tracer preservation check.
- **Chunking:** the production chunker (`document_processor.DocumentProcessor`
  defaults: chunk_size 256, overlap 100) → 18 chunks, shared by all candidates.
  Slide JSON fixtures are embedded as `slide_title + on_screen_text +
  transcript_source`.
- **Metrics:** the same metric math as `eval/runner.py` — recall@k
  (k ∈ 1,3,5) over the ranked source list (doc-id-or-basename match, now with
  runner's backslash normalization; top-10 cut = contract max), MRR with
  unmatched in-corpus rows contributing 0 (runner divides by successful rows
  only; equivalent here because the offline drivers have no error rows).
  One disclosed pipeline difference from a production `/ask` call: the
  reranker stage scores a shared top-30 chunk pool (deduplicated to unique
  sources AFTER re-ranking), whereas the backend reranks its own retrieved
  pool — with an 18-chunk corpus both see effectively the whole index.
- **Retrieval pipeline:** cosine over candidate embeddings, top-30 pool; the
  reranker stage re-scores the pool and re-ranks (cut to 10). Reranker summary
  rows are measured on the fixed control embedding (`BAAI/bge-small-en-v1.5`,
  the current desktop pairing); the full 4×3 grid is in `combos`.
- **Per-candidate canonical prompting** (recorded per run in
  `prompts_used`): bge/arctic use the `Represent this sentence for searching
  relevant passages: ` query instruction; Qwen3 uses its model-card instruct
  prefix; EmbeddingGemma uses `task: search result | query: …` /
  `title: none | text: …` (verified against the onnx-community mirror README).
  The shipped Python surface embeds bare queries — a decision-relevant fact,
  not applied here (each candidate is scored at its documented best usage).
- **Threads:** pinned to 8 (end-user CPU profile per the interactive user's
  instruction): `torch.set_num_threads(8)` for quality runs; ONNX sessions
  use `intra_op_num_threads=8, inter_op=1` (the #52 harness's `make_session`
  with the new `--threads` flag).

## Model loading paths (provenance in `assets/assets-meta.json`)

| Candidate | Quality path | CPU-cost asset |
|---|---|---|
| `BAAI/bge-small-en-v1.5` | staged `models/` via sentence-transformers | dynamic-int8 quantized locally from staged fp32 |
| `Snowflake/snowflake-arctic-embed-m-v1.5` | canonical Snowflake repo (staged tree is ONNX-only) | staged shipped q8 graph |
| `google/embeddinggemma-300m` | official `onnx-community/embeddinggemma-300m-ONNX` fp32 graph — the canonical Google repo is **gated** (no token on the bake-off machine); graph outputs `sentence_embedding` directly | mirror's shipped int8 pair |
| `Qwen/Qwen3-Embedding-0.6B` | canonical Qwen repo via transformers + model-card last-token pooling (its ST config declares `pooling_mode_lasttoken`, unsupported by the pinned sentence-transformers 2.7) | mirror `model_quantized.onnx` (decoder-with-cache export; fed empty KV caches + position ids) |
| `cross-encoder/ettin-reranker-32m-v1` | **trained ST modules pipeline** (see below) | staged shipped q8 graph (encoder cost; see caveat) |
| `cross-encoder/ms-marco-MiniLM-L6-v2` | canonical repo via CrossEncoder | canonical hub repo's in-repo `onnx/` graph (downloaded), dynamic-int8 quantized locally |
| `BAAI/bge-reranker-v2-m3` | canonical repo via CrossEncoder | `onnx-community/bge-reranker-v2-m3-ONNX` int8 |

The ettin model is a sentence-transformers **modules-based** cross-encoder
(Transformer → CLS pool → Dense 384×384 GELU → LayerNorm → Dense 384×1).
sentence-transformers 2.7's `CrossEncoder` cannot load that layout (it builds
a random classification head), and **no ONNX export anywhere carries the
trained head** — upstream `onnx/` exports output `last_hidden_state` only.
Quality is therefore scored through the trained module weights
(`EttinModulesCrossEncoder` in `bakeoff_quality.py`), which reproduces the
model card's documented score range (probe: 8.24 relevant vs −2.75
irrelevant).

### Shipped-artifact defect (production finding, recorded in ADR-0001)

The repo-staged `models/ettin-reranker-32m-v1/onnx/model.onnx` and
`model_quantized.onnx` — the artifacts the browser reranker
(`web_ui/src/lib/search/reranker.ts`) and Electron `WorkerReranker` load —
output `logits` from an **untrained appended head**. Probe (2026-09-20): the
staged graph ranks `The cafeteria is open from 8am to 3pm` (logit 1.097)
above `Reimbursement for personal vehicle use is 67 cents per mile` (0.650)
for the query "What is the mileage rate for a personal car on business
travel?", in both pair orders and in both fp32 and q8; the canonical export
outputs raw `last_hidden_state` (no scores at all). Both relevance floors
calibrated against these artifacts (web `MIN_CROSS_SCORE=0.2`, Electron
`CALIBRATED_RELEVANCE_FLOOR=0.569387`) are calibrated against noise.

## Cost definitions

All CPU numbers are p50 over 20 trials (3 warm-ups) on dynamic-int8 / q8
ONNX graphs at 8 threads:

- **Embeddings, `top15/top30_ms_p50`:** wall time for (query encode through
  the graph + cosine against 15/30 pre-embedded candidates). Pooling applied
  for cost completeness (it does not meaningfully change encoder cost — same
  caveat as the #52 driver).
- **Rerankers, `top15/top30_ms_p50`:** wall time to sequentially score 15/30
  (query, passage) pairs; `pair_mean_ms_top15` keeps the #52 driver's
  per-pair mean for continuity.
- `p50` is the upper median over 20 trials (element 11 of the sorted list).
  Embedding measurements use 3 warm-up trials, reranker measurements 2 (the
  #52 driver's own values, kept for continuity); embed vs rerank latencies
  are therefore measured under slightly different warm-up conditions.

## Reproduction

```bash
# inside the repo .venv (sentence-transformers 2.7, transformers 4.57,
# torch CPU, onnxruntime; `pip install onnx` once for local quantization)
python eval/bakeoff/fetch_assets.py            # ~3.5 GB downloads, gitignored assets/
python eval/bakeoff/bakeoff_quality.py         # grid: 4 retrievals + 12 combos
python eval/bakeoff/bakeoff_cost.py            # 8-thread ONNX microbenchmark
python eval/bakeoff/collect.py                 # validates schema, writes results JSON
python bench/onnx_bench_driver.py --threads 8 --assets-dir models   # stock #52 harness
```

`fetch_assets.py` needs `HF_HUB_DISABLE_SYMLINKS=1` on Windows without the
symlink privilege. Drivers resolve locally staged (git-excluded) `models/`
trees via `$TRAININGAPP_MAIN_CHECKOUT`, falling back to the conventional
sibling checkout `../trainingapp` when it exists; with neither, every candidate
falls back to hub downloads. ONNX sourcing trust: canonical repos are preferred
and community `onnx-community/*` mirrors are used only where the canonical
author publishes no ONNX; the exact revision fetched is recorded post-hoc per
candidate in `assets/assets-meta.json` (mirrored to
`results/assets-meta.json` by `collect.py`), not pinned at download time.
The ettin quality leg additionally stages the trained ST head modules into
`assets/ettin-reranker-32m-v1-compat/` (fetch_assets does this automatically).

## Deviation log (recorded in `results/bakeoff-results.json`)

1. EmbeddingGemma quality via the official ONNX mirror (canonical weights
   gated). fp32 graph, model-card prompts; measured dims 768 match the model
   card.
2. Qwen3 quality via transformers + last-token pooling (ST 2.7 lacks the
   declared pooling mode). Measured dims 1024.
3. ettin quality via the trained modules pipeline (ST 2.7 CrossEncoder
   incompatible; shipped ONNX artifact defective as above).
4. Qwen3 cost asset is a decoder-with-cache export; the cost driver feeds
   empty KV caches and explicit position ids (shapes read from the graph).
5. ettin cost measures the staged q8 **encoder** graph. A correct full
   export's cost equals encoder cost plus a negligible 384×384 + 384×1 head.

## Methodology execution log

Single-machine run (2026-09-20, `bakeoff-i55`, 8-thread cap,
`torch.set_num_threads(8)` / ORT `intra_op=8`):

| stage | wall clock | evidence |
|---|---|---|
| `fetch_assets.py` (weights + ONNX + licenses) | ~19 min (3 rounds; symlink fallback) | `assets/assets-meta.json` per-candidate timings |
| feasibility gate (7/7 candidates load) | ~14 s | trace `evidence/feasibility.log`, `results/feasibility.json` |
| `bakeoff_quality.py` (corrected ettin) | 2.6 min (155.9 s sum of per-candidate entries) | `execution_log` in results JSON |
| `bakeoff_cost.py` | 0.95 min (56.7 s sum of per-candidate entries) | `execution_log` in results JSON |
| reranker-validity probes (staged-artifact defect) | ~2 min | trace `evidence/reranker-probe.log` |

Quality rows are deterministic given the pinned assets (no sampling; exact
arithmetic); cost rows are p50 timings and vary by machine load — the
committed values are from the run above on an otherwise-idle machine.
