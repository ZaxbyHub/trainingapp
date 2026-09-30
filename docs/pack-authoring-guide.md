# Knowledge Pack authoring guide

How to build, verify, and reason about Knowledge Packs with `packtool` —
the offline, Node-based build tool under `packtool/`. This guide is the
author-facing companion to the format freeze ([ADR-0004](adr/0004-knowledge-packs.md))
and the packtool reference ([packtool/README.md](../packtool/README.md)).

A **Knowledge Pack** is one installable artifact — a zip (or an unpacked
directory with the same layout) rooted at a `pack.json` manifest — that
carries documents, optional player assets, and a prebuilt `index.sqlite`
(embeddings + FTS5) so installing it requires zero client-side re-embedding.
The manifest format is frozen by
[`contracts/pack.schema.json`](../contracts/pack.schema.json) (JSON Schema
draft 2020-12, `additionalProperties: false`); runtime-neutral validation
lives in [`contracts/validate_pack.py`](../contracts/validate_pack.py).

## Quickstart

From the repository root, with Node installed (the same flow the
`pack-fixture-build` job in [`.github/workflows/conformance.yml`](../.github/workflows/conformance.yml)
runs on every pack-path PR):

```bash
npm --prefix packtool ci
npm --prefix packtool run build
node packtool/dist/cli.js build-docs contracts/fixtures/source-docs/ --id test-pack --version 1.0.0 --embedder hash -o out.zip
node packtool/dist/cli.js verify out.zip
```

