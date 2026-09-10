# ADR-0007: Calibrated relevance floor for the desktop hybrid retrieval pipeline

- Status: Accepted
- Date: 2026-09-09
- Deciders: B7 workstream (issue #65), consuming A4's tier-0 eval set (#54)
- Scope: `desktop/main/backend/retrieval/` — the `retrieval.relevanceFloor`
  default (desktop/main/backend/retrieval/config.ts
  `CALIBRATED_RELEVANCE_FLOOR`)

## Context

Issue #65 requires the Electron desktop backend's hybrid retrieval (sqlite-vec
+ FTS5 -> RRF -> cross-encoder reranker) to ship a relevance floor that is
RE-CALIBRATED against the reranker actually selected — not a copy of the
browser's un-revalidated `MIN_CROSS_SCORE = 0.2`
(web_ui/src/lib/rag/rag-orchestrator.ts:163). The floor gates the reranker's
sigmoid scores: after reranking, fused candidates with score < floor are
dropped (`>= floor` is kept). The floor is NEVER applied to raw RRF fused
scores — their ~0.03-max scale would empty every response (frozen C1
assertion).

The reranker in this pipeline is **ettin-reranker-32m-v1** — the same 32M
ModernBERT cross-encoder the web_ui browser-mode baseline runs
(q8 ONNX, sigmoid(logit) scoring). Issue #55 (ADR-0001) may later re-pin a
different model; per the issue's exit gate, this calibration is INVALIDATED by
that change and must be re-run against the ADR-ratified model.

## Procedure

1. **Corpus**: the A4 tier-0 eval corpus (eval/corpus, 8 documents) ingested
   through the B6 pipeline; 11 chunks. Labels come from the A4 tier-0 question
   set (eval/questions.jsonl): the 50 in-corpus questions with
   `expected_doc_id` (6 out-of-corpus abstention questions are excluded — they
   have no positive label).
2. **Model + scoring path**: the PRODUCTION worker path —
   `desktop/main/backend/retrieval/reranker.ts` `WorkerReranker` spawning
   `rerank-worker.ts`, loading `models/ettin-reranker-32m-v1/onnx` via
   transformers.js (q8), scoring every (question, chunk) pair with true pair
   tokenization and sigmoid(logit). 50 questions x 11 chunks = 550 scores.
3. **Labels**: a (question, chunk) score is a POSITIVE when the chunk's
   document basename equals the question's `expected_doc_id`, otherwise a
   NEGATIVE. Result: 71 positives, 479 negatives.
4. **Threshold selection**: pool all 550 scores; candidate thresholds are the
   midpoints of adjacent distinct sorted scores; pick the threshold maximizing
   F1 over the pooled set, counting `score >= threshold` as predicted
   relevant (smallest threshold wins ties).
5. **Record**: the selected threshold is written as the `floor:` line in this
   ADR and shipped as `CALIBRATED_RELEVANCE_FLOOR` in
   desktop/main/backend/retrieval/config.ts. The frozen C2 check asserts the
   two are the same double; the frozen C3 check re-derives the floor through
   the production worker and asserts |recomputed - documented| <= 0.05.

## Result

Calibration run 2026-09-09 (Windows dev station, ettin-reranker-32m-v1 q8,
transformers.js over onnxruntime-node):

- positives = 71, negatives = 479
- positive score min = 0.5513, negative score max = 0.6681 (the classes
  overlap — expected with whole-document chunks and a small corpus)
- F1-maximizing threshold = 0.569387 (F1 = 0.2281 on the pooled set)

floor: 0.569387

The low absolute F1 reflects the coarse labels (any chunk of the expected
document counts as relevant, so most negatives are "other documents of the
same corpus" rather than true non-relevant text) — the floor is a separating
hyperparameter for THIS reranker's score distribution, not a quality metric.
On the browser side the comparable setting is the un-measured 0.2; the
ettin distribution measured here centers well above it, so 0.2 would pass
almost every candidate (no filtering), while 0.57 keeps the top of the
distribution.

## Consequences

- `retrieval.relevanceFloor` defaults to 0.569387; operators can override via
  `TRAININGAPP_RETRIEVAL_RELEVANCE_FLOOR` (any finite float in [0, 1)).
- The floor is inert whenever the reranker is absent (weights not staged) or
  disabled (`retrieval.rerank=false` / a reranker worker failure) — RRF-only
  ordering is never floor-gated.
- **Re-validation trigger (issue #55 / ADR-0001)**: when the bake-off ratifies
  a different reranker (or a different quantization of this one), re-run the
  procedure above and update the `floor:` line and the constant together.
  The frozen C3 driver (repro/c3-floor-docs.sh in the issue trace) automates
  the re-derivation check.
- The bge-small QUERY-side instruction prefix (model-card asymmetric usage)
  was deliberately NOT adopted: the recorded parity baseline
  (eval/samples/report-devstation-weighted.json) was produced without it, and
  AC7's comparison must stay in one vector space. Adopting it later requires
  a fresh baseline run.
