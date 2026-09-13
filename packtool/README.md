# packtool

Offline build tooling for the trainingapp knowledge and training packs
(Node-based per the v3 roadmap plan; issue #77 ships the first subcommand).

## `packtool storyline extract`

```bash
node packtool/dist/cli.js storyline extract <publishDir> --out <outDir>
# build first: npm --prefix packtool run build
```

Turns an unmodified Articulate Storyline 360 HTML5 publish folder into:

- `<outDir>/slides/slide-<NNN>-<slideId>.json` — one RAG-ready document per
  **content slide** (scenes ≥ 1, non-message; the walked count, never
  `data.js`'s `slideCount` field), in spine order.
- `<outDir>/outline.json` — `{course, duration, scene_count,
  sections: [{title, slide_count}]}`.

### Per-slide document schema (`storyline/types.ts`)

```jsonc
{
  "course": "OpMed CDP MicroLearning Companion (MLC)",
  "scene_number": 5,
  "section_title": "Pharmacy Task List: Process Overview",   // from frame.js outline
  "slide_number_in_scene": 5,
  "slide_id": "5b8obQzpBWu",                                 // stable doc id (#78/#80/#82)
  "slide_title": "Note 10.2",                                // from data.js slide.title
  "on_screen_text": "…",                                     // altText + vartext, %player.*%-stripped
  "text_chars": 690,                                         // 0 is legal — slide still emitted
  "transcript_source": "sidecar" | "asr" | "missing" | "none",
  "transcript_text": "…",                                    // sidecar or ASR cue texts, concatenated
  "narration_ref": "story_content/<mediaId>_transcripts.js", // 'sidecar': publish-relative.
                                                             // 'asr': '<id>_transcripts.js'
                                                             //   (ASR-store-relative, see D2).
  "provenance": "<section_title> > Slide <n>",
  "source_files": ["meta.xml", "…"],                          // publish-relative inputs for this doc
  "html5url": "html5/data/js/<slideId>.js"                    // deep-link target (#58/#81/#82)
}
```

### Contracts and pinned assumptions

- **Decode** (`storyline/decode.ts`): files are read utf-8-sig; slide/data/frame
  payloads are single-quoted `window.globalProvideData('<name>', '…')` literals
  whose only JS escapes are `\` and `\'` (unescaped in one pass, then
  `JSON.parse` — never a `unicode_escape`-style codec, which mojibakes
  non-ASCII); transcript sidecars are `const data = {…}` +
  `window.globalLoadJsAsset` literals. Payload wrappers are dispatched by name
  (`paths.js` is a different payload and is ignored).
- **Section titles** come only from `frame.js` `navData.outline.links[]`
  (HTML-entity-decoded); slide-to-section linkage is the outline sub-link
  `slideid`'s LAST `_player.<sectionId>.<slideId>` component. `slide_title`
  comes from `data.js` (`scene` objects carry no titles).
- **Video transcripts** (`storyline/video-refs.ts`): sidecar lookup key is the
  video OBJECT's `id` (a media-id space, not slide ids) at
  `story_content/<id>_transcripts.js`. Slides with several video objects take
  the first object that has a sidecar (on the reference corpus 15 slides carry
  a second, transcribed video behind an untranscribed bumper). `missing` = at
  least one media object but no transcript anywhere on the slide — that is
  D2's (#78) transcription queue.
- **ASR overlay (D2, issue #78)**: `packtool storyline extract <dir> --out
  <dir> --asr-dir <dir>` additionally resolves AUDIO objects (kind 'audio',
  layer `audiolib[]`) and sidecar-less media from the ASR transcript store
  written by `packtool/storyline/transcribe.py` (see
  `docs/training-transcription.md`). The store holds one
  `<objectId>_transcripts.js` file per media object id — the SAME byte format
  as native sidecars, decoded by the unchanged decode path — so slides come
  out with `transcript_source: "asr"`, `transcript_text` = concatenated cue
  texts, and `narration_ref` = `<id>_transcripts.js` (ASR-store-relative:
  deliberately NOT publish-relative, so it is NOT pushed into `source_files`).
  Without `--asr-dir` the output is byte-identical to the pre-#78 extractor
  (goldens pinned).
- **Version pin** (re-verify before reuse on any re-export): decode assumptions
  verified against Storyline `3.114.36620.0` / `bwVersion 4.0` (issue #77's
  invalidation clause). Corrections vs the issue text: `textLib` lives per
  OBJECT (`objects[].textLib[]`), and the reference export contains zero
  `%player.*%` tokens (the stripper is still mandated + unit-tested).

### Layout

- `storyline/decode.ts` — the two payload wrappers, single reusable functions.
- `storyline/walk.ts` — per-slide text walk (`vectorData.altText` +
  `vartext.blocks[].spans[].text`), token stripping, `text_chars`.
- `storyline/spine.ts` — data.js scene→slide walk + frame.js outline partition.
- `storyline/video-refs.ts` — sidecar resolution + cue concatenation (+ the
  issue #78 ASR overlay).
- `storyline/extract.ts` + `cli.ts` — document assembly and the CLI entry.
- `storyline/transcribe.py` — D2 (#78) offline narration transcription
  (Python, build machine only, content-hash cache; see
  `docs/training-transcription.md`).
- `storyline/__tests__/` — acceptance tests (AC1–AC8 of issue #77 plus the
  #78 ASR-consumer integration test and the #79 build-storyline suite:
  docs-count, install-without-embedding, reproducibility, player assets,
  transcript wiring, index conformance + retrieval, chunker parity, and a
  negative/guardrail file) against the committed mini fixture
  `../tests/fixtures/storyline-mini` (byte-for-byte golden output) and the
  synthetic publish in `__tests__/helpers/build-fixture.ts`. CI runs
  the fixture suite only; the full 384-slide corpus run is a documented
  manual acceptance step (`packtool` never ships media).

### Fixture origin and licensing

`tests/fixtures/storyline-mini/` trims a portion of an internal Articulate
Storyline 360 HTML5 publish held at `E:\ClaudeCode\OpMed CDP MicroLearning
Companion_7-10-26` on the operator's local machine (issue #77's reference
corpus). The fixture is committed solely to pin the extractor's byte-for-byte
output for CI; **no redistribution right is asserted for the embedded
courseware**, and consumers should treat the fixture as an internal test
artifact, not as redistributable content. If you fork or reuse this package,
replace the fixture with content you are licensed to distribute or generate a
new minimal fixture from your own publisher.

## `packtool build-storyline` (issue #79)

```bash
node packtool/dist/cli.js build-storyline <publishDir> --out <pack.zip> \
  [--asr-dir <dir>] [--embedder hash|onnx] [--embedding-model <dir>] \
  [--id <pack-id>] [--version <semver>] [--name <name>] [--published-at <iso>]
# build first: npm --prefix packtool run build
```

Composes the extracted per-slide documents (D1), the D2 ASR transcript store
(`--asr-dir`, resolved at extraction time), and the raw publish folder into one
installable training pack (`source_class: "training"`) with a PREBUILT
`index.sqlite` (embeddings + FTS5 over every slide document plus the
course-outline document), so installing the pack requires zero client-side
re-embedding.

- **pack.json** follows the DRAFT manifest schema quoted in issue #68 (C1,
  still open): required `id/name/version/published_at/source_class/embedding/
  chunking/docs`, optional `index`. When #68 lands with
  `contracts/pack.schema.json`, verify against that file and adopt any field
  drift as an additive re-plug — build-storyline's field shapes are marked
  draft-per-#68 in `build/pack-json.ts`.
- **Default pack id**: `<course-title-slug>-<courseid-lowercase>` from
  meta.xml (collision-safe across same-titled courses, stable across
  re-publishes). Loud failure when meta.xml has no `courseid` and `--id` is
  not given. `--version` defaults to `1.0.0`.
- **Embeddings**: `--embedder onnx` (default) uses transformers.js over the
  repo-staged `bge-small-en-v1.5` weights (384-dim, cls pooling, L2-normalized,
  fp32 — same conventions as the desktop ingest embedder; ADR-0001 #55 may
  re-pin, which is a `--embedding-model` invocation change, not a schema
  change). `--embedder hash` is the deterministic hermetic fixture for
  dev/CI (stamped `model_id: "hash"`); the hash fixture never ships a
  production pack. A usable onnx model dir has `onnx/model.onnx` >= 10 MB
  (LFS-pointer rejection).
- **Chunking**: `chunking.strategy: "slide-aware"` — chunks never cross a
  slide/outline document boundary; within a document the desktop ingest
  chunker semantics apply (256 words / 100 overlap, sentence-aware, CJK char
  fallback). Parity with `desktop/main/backend/ingest/text-chunker.ts` is
  pinned by goldens in `storyline/__tests__/build-chunker.test.ts`.
- **Determinism / reproducibility**: with fixed inputs the emitted docs and
  chunk identities are content hashes (stable); `--published-at` fixes the
  one volatile timestamp (and the zip entry dates), making two builds
  byte-identical. Without it, `published_at` defaults to build time.
  Scope note (PR #108 review): byte-identity is guaranteed WITHIN a build
  environment (same machine, same onnxruntime build); cross-environment ONNX
  builds are float-identical but not guaranteed bit-identical — the `hash`
  embedder is fully deterministic everywhere.
- **Player assets**: `html5/`, `story.html`, and `story_content/` are copied
  byte-for-byte under `assets/player/` in the pack. Symlinks and Windows
  junctions inside the publish folder are REFUSED (loud error, no pack) —
  they are never dereferenced into the pack.
- **Index**: `index.sqlite` applies the authoritative
  `contracts/store.schema.sql` (sqlite-vec 0.1.9 pin; `meta.schema_version`
  1, `meta.embedding_model_id`/`meta.embedding_dims` stamped from the build).

## `packtool verify` (issue #79)

```bash
node packtool/dist/cli.js verify <pack.zip | packDir>
```

Validates a pack (zip or unpacked directory): pack.json conformance against
the #68 draft shape, a per-doc sha256 re-hash of every `docs[]` member (tamper
detection), prebuilt-index stamp conformance (`schema_version`, embedding
dims/model id, row-count parity, docs-table hash set, packs-row id), and the
`assets/player/story.html` anchor. Exit 0 prints
`verify: OK (docs=<n>)`; failures print one `problem: <line>` each and exit 1.

### Module map (issue #79 additions)

- `build/compose.ts` — the build-storyline orchestrator.
- `build/pack-json.ts` — manifest/outline types, serialization, pack-id
  derivation, the shared `assertSafeDocPath` path-safety guardrail.
- `build/chunk.ts` — slide-aware chunking + content-derived identity
  (`docId`/`chunkId` formulas byte-match the desktop ingest pipeline).
- `build/embedder.ts` — hash fixture + onnx production embedding surfaces.
- `build/index-writer.ts` — schema application + row writes (also the single
  local DDL-apply surface reused by the acceptance install test).
- `build/verify.ts` — the verify implementation.
