# Licenses — bundled models and knowledge content

This document is the license review for everything TrainingApp distributes with model
weights or model-derived artifacts. It is consumed at runtime by the desktop first-run
wizard's licensing step (issue #85): `desktop/main/index.ts` `licensesPath()` reads this
file from the repository root in dev (`<repo>/docs/licenses.md`) and from
`<resourcesPath>/docs/licenses.md` in packaged installs — note that the packaged copy
is wired into the installer by #84 (packaging), so packaged builds before that change
show the wizard's "unavailable" fallback.

Model-selection decisions live in the ADRs: ADR-0001
(embedding + reranker) and ADR-0002 (LLM Quality/Fast
profiles, amended 2026-10-11 by #156 to the LFM lineup). This file records license
type, required notices, and restrictions per bundled model family. **Maintenance
rule:** a revision of any upstream license (the LFM Open License, or — historically,
for the retired Gemma quality tier — the Gemma terms) or of a model repo's license
tag invalidates the affected section — re-review is required and tracked as a new
issue, never silently assumed.

The application code itself is MIT (see `LICENSE` at the repository root); this file
covers the models, bundled content, and vendored third-party code (see the final
section) only.

## LLM — Quality profile (per ADR-0002, amended by #156)

- **Model:** `lfm2.5-2.6b` (LiquidAI/LFM2.5-2.6B, distributed as the Q4_K_M GGUF
  quantization of `LiquidAI/LFM2.5-2.6B-GGUF`; 1,674,455,040 bytes). Selected by the
  #156 amendment of ADR-0002 (issue benchmark summary in that ADR's Options), replacing
  the retired `gemma-4-e2b-it`.
- **License type:** LFM Open License v1.0 ("lfm1.0", `license: other` on Hugging Face) —
  a source-available, non-OSI license from Liquid AI, Inc. The full verbatim text ships
  at [licenses/LFM-OPEN-LICENSE-v1.0.txt](licenses/LFM-OPEN-LICENSE-v1.0.txt)
  (retrieved from the `LICENSE` file of `LiquidAI/LFM2.5-2.6B-GGUF` and
  `LiquidAI/LFM2-1.2B-RAG`, which carry identical text; verified against
  liquid.ai's published license page 2026-10-11).
- **Required notices:** per Section 4 of the license — give recipients of the
  redistributed weights a copy of the LFM Open License v1.0; state prominent notices
  on modified files (4(b)); retain all copyright, patent, trademark, and attribution
  notices (4(c)); and pass through any upstream NOTICE file's attribution notices
  (4(d)). Distributions bundle the license text alongside the weights (#84 packaging
  item; the stager also ships the full-text file).
- **Restrictions:** Commercial Use by a Legal Entity whose annual revenue is 10 million
  United States dollars ($10,000,000) or more is NOT licensed (Section 5(b) and the
  "Threshold" definition) — an entity at or above that threshold must remove the LFM
  weights from its distributions and re-select the Quality profile per ADR-0002's
  method. Section 11 terminates the license automatically and immediately on breach,
  requiring cessation of use and deletion of copies. Trademark use is limited to
  describing the origin of the Work (Section 7). With both tiers LFM-licensed since
  #156, this restriction binds the QUALITY tier too — it is stated here explicitly
  for that reason.
- **Historical note (pre-#156 quality model):** the retired `gemma-4-e2b-it` shipped
  under the stock Apache License 2.0 (the classic Gemma Terms of Use did not govern
  Gemma 4 — see ADR-0002's License review outcome for the terms-page routing). That
  review is retained as history in ADR-0002; the legacy Python harness's separate
  Gemma 4 E2B artifact (INSTALL.md, `api_server.py`, `config.py`) remains out of #156's
  scope and keeps its own Apache-2.0 posture.

## LLM — Fast profile (per ADR-0002, amended by #156)

- **Model:** `lfm2-1.2b-rag` (LiquidAI/LFM2-1.2B-RAG, distributed as the Q4_K_M GGUF
  quantization of `LiquidAI/LFM2-1.2B-RAG-GGUF`; 730,894,048 bytes; used text-only —
  the multimodal projector artifact is gone from every shipped surface with the #156
  swap). This is also the browser (web_ui/wllama) LLM. Selected by the #156 amendment
  of ADR-0002, replacing the retired `lfm2.5-vl-450m`.
- **License type:** LFM Open License v1.0 ("lfm1.0", `license: other` on Hugging Face) —
  the same license family as the Quality tier. Full verbatim text:
  [licenses/LFM-OPEN-LICENSE-v1.0.txt](licenses/LFM-OPEN-LICENSE-v1.0.txt).
- **Required notices:** per Section 4 of the license — give recipients of the
  redistributed weights a copy of the LFM Open License v1.0; retain all copyright,
  patent, trademark, and attribution notices; if an upstream NOTICE file exists, its
  attribution notices must be included in a NOTICE text file distributed with the
  derivative work (or in documentation/third-party-notices displays). Distributions
  bundle the license text alongside the weights (#84 packaging item; the stager also
  ships the full-text file).
- **Restrictions:** identical to the Quality tier above — the same LFM Open License
  v1.0 governs, so the $10,000,000 revenue threshold (Section 5(b)) and Section 11's
  automatic termination on breach apply to this tier as well. Redistribution itself is
  permitted with the notices above; the restriction is an obligation on the licensee's
  scale, not a prohibition on redistribution. (Pre-#156 this section also noted the
  same license family covered the then-unmeasured candidate LFM2.5-1.2B-Instruct; that
  model was never selected and #156 chose the measured LFM2/LFM2.5 family instead.)

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
redistribution posture at build time (the packtool README: no redistribution right is
asserted for embedded artifacts beyond what the pack's own metadata grants). Any pack
shipped with an installer must record its content licenses in the pack manifest before
#84 finalizes bundling.

The initial `opmed-initial` knowledge pack (#133) is built from the operator-supplied
`knowledgepack/` corpus — operator-local and git-excluded, like the model weights. The
repository asserts no redistribution right over it; distributing an installer that
carries it is the operator's responsibility under the source documents' own terms.

<!-- fixture-licensing:v1 -->
Fixture licensing (issue #282). The e2e fixture `desktop/e2e/fixtures/storyline-nav/` is
classified per file in its `LICENSE-MANIFEST.json`. Rights holder of the course content
(slide payloads, narration MP3s, mobile imagery): zaxbysauce (maintainer; recorded
2026-11-03 on issue #282). The course content is NOT covered by this repository's MIT
license. The Articulate Storyline 360 player runtime (`html5/lib/**`) is third-party
published output carrying "Copyright (c) 2026 ; Not Licensed" headers (`html5/lib/scripts/*.min.js:1-2`),
not repository MIT; its redistribution basis is a pending maintainer statement
(issue #282 AC1, statement 6). Embedded components, named individually with tree-verified
banners: GreenSock CSSRulePlugin 3.11.3 (standard license, all rights reserved,
`bootstrapper.min.js:7-8`), Underscore.js 1.8.3 (MIT, `bootstrapper.min.js:30-37`), lodash
(MIT, `bootstrapper.min.js:30-37`), regenerator-runtime (MIT, `slides.min.js`), Open Sans
1.10 (Apache-2.0, font nameID-14 license URL, `html5/lib/stylesheets/mobile-fonts/*.woff`).
Narration voice provenance (statement 4), rights or permission for the clinical-application
screenshots and video (statement 3), any DoD/DHA public-release clearance (statement 5),
the Storyline license tier used to publish (statement 2), and the GreenSock component
license basis (statement 7) are pending maintainer statements (issue #282 AC1); this
paragraph states verified facts only and makes no assertion about any pending basis.
<!-- /fixture-licensing -->

## Vendored third-party code

### SheetJS `xlsx` 0.20.3 (issue #276)

- **Artifact:** `vendor/sheetjs/xlsx-0.20.3.tgz` (2,409,319 bytes), consumed by
  `web_ui`, `desktop` and `packtool` through `"xlsx": "file:../vendor/sheetjs/xlsx-0.20.3.tgz"`;
  the desktop installer ships it inside the packaged app.
- **Provenance:** the official SheetJS CDN tarball
  <https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz> (SheetJS publishes 0.19 and later
  only there; the npm registry stops at the advisory-affected 0.18.5). SHA-512 hex
  `a0b0eade3c3b01c2ea2961f60210a9553665f267fa5f661178ff8d7a1d12254cd5fc1759623b61f78b46e6da22301d4f3eb62dc4e09f6a850292fb6e1fedc024`;
  fetch and verify commands live in `vendor/README.md`.
- **License type:** Apache-2.0 (SheetJS Community Edition; `package/LICENSE` in the
  tarball).
- **Required notices:** standard Apache-2.0 Section 4 set — license copy (shipped inside
  the package), retention of attribution notices, change statements (none: the tarball
  is committed unmodified).
- **Restrictions:** none beyond the standard Apache-2.0 grant.
