# Training pack refresh runbook

Operator runbook for refreshing a Storyline training pack: re-extract the
publish, re-transcribe narration, rebuild the pack, verify it, publish it
through the signed update channel, and run the post-publish checks. The
command shapes here are execution-exact — the first occurrence of each
command in a fenced block runs as written against a real publish directory.

Companion docs: [pack-authoring-guide.md](pack-authoring-guide.md) (pack
format and the packtool verbs), [training-transcription.md](training-transcription.md)
(ASR deep dive), [ADR-0004](adr/0004-knowledge-packs.md) (pack format and
lifecycle semantics), [docs/updates.md](updates.md) (publishing).

## Prerequisites

- A build machine with Node (packtool is Node/TypeScript) and Python 3.11.
- The refreshed Articulate Storyline 360 HTML5 publish folder, exported
  unmodified to `publish/` (decode assumptions are pinned to Storyline
  `3.114.36620.0` / `bwVersion 4.0`).
- For narration transcription only: `faster-whisper` installed on the
  build machine (`pip install faster-whisper` — it is NOT in
  `requirements.txt`, and nothing in the shipped app imports the tool).
- For a production (shippable) pack: staged `bge-small-en-v1.5` weights
  under `models/` or via `--embedding-model` (see the
  [pack-authoring-guide.md](pack-authoring-guide.md) embeddings section);
  the `hash` embedder used below is the deterministic fixture.

Build the tool first (from the repository root):

```bash
npm --prefix packtool ci
npm --prefix packtool run build
```

## Step 1 — Extract the publish into slide documents

```bash
node packtool/dist/cli.js storyline extract publish/ --out extract-out/
```

`--out` is required. This produces one RAG-ready document per content
slide — `extract-out/slides/slide-<NNN>-<slideId>.json` in spine order —
plus `extract-out/outline.json` (`course`, `duration`, scene sections).
Slide titles come from `data.js`, section titles from `frame.js`'s outline,
and video narration is resolved from native
`story_content/<id>_transcripts.js` sidecars. The extractor's output is
pinned byte-for-byte by committed goldens, so an unchanged re-publish
extracts identically — diffs you see after Step 1 are real content changes.

## Step 2 — Re-transcribe narration (build machine only)

Slides whose media has no native sidecar come out with
`transcript_source: "missing"`. Recover that narration with the offline
ASR tool — all four flags are required by its argument parser:

```bash
python packtool/storyline/transcribe.py --publish publish/ --out asr-out/ --cache-dir asr-cache/ --report asr-report.json
```

The tool inventories every audio/video object without a sidecar,
transcribes it with faster-whisper (defaults: model `distil-large-v3`,
compute type `int8`, language `en`), and writes one
`<objectId>_transcripts.js` per media OBJECT id — the same byte format and
id space as native sidecars, so the extractor reads ASR output through its
unchanged decode path. The cache is keyed by CONTENT — sha256 of the media
bytes plus the ASR parameters — never by filename, because publish
filenames churn across re-exports; a re-run over unchanged media is all
cache hits. The JSON report is written on every path (including fatal
errors) and the exit code is non-zero when any failure is recorded.
`faster_whisper` is imported lazily, so `python
packtool/storyline/transcribe.py --help` works on machines without it.

Then re-run the extraction with the ASR store overlaid:

```bash
node packtool/dist/cli.js storyline extract publish/ --out extract-out/ --asr-dir asr-out/
```

Overlaid slides carry `transcript_source: "asr"` and an ASR-store-relative
`narration_ref`. Without `--asr-dir` the extraction is byte-identical to
the plain Step 1 run, so the overlay can be adopted or dropped without
changing the rest of the pipeline.

## Step 3 — Rebuild the training pack

```bash
node packtool/dist/cli.js build-storyline publish/ --id training-pack-refresh --version 1.0.0 --embedder hash --out training-pack-refresh-1.0.0.zip
```

`--out` (not `-o`) is required. Bump `--version` (semver) for the refresh;
`--id` must match the pack id pattern
(`^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$`) and stays stable across versions
of the same course. `--embedder hash` is explicit above because the
default embedder is `onnx`, which needs staged weights — for the pack you
actually ship, drop that flag and stage the weights. Pass
`--asr-dir asr-out/` to bake the transcripts in at extraction time, and
`--published-at <iso>` for a byte-reproducible build (it fixes the one
volatile timestamp; otherwise it defaults to build time).