`verify` prints `verify: OK (docs=<n>)` and exits 0 when the pack conforms.
`--embedder hash` is the deterministic, weights-free embedder used for
fixtures and CI (see [Embeddings](#embeddings)); a production pack is built
with the real embedder on a build machine.

## CLI verb reference

Source of truth: [`packtool/cli.ts`](../packtool/cli.ts). Exit codes: 0
success, 1 runtime failure (message on stderr), 2 usage error (the CLI
prints its usage block and exits 2 — for example when `--out` is missing
from `storyline extract`/`build-storyline`, when `--embedder` is not
`hash` or `onnx`, when `--version` fails the semver check, or when
`--published-at` does not parse as a date; both are checked at parse time).

### `build-docs` — plain documents to a pack

```bash
node packtool/dist/cli.js build-docs <sourceDir> -o <pack.zip> --embedder hash|onnx --embedding-model <dir> --id <pack-id> --version <semver> --name <name> --published-at <iso> --source-class bundled|training|user
```

Turns a folder of plain documents (`.md`, `.txt`, `.json` — JSON docs use
the bundled-min `{title, text}` convention) into one installable pack with
a prebuilt `index.sqlite`. `--out` and `-o` are interchangeable. Defaults:
`source_class` `bundled`, chunking strategy `fixed-words`, pack id from
`--id` or a slug of the folder name. Unsupported extensions are skipped
with a stderr note; symlinks/junctions are refused; a `.json` doc without a
string `text` field fails the build. With `--published-at` fixed, two
builds of the same source folder are byte-identical (it is the one volatile
field — without it, `published_at` defaults to build time).

### `storyline extract` — Storyline publish to slide documents

```bash
node packtool/dist/cli.js storyline extract <publishDir> --out <outDir> --asr-dir <dir>
```

Turns an unmodified Articulate Storyline 360 HTML5 publish folder into one
RAG-ready JSON document per content slide (`<outDir>/slides/…`, spine
order) plus `<outDir>/outline.json`. `--out` is required — the command
exits 2 without it. `--asr-dir` optionally overlays ASR transcripts
(produced by `packtool/storyline/transcribe.py`, see
[training-transcription.md](training-transcription.md)); a non-existent
`--asr-dir` directory is a loud exit-2 failure. Without `--asr-dir` the
output is byte-identical to the pre-overlay extractor (goldens pinned).
Decode assumptions are pinned to Storyline `3.114.36620.0` / `bwVersion
4.0` — re-verify before reuse on a re-export.

### `build-storyline` — publish folder to a training pack

```bash
node packtool/dist/cli.js build-storyline <publishDir> --out <pack.zip> --asr-dir <dir> --embedder hash|onnx --embedding-model <dir> --id <pack-id> --version <semver> --name <name> --published-at <iso>
```

Composes the extracted per-slide documents, the ASR transcript store, and
the raw publish folder into one `source_class: "training"` pack. Note the
flag is `--out` only — `-o` is not accepted by this verb. Defaults:
`--embedder onnx` (pass `--embedder hash` explicitly when no weights are
staged), `--version 1.0.0`, id derived from the course title slug +
`meta.xml` `courseid` (loud failure when neither exists). The player
assets (`html5/`, `story.html`, `story_content/`, and a `mobile/` sibling
when present) are copied byte-for-byte under `assets/player/`; symlinks
and junctions inside the publish folder are refused. Chunking is
`slide-aware` (chunks never cross a slide/outline document boundary).

### `verify` — offline gate over a built pack

```bash
node packtool/dist/cli.js verify <pack.zip> --embedding-model <model_id> --require-signature --trusted-keys-file <keys.json>
```

Validates a pack (zip or unpacked directory): `pack.json` conformance, a
per-doc sha256 re-hash of every `docs[]` member (tamper detection),
prebuilt-index stamp conformance (`schema_version`, embedding dims/model
id, row-count parity, packs-row id), the sqlite-vec pin, and the
`assets/player/story.html` anchor for `source_class: "training"` packs.
`--embedding-model` downgrades a model mismatch to a `warning:` line (exit
code unchanged — the runtime install gate is the hard refusal).
`--require-signature` demands a valid signature against
`--trusted-keys-file` (a JSON array of `{key_id, public_key}` entries).

### `diff` — compare two packs

```bash
node packtool/dist/cli.js diff <packA> <packB>
```

Reports added/removed/changed docs (by manifest `path` + `sha256`) and the
chunk-count delta, for release notes and CI review. Exit 0 for any valid
comparison (it is a report, not a gate); exit 1 on load or manifest errors.

### `links` — link doc chunks to training slides

```bash
node packtool/dist/cli.js links --pack <docPack.zip> --training <trainingPack.zip> --threshold <cosine> --top <k>
```

Computes doc-chunk to training-slide links (ADR-0004 / D4): for every
chunk in the DOC pack, the top-3 (overridable with `--top`) nearest
training slides above a cosine threshold (default 0.5, overridable with
`--threshold`) are written into the doc pack's `index.sqlite` `links`
table. Refuses (exit 1) when the doc pack itself is
`source_class: "training"`, or when the two embedding spaces are not
comparable (model id, dims, or normalize mismatch).

## `pack.json` field reference

Authoritative source: [`contracts/pack.schema.json`](../contracts/pack.schema.json).
Required top-level fields: `id`, `name`, `version`, `published_at`,
`source_class`, `embedding`, `chunking`, `docs`. Optional: `supersedes`,
`index`, `signature`. Unknown fields are rejected
(`additionalProperties: false`).

| field | rules |
|---|---|
| `id` | `^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$` (3–64 chars). Immutable across versions of the same pack. Validated at parse time by packtool. |
| `name` | 1–200 chars. |
| `version` | Semver 2.0.0 (`MAJOR.MINOR.PATCH` plus optional prerelease/build). Validated at parse time by packtool. |
| `published_at` | RFC3339 date-time (UTC recommended). Drives recency ranking; must not be confused with the file's mtime. |
| `source_class` | `bundled`, `training`, or `user`. Training packs must carry player assets (`story.html`, `html5/`, `story_content/`). |
| `supersedes` | Array of `id@version` strings (no build metadata). Whether an entry may name a foreign pack id is PackManager install policy (ADR-0004), not a format rule. |
| `embedding` | `{model_id, dims, normalize}` — all required. Packtool's pin is `bge-small-en-v1.5` (384 dims, L2-normalized; `packtool/build/pack-json.ts` / ADR-0006). |
| `chunking` | `{strategy, size, overlap}` — enum `fixed-words`, `fixed-tokens`, `page-aware`, `slide-aware`. |
| `docs[]` | `{path, sha256, title, mime}` (+optional per-doc `published_at`). `path` is pack-relative, forward-slash separated, no `..` segments; `sha256` is the hex digest of the raw doc bytes BEFORE chunking. |
| `index` | `{path, schema_version, sqlite_vec_version}` when a prebuilt index ships. `schema_version` must match `STORE_SCHEMA_VERSION` in `packtool/build/pack-json.ts` (currently `3`, matching the seeded `schema_version` in `contracts/store.schema.sql`); `sqlite_vec_version` must equal the pin `0.1.9` (ADR-0005). |
| `signature` | `{algorithm, value, key_id}` detached signature block. |

## Embeddings

- `--embedder hash` — deterministic, hermetic, needs no weights. Stamps
  `embedding.model_id: "hash"`. Use it for fixtures and CI; a hash-embedded
  pack never ships to users (the runtime install gate refuses unknown
  models).
- `--embedder onnx` (the default) — transformers.js over staged
  `bge-small-en-v1.5` weights: 384-dim, cls pooling, L2-normalized, fp32 —
  the same conventions as the desktop ingest embedder. The model dir is
  resolved from `--embedding-model`, the `TRAININGAPP_EMBEDDING_MODEL_DIR`
  environment variable, or `<repo>/models/bge-small-en-v1.5`. A usable dir
  carries `onnx/model.onnx` of at least 10 MiB (git-LFS pointers are
  rejected). On a build machine without staged weights, pass
  `--embedder hash` or stage the weights first.

## Versioning, supersede, and rollback

Chunk identity is content-derived (ADR-0004, normative):

```text
doc_id      = sha256(raw doc bytes)
chunk_id    = sha256(doc_sha256 + ":" + chunk_index + ":" + normalized_text)
```

Consequences: re-publishing a course whose slides did not change keeps
every chunk id stable; unchanged docs at the same manifest path keep their
chunks across an upgrade (delete-before-reingest touches only changed
docs).

Pack lifecycle (PackManager, both Python and Node twins; policy recorded
in ADR-0004):

- Installing a pack whose `id` matches an installed pack with a HIGHER
  semver `version` is an implicit in-place upgrade.
- Downgrades and equal-version reinstalls are refused by `install` — the
  former belongs to `rollback`, the latter to `remove` + `install`.
- `supersedes` entries naming an installed foreign `id@version` deactivate
  that version; its files are RETAINED on disk so rollback is possible.
- `rollback(pack_id, to)` reactivates a retained version from the
  per-version managed directory — no re-download, no re-fetch. Physical
  deletion happens only on explicit `remove`.

## Install hardening (summary)

Every install path (drag-drop zip, update feed, `packtool verify` offline)
shares one validation core. Full threat model:
[docs/security/packs.md](security/packs.md).

- Size/entry caps (config keys `packs.security.*`, defaults): 2 GiB total
  uncompressed bytes, 5000 entries, 100:1 declared compression ratio (the
  ratio check applies to archives at or above 16 MiB uncompressed).
- Symlink and junction entries are refused outright, never dereferenced.
- Path containment is proven on the RESOLVED path — not token shape —
  before any byte is written (zip-slip, including Windows drive-relative
  names, is refused).
- Every `docs[].sha256` is re-verified against the extracted bytes before
  any chunking or insert; a mismatch refuses the install with zero chunks
  written.
- Compatibility gates (embedding model id, `index.schema_version`,
  `index.sqlite_vec_version`) refuse before any write; there is no
  auto-migration path.
- The loopback upload route additionally caps pack zips at 50 MiB
  compressed.

## Signatures

- **Pack-level (local installs, opt-in):** Ed25519 over the CANONICAL
  `pack.json` bytes — the manifest object with the signature block
  removed, keys recursively sorted, compact separators, raw UTF-8, integers
  only. Configure `packs.security.requireSignature` (default false) and
  `packs.security.trustedKeys` (`{key_id, public_key}` pairs, base64 DER
  SPKI), or check offline with `packtool verify --require-signature
  --trusted-keys-file <keys.json>`.
- **Feed-level (update channel, mandatory):** the E5 signed update feed
  signs each artifact's sha256 with Ed25519 against a public key baked
  into the app at build time; unsigned or wrongly-keyed entries are
  refused with no fallback. Signing procedure and custody:
  [ADR-0010](adr/0010-update-channels.md) and
  [docs/updates.md](updates.md).

## Troubleshooting

| symptom | cause and remedy |
|---|---|
| Exit 2 with the usage block | Missing `--out` on `storyline extract`/`build-storyline`; unknown flag; `--embedder` value outside `hash|onnx`; `--version` not semver; `--published-at` not a parseable date; `--asr-dir` (or any value flag) given without a value. |
| `build-storyline` fails on a missing `courseid` | `meta.xml` carries no `courseid` and no `--id` was passed. Pass an explicit `--id` matching the id pattern. |
| Build fails to find embedding weights | The onnx embedder wants `models/bge-small-en-v1.5` (or `--embedding-model <dir>` / `TRAININGAPP_EMBEDDING_MODEL_DIR`). For fixtures and CI, pass `--embedder hash`. |
| `verify` problem line about sqlite_vec | `index.sqlite_vec_version` differs from the `0.1.9` pin — rebuild with the current packtool. |
| `warning: embedding model mismatch` on verify | Expected-model advisory from `--embedding-model <model_id>`; the hard refusal belongs to the install gate. Rebuild the pack for the target model. |
| `verify` problem about `story.html` | Training-class packs must carry `assets/player/story.html` (plus `html5/` and `story_content/`); the publish folder was incomplete at build time. |
| `links` exits 1 | The `--pack` side was itself a training pack, or the two packs' embedding spaces differ (model id / dims / normalize). |
| Two builds of the same source differ | `published_at` defaulted to build time. Pass `--published-at <iso>` for byte-identical output (within one build environment for onnx; the hash embedder is fully deterministic everywhere). |

For the training-course (Storyline) refresh workflow end to end, see the
companion [training-pack-refresh-runbook.md](training-pack-refresh-runbook.md).
