# Offline narration transcription (D2, issue #78)

`packtool/storyline/transcribe.py` is a **build-machine-only** CLI that
recovers narration text for every audio/video asset in an Articulate
Storyline 360 publish that has no native transcript sidecar, caches results
by content hash, and emits one sidecar-format transcript file per media
OBJECT id for D1's extractor to consume.

It is a Python tool (stdlib + `faster-whisper`); the packtool CLI itself
stays Node/TypeScript. Nothing in `web_ui/` or the Electron main process
imports or invokes it — there is **no runtime transcription dependency** in
the shipped app, and none may be added (acceptance check C5 pins this).

## Usage

```bash
pip install faster-whisper        # build machine only; NOT in requirements.txt

python packtool/storyline/transcribe.py \
  --publish "<publishDir>" \
  --out     "<asrDir>" \            # ASR transcript store (per object id)
  --cache-dir "<cacheDir>" \          # content-hash cache
  --report   "<report.json>"

# feed the store to the extractor:
node packtool/dist/cli.js storyline extract "<publishDir>" --out "<outDir>" --asr-dir "<asrDir>"
```

## Model choice (named, per the issue)

**`distil-large-v3`** (HuggingFace id `Systran/faster-distil-whisper-large-v3`),
CPU, `compute_type=int8`, `language=en`. Chosen per the issue's primary
option; feasibility was measured on the reference build machine before the
full run (32-thread x64, cold load ~4 s). The distil model is English-only —
matches the course corpus; pass `--model Systran/faster-whisper-medium.en`
to override (never mixed as a co-default). `--language` overrides `en`.

Audio decoding uses the FFmpeg libraries **bundled with** faster-whisper
(PyAV): MP3 narration files and the audio track of MP4 videos take the same
path. No system ffmpeg install is required (the issue's "e.g. via ffmpeg"
extraction is satisfied by this equivalent bundled decoder).

## Measured build-machine runtime (full corpus)

Reference corpus: OpMed CDP MicroLearning Companion (300 MP3 narration
assets + 37 sidecar-less video object ids = **337 media**, 45.8 minutes of
voiced audio; 22 of the 37 videos are silent bumpers with no audio stream).

- **Cold run (full ASR): ~34 minutes wall** (measured 2026-09-12 on the
  reference build machine, 32 threads, int8 distil-large-v3, sequential
  one-media-at-a-time processing; ~1.35x realtime).
- **Warm re-run (all cache hits): ~3 seconds** (the acceptance driver's
  own measured `elapsed` on the verified run).

## Cache and invalidation rule

Cache key (content-addressed, never filename-derived — publish filenames
embed sample-rate/index metadata that churns across re-publishes):

```
composite = "<format_version>|<sha256(media bytes)>|<model id>|<compute type>"
entry     = <cache-dir>/transcripts/<sha256[:12]>/<sha256(composite)>.json
```

The entry JSON stores the cues plus the full key components for auditability.
On read, the stored components are compared to the request; ANY mismatch
(different bytes, model, compute type, or format version) is treated as a
cache MISS and the media is re-transcribed. Rules:

- Re-publish with unchanged media (same bytes) → 100% cache hits, 0 ASR calls.
- Changed audio content under the same filename → different content hash →
  re-transcription.
- Model or compute-type change → different key → full re-transcription.
- Cache format change → bump `CACHE_FORMAT_VERSION` (re-keys everything).

## Output contract

`<asrDir>/<objectId>_transcripts.js`, byte-format identical to native
`story_content/<id>_transcripts.js` sidecars (`const data = {...};`
`window.globalLoadJsAsset(...)`), payload
`{"transcripts":[{"name":"captions","source":"asr","model":"…","cues":
[{"start_ms":<int>,"text":"…"}]}]}`. Keys are media OBJECT ids — the same id
space the extractor's native-sidecar lookup uses — so a re-publish whose
filenames churned still resolves. Media with no audio stream transcribes to
an empty cue list (the honest ASR result for silence), recorded with
`"note": "no audio stream"` in the report and cache entry.

The report JSON carries `total`/`media_count`/`transcribed`/`cache_hits`/
`failures` aggregates and one entry per media (kind, url, object_ids,
media_sha256, status `transcribed`|`cache_hit`|`error`, cues_path, note).
The CLI exits non-zero if any media failed; per-entry errors never abort the
run (partial-failure containment).

## Corpus coverage (acceptance evidence)

Reference-package run (2026-09-12): **300 audio + 37 video = 337 media
transcribed, 0 failures** (acceptance check C1). The issue's "33 sidecar-less
MP4s" was file-space arithmetic (57 files − 24 sidecars); the id-space census
(see trace `.agents/issue-traces/78-offline-narration-transcription/
03-localization-log.md` H4) found 61 distinct video object ids of which 37
have no sidecar — the invariant "every sidecar-less asset transcribed" covers
37 ⊇ 33, with no coverage gap.

## Spot-check sample (human-review anchor)

Real cues from the verified run (for the PR's 3–5 cue human spot-check;
pairings re-verified against `repro/c1-out/<objectId>_transcripts.js`):

- MP3 `5VOOljZy4F3_44100_56_0.mp3` → `{"start_ms": 0, "text": " Select the
  ProC button."}`
- MP4 `video_5ZwqGnPmoSe_9_56_378x690.mp4` (object id `5wX4swBbOLl`) →
  `{"start_ms": 0, "text": " Use a peripheral barcode scanner and scan the
  front of the patient's KAC."}`
- MP4 `video_5isWy96v20b_9_56_378x690.mp4` (object id `5ciTR6eNgk0`) →
  `{"start_ms": 0, "text": " There is no button to click to turn on the CAC
  scan search."}`
- Native sidecar `5a5ry690OX4` (not ASR) begins "Patient documentation from
  outside of CDP can be imported" — recorded here as the plausibility anchor
  the ASR outputs sit alongside.

## Out of scope (unchanged from the issue)

Real-time/runtime transcription on a user machine; transcript accuracy
scoring against a human reference; OCR of `txt__default_*.png` image text.
