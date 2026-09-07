# Tier-0 Eval Set and Backend-Agnostic Harness (Issue #54, WS-A PR 4/8)

One curated question set plus one runner that scores **recall@k, MRR, abstain
accuracy, and latency** against ANY backend implementing the frozen API
contract (`contracts/api.openapi.yaml`, `/ask`). Every later quality decision
— the embedding/reranker bake-off (A5/#55), hybrid retrieval parity in
Electron (WS-B #65), Learn-panel hit-rate (WS-D #82) — is measured against
this same set, so numbers are comparable across surfaces and time.

This harness does NOT pick a winning model and does NOT certify answer
quality; it is the measuring instrument.

## Layout

| path | purpose |
|---|---|
| `questions.jsonl` | 56 tier-0 questions (50 in-corpus + 6 out-of-corpus) |
| `corpus/*.md` | the 8 checked-in synthetic documents the questions target |
| `runner.py` | scores a `--base-url` backend, writes `REPORT.md` + `report.json` |
| `ci_serve.py` | deterministic no-weights backend for CI / smoke runs |
| `samples/` | committed sample reports, one per provenance label |
| `REPORT.md` / `report.json` | default output paths of a local run (not committed) |

## Provenance rules (mirrors bench/RESULTS.md)

1. Every run record carries a **label** (`--label`) plus the backend identity
   (from `/stats`) and a UTC timestamp in the report header.
2. `deterministic-stub` runs (via `ci_serve.py`, the label CI uses) exercise
   the pipeline end to end with a feature-hashing embedder and a scripted LLM.
   Their numbers are **smoke signals**: they prove the pipeline runs and the
   metrics are populated — they are NOT retrieval-quality measurements and are
   never comparable with weighted runs.
3. Weighted runs (real bge-small embeddings, real reranker, real GGUF LLM)
   are the quality signal. Never mix rows across labels.

## Question schema (`questions.jsonl`)

One JSON object per line; the file starts with `#` comment lines documenting
the schema (a validator enforces this header).

| field | type | notes |
|---|---|---|
| `id` | string, unique | stable identifier (`q01`...) |
| `question` | non-empty string | must NOT begin with a greeting keyword — the engine's greeting bypass (`rag_engine.py` "hello/hi" short-circuit) skips retrieval entirely |
| `expected_doc_id` | string or null | filename under `eval/corpus/`; null ONLY for out-of-corpus rows |
| `expected_page` | int or null | null for `.md`-sourced corpora (no page concept); populate once pdf/pptx fixtures land |
| `expected_training_slide_id` | int or null | STAYS null until the Storyline extractor (D1, issue #77) ships doc-to-slide links — follow-up per issue #54 |
| `category` | string | one of the taxonomy values below |

Contract: 50-80 rows total; at least 5 out-of-corpus rows
(`expected_doc_id` null, `category` `"out-of-corpus"`); every category value
must appear in this README; ids unique.

## Category taxonomy

| category | meaning | corpus docs |
|---|---|---|
| `policy` | company policy questions (travel, booking rules) | travel-policy.md |
| `benefits` | leave, vacation, working arrangements | employee-handbook.md |
| `it-support` | accounts, hardware, network help | it-helpdesk.md |
| `security` | security practices and data handling | security-basics.md |
| `safety` | workplace safety program | workplace-safety.md |
| `training-content` | product/course training material | product-training.md |
| `compliance` | compliance obligations, gifts, records | compliance-basics.md |
| `expenses` | expense reimbursement rules | expenses-guide.md |
| `out-of-corpus` | deliberately unanswerable from the corpus (abstain rows) | — |

## Authoring process

1. Append one JSON line per question to `questions.jsonl` (keep ids stable
   and sequential; never rewrite existing ids — later bake-offs diff against
   recorded runs).
2. Keep the in-corpus / out-of-corpus ratio roughly 90/10 for the tier-0 set;
   every new topic needs a checked-in `corpus/*.md` doc first, and the
   `expected_doc_id` is exactly that filename.
3. Do not start a question with a greeting keyword. Paraphrase where
   practical — verbatim doc phrasing inflates lexical-overlap metrics.
4. Validate: `python -m pytest tests/test_eval_harness.py -q` (schema test)
   and `python eval/runner.py --help` still loads the file.
5. Record any question-set change in the CHANGELOG so recorded runs can be
   attributed to a question-set revision.

## Metric definitions

One `POST /ask` per question with `n_results=10` (contract maximum).

- **recall@k** (k in 1, 3, 5): fraction of in-corpus questions whose
  `expected_doc_id` appears in the first k entries of the response's ranked
  `sources`. A source matches when it equals `expected_doc_id` OR its final
  path component does (the Python backend ingests files by display filename,
  so sources are basenames; the fallback keeps the rule portable).
- **MRR**: mean of 1/rank of the first matching source over in-corpus
  questions (0.0 when absent).
- **abstain accuracy**: fraction of successful out-of-corpus questions where
  the response abstained. **Abstain is defined strictly as `sources == []`**
  (the engine's empty-retrieval path). A non-empty-sources answer that
  contains the rag_engine fallback phrases is NOT an abstain — that is
  "retrieval succeeded, LLM could not use it" and is counted separately as
  `fallback_count`. A `[Cancelled]` answer is an error row.
- **latency p50/p95**: milliseconds over SUCCESSFUL requests only; error rows
  are excluded from every metric denominator and reported via `error_count`.

Exit codes: 0 = run completed (scores are informational — a low score is a
measurement, not a failure); 1 = structural failure (backend unreachable,
every question errored); 2 = question-file validation failure.

## Running

### a) Deterministic stub backend (CI / smoke)

```bash
python eval/ci_serve.py --port 8091 --eval-report eval-report/REPORT.md \
    --eval-json eval-report/report.json
```

Boots the REAL `api_server.app` with the encoder replaced by a deterministic
feature-hashing embedder and `engine.llm` replaced by a scripted extractive
LLM. Hybrid search and reranking are disabled and the vector store is a fresh
temp dir per boot, so runs are identical on any machine. The report is
labeled `deterministic-stub`.

Mode A (used by the acceptance checks): drop `--eval-report/--eval-json` and
the server serves until killed.

### b) Real weighted backend (quality signal)

From a normal shell (env vars must reach the process — avoid wrappers that
strip environment from background jobs):

```bash
# 1. start a real backend with staged weights (Windows paths, repo cwd):
RAG_DB_PATH=.agents/tmp/eval-weighted-db RAG_GGUF_PATH=models/lfm2.5-vl-450m/model.gguf API_PORT=8123 python api_server.py

# 2. ingest the tier-0 corpus (multipart upload of every corpus doc; os.path.basename
#    keeps the upload filename = the doc id on every OS):
python -c "import httpx,glob,os; c=httpx.Client(timeout=120); [c.post('http://127.0.0.1:8123/ingest/file', files={'file':(os.path.basename(p), open(p,'rb').read(),'text/markdown')}) for p in glob.glob('eval/corpus/*.md')]"
# 3. run the harness with a provenance label:
python eval/runner.py --base-url http://127.0.0.1:8123 \
    --report eval/samples/REPORT-<machine>-weighted.md \
    --json-out eval/samples/report-<machine>-weighted.json \
    --label <machine>-weighted-<embedder>-<reranker>-<llm>
```

Since this harness landed, `/ask` and `/ask/stream` lazily load the
configured GGUF model on the first question (the RAM gate runs there); a
failed load surfaces its real diagnostic in the 503 detail. Expect a slow
first request on a cold engine (the model load happens inside the first
question, and concurrent cold-start requests serialize on the init lock) —
raise `--timeout` for larger models.

Commit the resulting sample under `eval/samples/` — one pair per label.

### c) CI

`.github/workflows/test.yml` gains an `eval-report` job: it runs mode (a) and
uploads the report as an artifact with `continue-on-error: true`. It is
INFORMATIONAL ONLY — it never gates merge (until WS-B lands and there is a
second backend to compare against).

## Deterministic backend calibration

`ci_serve.py` sets `RAG_MIN_SIMILARITY=0.12` — NOT the 0.3 default, which is
calibrated for bge-small. Derivation (feature-hashing embedder, 256-dim
signed hashing, stopword-filtered + plural-folded tokens; measured over the
tier-0 set with the floor at 0):

- out-of-corpus questions: best similarity to anything = median 0.117,
  max 0.162 — residual token overlap ("membership"/"gym" etc.), not meaning.
- in-corpus questions: best similarity to their target doc = median 0.198
  (p25 0.139), with 6 paraphrase-heavy questions below 0.07.

0.12 sits just above the out-of-corpus median and below the in-corpus
median, so typical noise abstains and typical targets retrieve. The
consequence is honest and expected: the stub cannot retrieve for
lexically-distant paraphrases (a handful of in-corpus rows abstain), which
is exactly why stub numbers are smoke signals only.

## Relation to the browser-side harness

`web_ui/scripts/eval/` measures the BROWSER pipeline (vitest, mocked
services, its own corpus schema). This directory measures any backend that
implements the frozen HTTP contract. The two corpora are intentionally
independent; do not merge their schemas.
