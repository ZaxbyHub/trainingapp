# ADR-0001: Embedding and reranker models for all surfaces

- **Status:** Accepted (2026-09-20)
- **Issue:** [#55 (A5, Workstream A)](https://github.com/ZaxbyHub/trainingapp/issues/55)
- **Evidence:** `eval/bakeoff/results/bakeoff-results.json` (machine-readable, schema-validated), `eval/bakeoff/results/adr-comparison-table.md`, methodology in `eval/bakeoff/README.md`

## Context

Three surfaces currently hardcode three different model pairs, chosen without measurement:

| Surface | Embedding | Reranker |
|---|---|---|
| Python desktop / API (`vector_store.py:67`, `config.py:70`) | `BAAI/bge-small-en-v1.5` (384-dim) | `cross-encoder/ms-marco-MiniLM-L6-v2`, disabled by default, inert on shipped installs |
| Browser web_ui (`embedding-service.ts:28`, web `reranker.ts`) | `Snowflake/snowflake-arctic-embed-m-v1.5` q8 (768-dim) | `ettin-reranker-32m-v1` q8 |
| Electron/Node backend (`desktop/.../embedder.ts:27`, `desktop/.../reranker.ts:65`) | `bge-small-en-v1.5` fp32 ONNX (384-dim hardcoded in `store/sqlite-store.ts:32`) | `ettin-reranker-32m-v1` q8 |

There is no deployed embedding index (implementation_plan.md §4: "no deployed clients, so there is no compatibility constraint"), so the model choice is free to follow measurement.

This bake-off (#55) scored all four embedding candidates and all three reranker candidates on the A4 tier-0 eval set (`eval/questions.jsonl` + `eval/corpus`, 54 in-corpus questions, production chunker, per-model canonical query/passage prompts) with metric definitions identical to `eval/runner.py`, and measured CPU cost at an 8-thread cap (end-user profile) on q8 ONNX graphs through the #52 benchmark harness. Full methodology, per-candidate prompts, provenance, and deviations: `eval/bakeoff/README.md`.

A prerequisite finding shaped the data: the repo-staged `models/ettin-reranker-32m-v1/onnx/model.onnx` and `model_quantized.onnx` — the artifacts shipped by the browser and Electron rerankers — output `logits` from an **untrained appended head**. `cross-encoder/ettin-reranker-32m-v1` is a sentence-transformers modules-based cross-encoder (Transformer → CLS pool → Dense 384×384 GELU → LayerNorm → Dense 384×1); its trained head lives only in the ST module directories (`2_Dense`/`3_LayerNorm`/`4_Dense`) and in no ONNX export anywhere (upstream `onnx/` exports output `last_hidden_state` only). Verified by execution: the staged graph ranks a cafeteria sentence above the mileage-rate answer for a mileage query; the trained-head pipeline scores 8.24 vs −2.75 on the same pair. Quality numbers below measure the trained model; the shipped artifact defect is a follow-up.

## Comparison

Bake-off results at 8 threads (q8 ONNX; recall@k over the ranked source list, MRR per `eval/runner.py` semantics; embedding rows are retrieval-only; reranker rows measured on the fixed control embedding `BAAI/bge-small-en-v1.5` — the current desktop pairing; the full 4×3 grid is in the results JSON):

| Candidate | dims | recall@1/3/5 | MRR | CPU top15 p50 (ms) | CPU top30 p50 (ms) | license |
|---|---|---|---|---|---|---|
| BAAI/bge-small-en-v1.5 (control, desktop) | 384 | 0.093 / 0.259 / 0.574 | 0.266 | 2.7 | 2.3 | MIT |
| Snowflake/snowflake-arctic-embed-m-v1.5 (control, web) | 768 | 0.093 / 0.315 / 0.556 | 0.268 | 6.8 | 6.5 | Apache-2.0 |
| google/embeddinggemma-300m | 768 | 0.093 / 0.370 / 0.593 | 0.293 | 152.8 | 144.9 | Gemma Terms of Use (custom, non-OSI) |
| Qwen/Qwen3-Embedding-0.6B | 1024 | 0.148 / 0.333 / 0.685 | 0.342 | 36.1 | 34.5 | Apache-2.0 |
| cross-encoder/ettin-reranker-32m-v1 | – | 0.111 / 0.315 / 0.556 | 0.298 | 79.3 | 136.1 | Apache-2.0 |
| cross-encoder/ms-marco-MiniLM-L6-v2 | – | 0.093 / 0.259 / 0.574 | 0.266 | 37.8 | 75.6 | Apache-2.0 |
| BAAI/bge-reranker-v2-m3 | – | 0.093 / 0.259 / 0.574 | 0.266 | 482.8 | 879.0 | Apache-2.0 |

Reading the grid (`combos` in the results JSON): on every weaker retriever the trained ettin head is the only reranker that moves ranking quality up (MRR 0.266→0.298 on the control embedding; 0.268→0.323 on the web control; 0.293→0.310 on EmbeddingGemma), while the other two rerankers leave the ranked sources unchanged on this 18-chunk corpus, where a top-30 pool saturates the index. On the strongest retriever below, no reranker improves the metrics and ettin slightly reduces MRR (0.342→0.303) — the corpus is too small for reranking to add signal, which the follow-ups address with a larger-set re-evaluation.

## Decision

One embedding model for all surfaces (desktop Python, browser web_ui, Electron/Node): **`Qwen/Qwen3-Embedding-0.6B`**, dims: 1024 (`{model_id: "Qwen/Qwen3-Embedding-0.6B", dims: 1024}` for C1/#68 and `contracts/pack.schema.json`).

One reranker model for all surfaces: **`cross-encoder/ettin-reranker-32m-v1`** (org-qualified canonical id; the staged-name form `ettin-reranker-32m-v1` refers to the same model).

Rationale in brief: the chosen embedding wins every quality metric by a wide margin (MRR 0.342 vs 0.293 next best; recall@5 0.685 vs 0.593) at 36 ms p50 q8 encode on 8 threads — 13× the cheapest candidate but 4× cheaper than the only 768-dim alternative measured, and Apache-2.0 licensed (friendly to #56's distributability gate, unlike the Gemma Terms of Use). The chosen reranker is the only candidate that measurably improves ranking (MRR +0.032 to +0.055 on three of four retrievers) at mid-tier cost (136 ms top-30), also Apache-2.0. Both decisions bind the desktop default (`config.py`), the browser model manifest, and the Electron embedder/reranker subpaths, to be re-pinned by downstream "per ADR-0001" issues.

## Consequences

1. **Retrieval query prompting becomes load-bearing.** The winner requires its model-card query instruction (`Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: {query}`) and last-token pooling; the reranker requires its trained modules head. The Python surface currently embeds bare queries (`vector_store.py:965`) — the desktop re-pin issue must add the instruction and pooling, mirroring what the browser already does for its model (`rag-orchestrator.ts:162`).
2. **Vector width changes from 384 to 1024.** The Electron store hardcodes 384 (`desktop/main/backend/store/sqlite-store.ts:32`, `types.ts:129-132`) and the pack schema records embedding dims — downstream issues must widen stores, re-embed indexes, and bump `contracts/pack.schema.json`'s `embedding.dims` expectations alongside the model id this ADR freezes.
3. **A correct ONNX export of the reranker must be produced before any surface ships it.** No public ONNX export of `cross-encoder/ettin-reranker-32m-v1` carries its trained head; downstream must export the full modules pipeline (encoder + Dense/LayerNorm/Dense head). Until then, every surface's reranking stage is running noise (see Context and follow-ups).
4. **Score-scale recalibration.** The web `MIN_CROSS_SCORE=0.2` (`rag-orchestrator.ts:179`, already documented un-revalidated) and the Electron `CALIBRATED_RELEVANCE_FLOOR=0.569387` (`desktop/.../retrieval/config.ts:50`, ADR-0007) were calibrated against the defective staged artifact and must be re-derived against the trained-head export; the trained head's raw scores span roughly −3 to +9 on this corpus.
5. **CPU budget.** At the measured costs, a full retrieve+rerank interaction on the reference profile spends ~36 ms embedding + ~79–136 ms reranking at top-15/30 — well inside the interactive budget, and the #52/#8 memory-budget work keeps the resident-set impact bounded.
6. **Quality evidence is tier-0 bound.** All numbers come from the 54-question tier-0 set on an 18-chunk corpus (per the issue's exit gate, a material eval-set revision requires re-running this bake-off); reranker deltas in particular need re-measurement on larger real corpora.

## Follow-ups

1. **Desktop reranker packaging defect (named by #55, fix out of scope here):** `reranking.py:62` constructs `CrossEncoder(..., local_files_only=True)` while no HF cache is bundled (`DocumentQAApp.spec:5`, `AFOMIS.spec:19` ship `models/` only), so the configured cross-encoder can never load on shipped installs and retrieval silently falls back to plain top-k (`rag_engine.py:648-695`). Track and fix in a dedicated issue.
2. **Defective shipped ettin artifacts (found by this bake-off):** `models/ettin-reranker-32m-v1/onnx/model.onnx` and `model_quantized.onnx` emit logits from an untrained appended head (probes in `eval/bakeoff/README.md`); the browser reranker (`web_ui/src/lib/search/reranker.ts:205-208`) and Electron `WorkerReranker` score with them today. Replace with an export of the trained modules pipeline and re-derive both relevance floors (Consequences 3–4).
3. **Canonical-id correction for the audit record:** `audit_report.md` line 37 claims `cross-encoder/ms-marco-MiniLM-L-6-v2` (the code's configured id) is non-canonical and `...MiniLM-L-6-v2` is canonical. The live HF API (2026-09-20) shows the opposite: the non-hyphenated id is the 88.6M-download canonical repo and the hyphenated form aliases to it. No hyphen "fix" is needed; the issue text's AC2 wording is satisfied by recording the verified canonical id here.
4. **Downstream re-pin issues "per ADR-0001"** (implementation explicitly out of scope for #55): Python desktop (`config.py`, `vector_store.py`, query instruction + pooling), browser (`model-manifest.ts`, bundled weights, floor re-derivation), Electron (`embedder.ts` subpath + 1024-dim store widening, `reranker.ts` subpath + correct export), `contracts/pack.schema.json` embedding model/dims fields, and packtool prebuilt-index embeddings.
5. **Re-run this bake-off's quality leg when the A4 eval set grows materially** (issue #55 exit gate), including reranker deltas on a larger corpus where top-30 pools do not saturate.

## Waivers (or none)

None. All acceptance criteria for #55 are closed with committed evidence; no Full-Resolution Contract clause was waived.
