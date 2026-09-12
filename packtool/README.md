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
  "transcript_source": "sidecar" | "missing" | "none",
  "transcript_text": "…",                                    // sidecar cue texts, concatenated
  "narration_ref": "story_content/<mediaId>_transcripts.js", // D2 (#78) placeholder, see below
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
  least one video object but no sidecar anywhere on the slide — that is D2's
  (#78) transcription queue; `narration_ref` values are D2-owned placeholders.
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
- `storyline/video-refs.ts` — sidecar resolution + cue concatenation.
- `storyline/extract.ts` + `cli.ts` — document assembly and the CLI entry.
- `storyline/__tests__/` — acceptance tests (AC1–AC7 of issue #77) against the
  committed mini fixture `../tests/fixtures/storyline-mini` (byte-for-byte
  golden output). CI runs the fixture suite only; the full 384-slide corpus run
  is a documented manual acceptance step (`packtool` never ships media).

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
