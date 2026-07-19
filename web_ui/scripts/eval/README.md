# Retrieval Eval Harness (Issue #37 §5)

A small, dependency-light retrieval-quality harness that gates model-swap and
retrieval-pipeline decisions on numbers, not vibes.

## Two layers

### 1. CI-runnable regression test (`src/lib/rag/eval-harness.test.ts`)

A Vitest test that loads the labeled corpus below, runs each question through
the orchestrator with **mocked** embedding/keyword/reranker services, and
asserts:

- In-corpus questions: the expected doc appears in the final context (recall@k).
- Out-of-corpus questions: the pipeline abstains (or the expected doc is absent).

The mocks use deterministic per-(question, chunk) scores derived from token
overlap, so the test is stable across runs AND sensitive to real pipeline
changes (fusion order, floor thresholds, dedup). This runs in the normal
`npm test` CI step — no staged weights, no browser.

**Acceptance #15** (§3 do-not-break list) is asserted here: BGE query prefix
applied to the query only, RRF rank-only fusion k=60, zero-chunk abstain path
reachable.

### 2. Operator guidance script (`scripts/eval/run-eval.mjs`)

This script is **guidance-only**: it prints the prerequisites for a real-weight
eval run and verifies the corpus parses. It does NOT itself run the real
pipeline (that requires the jsdom + fake-indexeddb bootstrap the vitest suite
uses, plus a populated vector/keyword index from the running app). To produce
real recall@k / nDCG@10 numbers, run the app against staged weights and evaluate
the logged retrieval results against this corpus by hand, or extend this script
with the full browser-environment bootstrap.

The CI-runnable regression layer (option 1 above) is the authoritative
automated gate; this script exists to document the operator workflow and keep
the corpus file parseable.

## Corpus

`corpus/eval.jsonl` — one JSON object per line:

- `id` — stable identifier
- `question` — the natural-language question
- `docId` — expected source document id (in-corpus only)
- `expectedChunkSubstring` — a token expected to appear in the retrieved chunk
- `outOfCorpus` — `true` for abstention-correctness questions

To add questions, append lines to `eval.jsonl` and (for in-corpus questions)
add the matching document fixture to `fixtures/` and index it in the runner.
Keep the in/out ratio roughly 70/30 so abstention recall is exercised.

## Baseline (record after PR-2 merges)

Record the operator-run real-weight numbers here on a clean main build so
regressions are visible at PR review:

```
recall@5:   <fill in>
recall@10:  <fill in>
nDCG@10:    <fill in>
abstention: <fill in> correct / 3 out-of-corpus
```
