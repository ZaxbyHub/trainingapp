# ADR-0002: Distributable LLM profiles — Quality and Fast

- **Status:** Accepted (2026-09-21). Amended 2026-10-11 by #156 (LFM lineup).
- **Issue:** [#56 (A6, Workstream A, epic #50)](https://github.com/ZaxbyHub/trainingapp/issues/56)
  (original); amended by [#156](https://github.com/ZaxbyHub/trainingapp/issues/156).
- **Evidence:** recorded rows in `bench/RESULTS.md` (#52, cited inline per its provenance
  rules — machine-tagged, never hand-patched); license sources quoted verbatim inline;
  retrieval-model decisions cross-referenced from
  [ADR-0001](0001-embedding-reranker.md) (#55).

## Context

Three surfaces currently ship an LLM choice that no decision record backs (table
updated by the #156 amendment; each row's pre-amendment incumbent is kept inline as
history):

| Surface | Incumbent default | Where |
|---|---|---|
| Python desktop / API | `gemma-4-E2B-it-Q5_K_M.gguf` (~3.1 GB) | `app_paths.py:17` (`DEFAULT_BUNDLED_GGUF`) |
| Electron native inference | Quality `lfm2.5-2.6b/model.gguf`, Fast `lfm2-1.2b-rag/model.gguf`, 6 GiB free-RAM gate (at the original decision: Quality `gemma-4-e2b-it/model.gguf`, Fast `lfm2.5-vl-450m/model.gguf`) | `desktop/main/backend/inference/llama-engine.ts:53,55`, `profile-select.ts:14` |
| Browser web_ui | `lfm2-1.2b-rag` (single text-only LLM; at the original decision: `gemma-4-e2b-it`) | `web_ui/src/lib/models/model-manifest.ts:115` |

Python's fast-profile fallback (`config.py:123-126` `rag_fast_profile_path`) defaults to
`None` — the fallback mechanism (A3/#53) is generic and wired, but no Python-side model
was ever named. The first-run wizard (#85/PR #116) ships an unskippable license gate
that reads `docs/licenses.md` (`desktop/main/index.ts:314-318`), which did not exist
when this ADR was written.

Two premise corrections, verified against primary sources on 2026-09-21, shape this
decision:

1. **Gemma 4 is not governed by the classic Gemma Terms of Use.** The issue's RESEARCH
   note assumed "Gemma weights ship under the Gemma Terms of Use" (non-OSI). The live
   terms page says: *"The terms below apply to Gemma models listed in the Appendix at
   bottom of this page. For Gemma 4 terms, see the
   [Gemma 4 license](https://ai.google.dev/gemma/apache_2)"*
   (https://ai.google.dev/gemma/terms), and its appendix enumerates Gemma 1, 1.1, 2, 3,
   3n, PaliGemma, ShieldGemma, CodeGemma, RecurrentGemma, DataGemma, EmbeddingGemma,
   FunctionGemma, T5Gemma, VaultGemma, TranslateGemma and related models — **Gemma 4 is
   not in the appendix**. The Gemma 4 license page
   (https://ai.google.dev/gemma/apache_2) is the stock Apache License 2.0 (Version 2.0,
   January 2004), and the bundled GGUF's distribution source
   (`unsloth/gemma-4-E2B-it-GGUF`, quantizations of `google/gemma-4-E2B-it`) carries the
   `apache-2.0` license tag. EmbeddingGemma (rejected by ADR-0001) and `gemma-3-1b-it`
   (gated) DO remain under the classic terms — the distinction is per generation, not
   per family.
2. **The issue's named Fast-profile candidates have no recorded rows.**
   `bench/RESULTS.md` contains zero measurement rows for `LFM2.5-1.2B-Instruct` and
   `gemma-3-1b-it` — both appear only as runbook fetch commands (lines 148-151), and
   every reference-i5 cell is PENDING. The issue's own rule is "select from measured
   numbers, not assumption" and "this issue does not re-measure"; the only measured
   Fast-tier candidate is `lfm2.5-vl-450m` Q4_K_M.

Honesty note on "quality": this repo has no LLM answer-quality harness (the A5 bake-off
measured retrieval embedding/reranking, not generation). "Quality profile" here means
the larger instruction-tuned model reserved for machines with headroom, selected among
measured rows by latency/memory/license — answer-quality benchmarking remains a
follow-up, and no quality number below is invented.

## Options considered

Original 2026-09-21 record (kept verbatim as history; the #156 amendment below is
what changed the selection):

Quality profile — `gemma-4-e2b-it` Q4_K_M vs alternatives:

- **gemma-4-e2b-it Q4_K_M (selected):** the only measured quant of the only measured
  Quality-tier model (native CPU decode 3.65 tok/s @4 threads / 2.12 @8 on devstation;
  402.57 tok/s under Vulkan on a discrete Arc Pro B50; peak RSS 2761-2819 MB).
  Apache-2.0 (verified above). Weakness: CPU-only decode is single-digit tok/s on the
  best desktop CPU measured, so the Quality profile is only interactive with working
  Vulkan or for non-latency-critical use.
- **gemma-4-e2b-it Q5_K_M (incumbent artifact):** zero recorded rows anywhere in
  `bench/RESULTS.md`. Selecting it would violate the measured-numbers rule; the bundled
  artifact is superseded at packaging time by #84.
- **LFM2.5-1.2B-Instruct Q4_K_M / Q5_K_M:** no recorded rows (unmeasured), and LFM Open
  License v1.0 (non-OSI) — no measured basis to prefer over the measured Quality-tier
  candidate.
- **gemma-3-1b-it:** no recorded rows (unmeasured), classic Gemma Terms of Use, gated
  upstream repo — dominated on every axis the evidence can speak to.

Fast profile — `lfm2.5-vl-450m` Q4_K_M vs alternatives:

- **lfm2.5-vl-450m Q4_K_M (selected):** the only measured Fast-tier candidate (native
  CPU decode 95.97 tok/s @4 threads / 80.15 @8 on devstation at a 1024-token prompt;
  wllama browser WASM 51.83 tok/s threaded / 52.34 single-threaded; peak RSS
  497-619 MB). Already wired as the Electron `FAST_MODEL_SUBPATH` and soak-exercised by
  the B8 memory work. License: LFM Open License v1.0 (non-OSI) — obligations recorded
  below; see Consequences for the revenue-threshold contingency.
- **LFM2.5-1.2B-Instruct Q4_K_M (~0.8 GB) / gemma-3-1b-it:** no recorded rows
  (unmeasured) — the issue's named candidates cannot be selected "from measured
  numbers". LFM2.5-1.2B-Instruct carries the same LFM1.0 license family; gemma-3-1b-it
  is classic-ToU and gated. Re-evaluation after the reference-i5 run records rows is a
  named follow-up, not a silent dismissal.

### #156 amendment: the LFM family benchmark (2026-10-11)

Issue #156 re-opened the profile selection and swapped both tiers to the LFM family.
The benchmark summary below quotes the #156 issue comments (a 40-question grounded
question set run over the LFM family under every scorer variant); the post-swap bench
run recorded the machine-tagged `bench/RESULTS.md` rows for both new models, which
the Decision table cites:

- **Quality — LFM2.5-2.6B, Q4_K_M (1.67 GB GGUF; 1,674,455,040 bytes):** 95%
  grounded score with 0 fabrications at 5 context chunks under every scorer variant;
  GPU p50 first-answer 1.03 s at 5 chunks / 0.76 s at 3 chunks; CPU ~83.4 s at
  5 chunks / ~49.0 s at 3 chunks. Reasoning is suppressed at serving time
  (responsePrefix + zero thought budget — see Consequences).
- **Fast — LFM2-1.2B-RAG, Q4_K_M (0.73 GB GGUF; 730,894,048 bytes):** 92.5% at
  5 chunks / 95% at 3 chunks; GPU p50 0.51 s at 5 chunks / 0.36 s at 3 chunks;
  CPU 30.8 s at 5 chunks / 21.4 s at 3 chunks. Text-only: the multimodal projector
  (mmproj) artifact is retired from every shipped surface with the swap
  (node-llama-cpp has no image support; the browser LLM is text-only too).
- The retired incumbents (gemma-4-e2b-it quality, lfm2.5-vl-450m fast) and their
  measured rows remain in `bench/RESULTS.md` as history; gemma remains only in the
  legacy Python harness artifact, which #156 left out of scope.

## Decision table

Amended 2026-10-11 by #156; the machine-tagged rows for both new models were
recorded by the post-swap bench run into `bench/RESULTS.md` (native node-llama-cpp
table, 64-token prompt rows) and are cited below per the citation rules. The
answer-quality/first-answer latency evidence the amendment rests on is the #156
issue benchmark summarized in Options above, cited to the issue.

| profile | model | quant | tok/s | first-token | peak rss | license | risk |
|---|---|---|---|---|---|---|---|
| Quality | lfm2.5-2.6b | Q4_K_M | 3.87 tok/s @4 threads, 64-token prompt (machine devstation); 6.17 tok/s @8 | 9587.4 ms node-llama-cpp @4/64p; 6353.7 ms @8/64p | 3069-3070 MB | LFM Open License v1.0 (non-OSI) | CPU-only first answer ~83.4 s at 5 chunks / ~49.0 s at 3 chunks per the #156 issue benchmark (GPU p50 1.03 s / 0.76 s); reasoning suppressed via responsePrefix + zero thought budget; the $10M LFM revenue threshold binds this tier too since #156 (Consequences 3) |
| Fast | lfm2-1.2b-rag | Q4_K_M | 8.26 tok/s @4 threads, 64-token prompt (machine devstation); 14.16 tok/s @8 | 4044.7 ms node-llama-cpp @4/64p; 2630.5 ms @8/64p | 1412-1413 MB | LFM Open License v1.0 (non-OSI) | GPU p50 0.51 s at 5 chunks / 0.36 s at 3 chunks, CPU 30.8 s / 21.4 s per the #156 issue benchmark; text-only (mmproj retired with the swap); keeps 5 chunks under deviation D1 (Decision prose) |

Provenance: every "<n> tok/s" figure above equals the `decode_tok_s` column of a
matching machine-tagged `bench/RESULTS.md` row (machine devstation, quant Q4_K_M,
the post-swap bench run's node-llama-cpp 64-token rows); the first-token and
peak-RSS cells are narrative provenance from the same rows; the CPU/GPU first-answer
figures in the risk cells are the #156 issue's benchmark summary (Options), cited to
the issue, never presented as bench rows. The pre-amendment rows (2026-09-21)
selected gemma-4-e2b-it Q4_K_M (Apache-2.0) and lfm2.5-vl-450m Q4_K_M (LFM1.0) on the
then-recorded rows quoted verbatim in the Options section; they are superseded by
this amendment and retained there as history.

## Decision

**Quality profile (all surfaces): `lfm2.5-2.6b`, quant `Q4_K_M`** — the LFM2.5-2.6B
GGUF (1,674,455,040 bytes) selected by the #156 amendment, replacing the retired
`gemma-4-e2b-it` (benchmark summary in Options). Reasoning is suppressed at serving
time — responsePrefix `'\n</think>\n\n'` plus a zero thought budget — so answer
tokens are never spent on hidden thought segments.

**Fast profile (native/desktop surfaces): `lfm2-1.2b-rag`, quant `Q4_K_M`** — the
LFM2-1.2B-RAG text-only GGUF (730,894,048 bytes) selected by the #156 amendment,
replacing the retired `lfm2.5-vl-450m`; no mmproj artifact ships anywhere
(node-llama-cpp has no image support). The fast tier keeps 5 chunks (deviation D1:
the issue asked for 3 chunks but preconditioned that cut on measured recall@3 vs
recall@5 over the app's own packs, which could not be measured — the proxy evidence,
0.259@3 vs 0.574@5 plus rerank-off whole-pool truncation, favors 5; recorded as a
deviation, not a silent deferral).

**Browser surface (supersedes this ADR's original convention):** the original
decision said "The browser surface keeps a single LLM (the Quality model)"; #156
supersedes that convention — the browser (web_ui/wllama) now ships the text-only
Fast-tier model `lfm2-1.2b-rag`. This is deviation R1/fallback: the browser model
choice is user-pending (see Consequences), so a future user decision may revisit it.

**License-review outcome: bundling is not blocked.** Both tiers are LFM Open License
v1.0 (non-OSI) since #156 — an accepted, documented obligation, not a bundling
blocker: the license permits redistribution with conditions, and its restriction is
a revenue threshold on the licensee (which now binds the Quality tier too), not a
prohibition on distribution. The original decision's Apache-2.0 fallback clause is
moot for the shipped lineup; the full text ships at
`docs/licenses/LFM-OPEN-LICENSE-v1.0.txt`.

## License review outcome (per model)

Outcome: bundling is not blocked for either profile, and no fallback was needed —
both reviews verified the actual governing licenses rather than assuming terms apply.
Amended 2026-10-11 by #156: both tiers now ship under the LFM Open License v1.0.

- **Quality — LFM2.5-2.6B, `lfm2.5-2.6b` (LFM Open License v1.0, non-OSI).** Per the
  license text (Liquid AI, Inc.; full verbatim text at
  `docs/licenses/LFM-OPEN-LICENSE-v1.0.txt`, retrieved 2026-10-11 from the model
  repos' LICENSE files and verified against liquid.ai's published page): Section 5(b)
  *"Any Commercial Use of the Work or a Derivative Work by a Legal Entity that exceeds
  the Threshold is not licensed under this Agreement"* with Threshold = annual revenue
  of 10 million United States dollars ($10,000,000) or more — since #156 this
  threshold binds the QUALITY tier as well. Section 4 requires giving recipients a
  copy of the License, retaining attribution notices, and NOTICE-file pass-through;
  Section 11 terminates the license automatically and immediately on breach,
  requiring cessation of use and deletion of copies. Recorded in `docs/licenses.md`.
- **Fast — LFM2-1.2B-RAG, `lfm2-1.2b-rag` (LFM Open License v1.0, non-OSI).** The same
  license text governs (same sections, same threshold, same termination); the browser
  copy of this model ships under the identical terms. Full notices/restrictions
  recorded in `docs/licenses.md`.
- **Historical (pre-#156 Quality tier) — Gemma 4 E2B-it (Apache-2.0).** Kept as the
  record behind this section's original citations: the classic Gemma Terms of Use
  (https://ai.google.dev/gemma/terms) exclude this generation — *"For Gemma 4 terms,
  see the Gemma 4 license"* — and the Gemma 4 license
  (https://ai.google.dev/gemma/apache_2) is the stock Apache License 2.0. Gemma is
  retired from every shipped surface by #156; only the legacy Python harness keeps
  its own Gemma 4 E2B artifact, which #156 left out of scope.
- **Embedding + reranker (per ADR-0001/#55):** `Qwen/Qwen3-Embedding-0.6B` and
  `cross-encoder/ettin-reranker-32m-v1`, both Apache-2.0 (verified against their HF
  repos 2026-09-21). Recorded in `docs/licenses.md`, including the transitional
  wired-default models still in the code until the per-ADR-0001 re-pin lands.

## Downstream gate

Per the issue's required scope: **#62 (native LLM inference), #84 (installer packaging),
and #85 (first-run validation wizard) are blocked until this ADR merges** — no
downstream packaging, model-manifest, or first-run licensing work may finalize model
choices or license notices that contradict this record. Reconciliation with what already
shipped: #62 (PR #98) and #85 (PR #116) landed with provisional subpaths that this
decision confirms (the gemma-4-e2b-it quality subpath and the lfm2.5-vl-450m fast
subpath are exactly the selected models); what changes for them is the Quality quant —
Q4_K_M per the measured rows, superseding the unmeasured Q5_K_M incumbent at packaging
time.

(Historical, 2026-09-21: that gate closed when this ADR merged. The #156 amendment
later replaced the lineup the gate had confirmed — the reconciliation sentence above
names the pre-amendment subpaths.)

## Consequences

Items 1-6 are the original 2026-09-21 consequences, kept as the recorded history
(items 1, 2 and 5 were resolved when #84 landed); item 3 is amended and item 7 is
added by #156.
1. **Quant re-pin pull-through is #84's bundling work.** Until it lands,
   `app_paths.py:17` `DEFAULT_BUNDLED_GGUF`, `app_gui.py:828-835`, `INSTALL.md`
   (lines 208/213/306), `ARCHITECTURE.md:98`, `CONFIGURATION.md:138` and `:561`,
   `README.md:54` and `:266`, and several test pins still say `Q5_K_M`; the drift is
   made observable by an xfail-marked conformance test rather than left silent. Separately verified:
   `desktop/electron-builder.yml` today copies no `docs/` into packaged resources, so
   the #85 gate's packaged path (`process.resourcesPath/docs/licenses.md`) stays empty
   until #84 wires packaging — both packaging-side gaps are #84 acceptance items.
2. **Python Fast-profile asymmetry, stated explicitly:** the ADR's Fast model routes
   natively only through the Electron `FAST_MODEL_SUBPATH`; the Python surface's
   `rag_fast_profile_path` defaults to `None`, so Python keeps resolving whatever
   `app_paths.py` finds until a staging/wiring change names the fast artifact there.
   This ADR supplies the model name; wiring it into the Python default is deliberately
   not done here (no artifact is staged to point at).
3. **LFM1.0 revenue-threshold contingency (operator action; amended by #156 to cover
   BOTH tiers):** with both profiles LFM-licensed since #156, the threshold binds the
   Quality tier as well as the Fast tier. If the distributing entity's annual revenue
   is or becomes >= $10,000,000, Commercial Use of the bundled LFM weights is
   unlicensed — the weights must be removed from distributions and the profile
   selections re-decided by this ADR's method (from recorded rows, with Apache-2.0
   candidates the natural pool). No replacement model is pre-selected without
   measurement.
4. **Terms-revision re-review rule (both sides):** evidence in this ADR is invalidated
   if Google revises the Gemma terms or Liquid AI revises the LFM Open License — a
   revision requires re-review tracked as a new issue, never a silent assumption of
   continued validity. `docs/licenses.md` carries the same maintenance rule.
5. **Docs pull-through:** `INSTALL.md` model/license strings and `PACKAGING.md` gain
   pointers to `docs/licenses.md` now (the license facts this decision verified),
   while the model-name/quant strings update with the #84 bundling change.
6. **Follow-ups:** run the reference-i5 matrix (all its rows are PENDING) — a
   materially different laptop result reopens this decision; record rows for the
   unmeasured candidates (the runbook commands already exist) before any future
   re-decision; add an LLM answer-quality harness so a future revision of this ADR can
   weigh quality, not only latency/memory/license.
7. **#156 integration notes (2026-10-11 amendment):**
   - **Serving recipe + echo-strip:** the Quality model's reasoning is suppressed by
     serving with responsePrefix `'\n</think>\n\n'` and a zero thought budget, and any
     echoed think-tag remnants are stripped from the streamed answer.
   - **Decline filter:** a decline filter
     (`desktop/main/backend/inference/decline-filter.ts`, with a browser twin in
     `web_ui/src/lib/llm/decline-filter.ts`) strips the trained-in "did you forget
     to include/attach the document?" sentences the LFM 1.2B models append when
     declining, from decline-shaped answers only — answerable answers pass through
     byte-identical. (Prompt refusal on absent evidence remains the pre-existing
     retrieval abstention gate's job, not this filter's.)
   - **Penalty retirement:** the repeat penalty (and its window bookkeeping,
     `penalties.ts`) is retired with the LFM lineup; sampling no longer applies it.
   - **CPU-only auto gate:** on machines where the GPU probe finds no working device,
     the `auto` profile now selects the Fast tier instead of Quality (CPU-only Quality
     first answers are ~83.4 s at 5 chunks per the #156 issue benchmark).
   - **Fast-tier chunk count:** 5 chunks retained under deviation D1 (Decision prose
     records the unmeasurable recall precondition and the proxy evidence).
   - **Browser model choice:** the browser ships `lfm2-1.2b-rag` (deviation R1
     fallback, superseding this ADR's original single-Quality-model browser
     convention); the choice is user-pending — a future user decision may revisit it.

## Waivers (or none)

None. No Full-Resolution Contract clause was waived.
