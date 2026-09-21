# ADR-0002: Distributable LLM profiles — Quality and Fast

- **Status:** Accepted (2026-09-21)
- **Issue:** [#56 (A6, Workstream A, epic #50)](https://github.com/ZaxbyHub/trainingapp/issues/56)
- **Evidence:** recorded rows in `bench/RESULTS.md` (#52, cited inline per its provenance
  rules — machine-tagged, never hand-patched); license sources quoted verbatim inline;
  retrieval-model decisions cross-referenced from
  [ADR-0001](0001-embedding-reranker.md) (#55).

## Context

Three surfaces currently ship an LLM choice that no decision record backs:

| Surface | Incumbent default | Where |
|---|---|---|
| Python desktop / API | `gemma-4-E2B-it-Q5_K_M.gguf` (~3.1 GB) | `app_paths.py:17` (`DEFAULT_BUNDLED_GGUF`) |
| Electron native inference | Quality `gemma-4-e2b-it/model.gguf`, Fast `lfm2.5-vl-450m/model.gguf`, 6 GiB free-RAM gate | `desktop/main/backend/inference/llama-engine.ts:53,55`, `profile-select.ts:14` |
| Browser web_ui | `gemma-4-e2b-it` (single LLM; no fast profile) | `web_ui/src/lib/models/model-manifest.ts:115` |

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

## Decision table

| profile | model | quant | tok/s | first-token | peak rss | license | risk |
|---|---|---|---|---|---|---|---|
| Quality | gemma-4-e2b-it | Q4_K_M | 3.65 tok/s @4 threads, 1024-token prompt (machine devstation); 2.12 tok/s @8; 402.57 tok/s Vulkan (discrete Arc Pro B50) | 36813 ms llama-cpp-python @4/1024p; 6558.9 ms node-llama-cpp @8/64p | 2761-2819 MB | Apache-2.0 (Gemma 4 license) | CPU-only decode single-digit tok/s (worse on the slower reference i5, rows PENDING); reference-i5 Vulkan PENDING with gemma-3n-family integrated-GPU crash history (llama.cpp #17389); incumbent Q5_K_M artifact unmeasured — packaging re-pin is #84 |
| Fast | lfm2.5-vl-450m | Q4_K_M | 95.97 tok/s @4 threads, 1024-token prompt (machine devstation); 80.15 tok/s @8; 51.83 tok/s wllama threaded | 1200.1 ms llama-cpp-python @4/1024p; 969.2 ms node-llama-cpp @8/64p | 497-619 MB | LFM Open License v1.0 (non-OSI) | Commercial Use unlicensed above the $10M-revenue threshold (operator contingency in Consequences); license/NOTICE pass-through required; reference-i5 rows PENDING; issue's named Fast candidates unmeasured |

All numbers above quote recorded `bench/RESULTS.md` rows (native llama.cpp table lines
72-79, Vulkan table line 90, wllama table lines 102-103); no number is derived or
hand-patched, per the A2 provenance rules. The issue's named-but-unmeasured candidates —
LFM2.5-1.2B-Instruct and gemma-3-1b-it — have no recorded rows, and the A5 quality
comparison covers only embedding/reranking candidates, not LLM generation.

## Decision

**Quality profile (all surfaces): `gemma-4-e2b-it`, quant `Q4_K_M`** — the measured
quant of the measured Quality-tier model, Apache-2.0 licensed. The incumbent Q5_K_M
bundled artifact is superseded by this decision at packaging time (#84 stages the
Q4_K_M GGUF); no code, installer, or artifact changes land in this ADR itself.

**Fast profile (native/desktop surfaces): `lfm2.5-vl-450m`, quant `Q4_K_M`** — the only
measured Fast-tier candidate, confirming the already-wired Electron
`FAST_MODEL_SUBPATH`. The browser surface keeps a single LLM (the Quality model); it
has no fast-profile mechanism to name.

**License-review outcome: bundling is not blocked, and the issue's Apache-2.0 fallback
clause is NOT triggered.** The classic Gemma Terms of Use (which contain the
redistribution conditions and the Prohibited-Use-Policy pass-through) do not govern the
selected Quality model — the terms page itself routes Gemma 4 to the stock Apache
License 2.0. Outcome recorded with basis: the selected Fast model is LFM1.0-licensed
(non-OSI) rather than Apache-2.0, which is an accepted, documented obligation (below),
not a bundling blocker: the license permits redistribution with conditions, and its
restriction is a revenue threshold on the licensee, not a prohibition on distribution.

## License review outcome (per model)

Outcome: bundling is not blocked for either profile, and the issue's Apache-2.0
fallback was not needed — the review verified the actual governing licenses rather
than assuming the classic Gemma terms apply.

- **Quality — Gemma 4 E2B-it (Apache-2.0).** The classic Gemma Terms of Use
  (https://ai.google.dev/gemma/terms) exclude this generation: *"For Gemma 4 terms, see
  the Gemma 4 license"*; the Gemma 4 license (https://ai.google.dev/gemma/apache_2,
  labeled "Gemma 4 license" in Google's legal nav) is the stock Apache License 2.0.
  Obligations are the standard Apache-2.0 Section 4 set: pass along the license, retain
  copyright/patent/trademark/attribution notices, state changes, include NOTICE file
  contents where they exist. Recorded in `docs/licenses.md`.
- **Fast — LFM2.5-VL-450M (LFM Open License v1.0, non-OSI).** Per the license text
  (Liquid AI, Inc., fetched from the model's LICENSE file 2026-09-21): Section 5(b)
  *"Any Commercial Use of the Work or a Derivative Work by a Legal Entity that exceeds
  the Threshold is not licensed under this Agreement"* with Threshold = annual revenue
  of 10 million United States dollars ($10,000,000) or more; Section 4 requires giving
  recipients a copy of the License, retaining attribution notices, and NOTICE-file
  pass-through; Section 11 terminates the license automatically and immediately on
  breach, requiring cessation of use and deletion of copies. Full notices/restrictions
  recorded in `docs/licenses.md`.
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

## Consequences

1. **Quant re-pin pull-through is #84's bundling work.** Until it lands,
   `app_paths.py:17` `DEFAULT_BUNDLED_GGUF`, `app_gui.py:828-835`, `INSTALL.md`, and
   several test pins still say `Q5_K_M`; the drift is made observable by an
   xfail-marked conformance test rather than left silent. Separately verified:
   `desktop/electron-builder.yml` today copies no `docs/` into packaged resources, so
   the #85 gate's packaged path (`process.resourcesPath/docs/licenses.md`) stays empty
   until #84 wires packaging — both packaging-side gaps are #84 acceptance items.
2. **Python Fast-profile asymmetry, stated explicitly:** the ADR's Fast model routes
   natively only through the Electron `FAST_MODEL_SUBPATH`; the Python surface's
   `rag_fast_profile_path` defaults to `None`, so Python keeps resolving whatever
   `app_paths.py` finds until a staging/wiring change names the fast artifact there.
   This ADR supplies the model name; wiring it into the Python default is deliberately
   not done here (no artifact is staged to point at).
3. **LFM1.0 revenue-threshold contingency (operator action):** if the distributing
   entity's annual revenue is or becomes >= $10,000,000, Commercial Use of the bundled
   LFM weights is unlicensed — the weights must be removed from distributions and the
   Fast-profile selection re-decided by this ADR's method (from recorded rows, with
   Apache-2.0 candidates the natural pool). No replacement model is pre-selected
   without measurement.
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

## Waivers (or none)

None. No Full-Resolution Contract clause was waived.