The build composes the extracted slide documents, the ASR store, and the
raw publish folder into one `source_class: "training"` pack: player assets
(`html5/`, `story.html`, `story_content/`, plus `mobile/` when present)
copied byte-for-byte under `assets/player/`, slide-aware chunking, and a
prebuilt `index.sqlite` (embeddings + FTS5, schema and sqlite-vec stamps
from `contracts/store.schema.sql`) so installation re-embeds nothing.

## Step 4 — Verify the pack

```bash
node packtool/dist/cli.js verify training-pack-refresh-1.0.0.zip
```

`verify` re-validates the manifest against the frozen schema, re-hashes
every `docs[]` member, checks the prebuilt-index stamps (schema version,
embedding dims/model id, row-count parity, packs-row id), enforces the
sqlite-vec `0.1.9` pin, and requires the `assets/player/story.html`
anchor for training packs. Success prints `verify: OK (docs=<n>)`;
failures print one `problem:` line each and exit 1. Use
`packtool diff <old.zip> <new.zip>` to summarize the doc-level changes for
the release note.

## Step 5 — Publish via the signed update channel

There is no auto-publish: pushing a pack to users is an operator action on
the E5 signed feed (default-OFF, opt-in per install). Follow
[docs/updates.md](updates.md) and [ADR-0010](adr/0010-update-channels.md):
compute the artifact sha256, sign the digest with the release signing key,
assemble `pack-feed.json` per
[`contracts/pack-feed.schema.json`](../contracts/pack-feed.schema.json)
(unsigned entries are rejected by the format itself), validate it, and
attach it to the GitHub Release. Opted-in installs fetch the feed,
verify the Ed25519 signature against the build-time-baked public key, and
install through the same hardened loopback route as a drag-drop zip
(every C8 guard applies; pack artifacts are capped at 50 MiB).

## Step 6 — Post-publish checks

- **Learn regression.** The Learn panel surfaces slide grounding for
  training content, so a refresh must not regress slide retrieval. Run the
  tier-0 harness in [`eval/README.md`](../eval/README.md) against the
  backend: the Learn hit@3 metric is computed over exactly the rows with
  `expected_training_slide_id`, and recall@k / MRR / abstain accuracy keep
  the run comparable across surfaces and time. The browser-side layers
  (CI-runnable Vitest regression with deterministic mocks, plus the
  operator guidance script) are documented in
  [`web_ui/scripts/eval/README.md`](../web_ui/scripts/eval/README.md).
- **Doc-to-slide links.** A refreshed training pack changes the slide
  corpus, so the links from installed doc packs must be recomputed against
  the new pack (D4; see [ADR-0004](adr/0004-knowledge-packs.md)):

  ```bash
  node packtool/dist/cli.js links --pack docs-pack.zip --training training-pack-refresh-1.0.0.zip
  ```

  Defaults: cosine threshold 0.5, top 3 per chunk; the rows are written
  into the doc pack's `index.sqlite` `links` table. The command refuses
  when the two packs' embedding spaces are not comparable.

## Rollback

PackManager rollback semantics make a bad refresh recoverable without
re-downloading anything: superseded versions are retained on disk
(inactive-but-retained), and `rollback(pack_id, to)` reactivates a prior
`id@version` from its retained managed directory. A refused or failed
update never touched the store — the previously active version stays
active. The user-facing flow (Knowledge Packs panel, prior version row,
Rollback) and the feed-path specifics are in
[docs/updates.md](updates.md); the semantics are frozen in
[ADR-0004](adr/0004-knowledge-packs.md).

## Rehearsing without real course content

Every step above can be rehearsed against the committed mini fixture
(`tests/fixtures/storyline-mini`) exactly as CI does — see the
`pack-fixture-build` job in
[`.github/workflows/conformance.yml`](../.github/workflows/conformance.yml).
Assemble the publish dir the same way the workflow's assembly step does
(copy the fixture tree, then add the `story.html` stand-in file named by
that step — the mini fixture ships without one):

```bash
mkdir -p rehearsal/pub
cp -r tests/fixtures/storyline-mini/. rehearsal/pub/
cp tests/fixtures/storyline-mini-story*.html rehearsal/pub/story.html
node packtool/dist/cli.js storyline extract rehearsal/pub --out rehearsal/extract-out/
node packtool/dist/cli.js build-storyline rehearsal/pub --id training-pack-refresh --version 1.0.0 --embedder hash --out rehearsal/out.zip
node packtool/dist/cli.js verify rehearsal/out.zip
```

Skip Step 2 in a rehearsal unless faster-whisper is installed — the mini
fixture's media set is what the ASR tool inventories, and `--help` is the
no-dependency smoke check. The fixture is an internal test artifact (see
the fixture-licensing note in
[packtool/README.md](../packtool/README.md)); never publish it.
