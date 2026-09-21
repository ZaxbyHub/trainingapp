# Licenses — bundled models and knowledge content

This document is the license review for everything TrainingApp distributes with model
weights or model-derived artifacts. It is consumed at runtime by the desktop first-run
wizard's licensing step (issue #85): `desktop/main/index.ts` `licensesPath()` reads this
file from the repository root in dev (`<repo>/docs/licenses.md`) and from
`<resourcesPath>/docs/licenses.md` in packaged installs — note that the packaged copy
is wired into the installer by #84 (packaging), so packaged builds before that change
show the wizard's "unavailable" fallback.

Model-selection decisions live in the ADRs: [ADR-0001](adr/0001-embedding-reranker.md)
(embedding + reranker) and [ADR-0002](adr/0002-llm-profiles.md) (LLM Quality/Fast
profiles). This file records license type, required notices, and restrictions per
bundled model family. **Maintenance rule:** a revision of any upstream license (Gemma
terms, LFM Open License, or a model repo's license tag) invalidates the affected
section — re-review is required and tracked as a new issue, never silently assumed.

The application code itself is MIT (see `LICENSE` at the repository root); this file
covers the models and bundled content only.

## LLM — Quality profile (per ADR-0002)

- **Model:** `gemma-4-e2b-it` (instruction-tuned; distributed as a GGUF quantization of
  `google/gemma-4-E2B-it`).
- **License type:** Apache License 2.0. The classic Gemma Terms of Use
  (https://ai.google.dev/gemma/terms) do NOT govern this generation — the terms page
  states: *"For Gemma 4 terms, see the [Gemma 4 license](https://ai.google.dev/gemma/apache_2)"*,
  and the Gemma 4 license page (https://ai.google.dev/gemma/apache_2) is the stock
  Apache License 2.0. The distribution source (`unsloth/gemma-4-E2B-it-GGUF`) carries
  the `apache-2.0` tag.
- **Required notices:** standard Apache-2.0 Section 4 obligations — include a copy of
  the Apache License 2.0, retain all copyright, patent, trademark, and attribution
  notices from the source, state significant changes made to the files, and include any
  NOTICE-file contents where one exists. Distributions bundle the license text alongside
  the weights (#84 packaging item).
- **Restrictions:** none beyond the standard Apache-2.0 grant (patent and trademark
  terms as written). Note for contrast: the *classic* Gemma Terms of Use — with their
  Prohibited-Use-Policy pass-through — DO still govern other Gemma-family models such
  as EmbeddingGemma and gemma-3-1b-it, which is part of why they were not selected
  (ADR-0001, ADR-0002).

## LLM — Fast profile (per ADR-0002)

- **Model:** `lfm2.5-vl-450m` (LiquidAI/LFM2.5-VL-450M, 0.4B parameters, used text-only).
- **License type:** LFM Open License v1.0 ("lfm1.0", `license: other` on Hugging Face) —
  a source-available, non-OSI license from Liquid AI, Inc. The same license family
  covers the unmeasured candidate LiquidAI/LFM2.5-1.2B-Instruct.
- **Required notices:** per Section 4 of the license — give recipients of the
  redistributed weights a copy of the LFM Open License v1.0; retain all copyright,
  patent, trademark, and attribution notices; if an upstream NOTICE file exists, its
  attribution notices must be included in a NOTICE text file distributed with the
  derivative work (or in documentation/third-party-notices displays). Distributions
  bundle the license text alongside the weights (#84 packaging item).
- **Restrictions:** Commercial Use by a Legal Entity whose annual revenue is 10 million
  United States dollars ($10,000,000) or more is NOT licensed (Section 5(b) and the
  "Threshold" definition) — an entity at or above that threshold must remove the LFM
  weights from its distributions and re-select the Fast profile per ADR-0002's
  method. Section 11 terminates the license automatically and immediately on breach,
  requiring cessation of use and deletion of copies. Trademark use is limited to
  describing the origin of the Work. This restriction is an obligation on the
  licensee's scale, not a prohibition on redistribution — redistribution itself is
  permitted with the notices above.

## Embedding (per ADR-0001 / issue #55)

- **Decision:** `Qwen/Qwen3-Embedding-0.6B` (1024-dim) for all surfaces.
- **License type:** Apache-2.0 (verified against the model repo, 2026-09-21).
- **Required notices:** standard Apache-2.0 Section 4 set — license copy, retention of
  attribution notices, change statements, NOTICE-file pass-through.
- **Restrictions:** none beyond the standard Apache-2.0 grant.
- **Transitional wired defaults (until the per-ADR-0001 re-pin issues land):** the code
  currently defaults to `BAAI/bge-small-en-v1.5` on the Python/Electron surfaces —
  **MIT** licensed — and `Snowflake/snowflake-arctic-embed-m-v1.5` in the browser model
  manifest — **Apache-2.0** licensed. Both remain distribution-clean; their notices ride
  the same Apache-2.0/MIT obligations as above. The rejected candidate
  `google/embeddinggemma-300m` ships under the classic Gemma Terms of Use (non-OSI) and
  must not be bundled without a fresh license review.

## Reranker (per ADR-0001 / issue #55)

- **Decision:** `cross-encoder/ettin-reranker-32m-v1` for all surfaces.
- **License type:** Apache-2.0 (verified against the model repo, 2026-09-21).
- **Required notices:** standard Apache-2.0 Section 4 set — license copy, retention of
  attribution notices, change statements, NOTICE-file pass-through.
- **Restrictions:** none beyond the standard Apache-2.0 grant. (Shipping-quality note,
  not a license matter: ADR-0001 Consequences 3-4 record that the currently staged ONNX
  exports lack the trained scoring head; the license review here is unaffected.)

## Knowledge packs and documents

Knowledge-pack content carries its own provenance: packs assert source documents and
redistribution posture at build time (`packtool/README.md`: no redistribution right is
asserted for embedded artifacts beyond what the pack's own metadata grants). Any pack
shipped with an installer must record its content licenses in the pack manifest before
#84 finalizes bundling.
