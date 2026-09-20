# Knowledge Pack Security: Threat Model and Install Gate (issue #75)

Scope: the Knowledge Pack installation surface — every path that turns
pack bytes into an installed pack: the Python `PackManager`
(`pack_manager.py`, whose zip-upload extractor lives behind the
`POST /packs/install` route in `api_server.py` and shares `pack_extract.py`),
the Node `PackManager` (`desktop/main/backend/store/pack-manager.ts` with
its zip extractor `pack-extract.ts`), and `packtool verify` (the offline
gate over the same dispositions). This document cross-references
`docs/security/desktop.md` (the desktop transport threat model, issue #60)
and is cross-referenced from it. Pack format semantics are frozen by C1
(`contracts/pack.schema.json`); Python-side server hardening generally is
`docs/security_hardening_guide.md`.

## Architecture invariants

1. **Every install path passes the shared validation core.** The checks
   live in ONE module per language — Python `pack_extract.py` (consumed by
   both the api_server zip route and `pack_manager.install`) and the Node
   twin `desktop/main/backend/packs/pack-extract.ts` (consumed by both the
   zip-upload surface and `pack-manager.ts`) — with `packtool verify`
   enforcing the same entry-safety and limit rules on ZIP-form packs via
   `packtool/build/zip-safety.ts` and the manifest-level rules via
   `packtool/build/pack-json.ts`. (packtool and desktop are separate npm
   packages with no workspace root; cross-package parity is pinned by the
   frozen C8/C11 checks.) A new check goes into a shared core, never into a
   caller only.
2. **Containment is proven on the RESOLVED path, never on token shape
   alone.** An entry name is first rejected by `safeEntryName` /
   `safe_entry_name` (empty, backslash, leading `/`, drive-relative or
   drive-absolute names matching `^[A-Za-z]:`, `..`/`.` path elements,
   NUL/control characters), and the resolved target —
   `os.path.normpath(join(root, name))` on the Python side,
   `path.relative`-based containment on the Node side — is then verified
   against the extraction root with a trailing-separator-safe,
   case-insensitive-on-Windows comparison BEFORE any bytes are written.
   Token-shape guards (element equality, `isAbsolute`) are the exact RC1
   defect class this invariant exists to kill: `E:../x.txt` passes both
   yet `ntpath.join` treats its drive-letter segment as a new anchor and
   silently discards the extraction root.
3. **sha256 verification is mandatory and fail-closed.** Every
   `docs[].sha256` in the manifest is verified against the extracted file
   bytes BEFORE any chunking or insert; a mismatch refuses the install
   with zero chunks written and no partial state.
4. **Compatibility gates refuse before any write or insert.** The
   embedding-model, `index.schema_version`, and `index.sqlite_vec_version`
   comparisons run after manifest validation and before the symlink
   walk/copytree/chunking — a mismatch is an explicit refusal, never an
   auto-migration and never a warning.
5. **Limits are config, not constants.** Byte, entry, and ratio caps plus
   signature policy are read from configuration (see Configuration
   surface) with the issue-pinned defaults; none is a module-level
   constant.

## Threats and mitigations

### Path traversal
- **Threat:** a crafted entry name in an uploaded pack zip writes outside
  the extraction root — classic zip-slip, including drive-relative
  variants (`E:../x.txt`, `C:/evil`) that defeat token-shape guards
  because `ntpath.join` treats a drive-letter segment as a new anchor and
  discards the temp root entirely.
- **Mitigations:**
  - `safeEntryName` / `safe_entry_name` rejects the malformed name classes
    outright: empty, `\`, leading `/`, drive-relative/absolute
    (`^[A-Za-z]:`), `..`/`.` elements, NUL/control chars.
  - `ensureContained` / `ensure_contained` then proves containment on the
    RESOLVED path (normpath/relative, trailing-separator-safe,
    case-folded on Windows) — guard G2 of the extraction matrix, enforced
    before ANY write. The guard order is safest-first: per-entry name and
    symlink validation precede even the manifest-presence check (G1), and
    symlink entries are refused on `external_attr` (G3).
  - Both extractors (Python `safe_extract_pack_zip`, Node `extractPackZip`)
    share these rules, and `packtool verify` re-checks `docs[].path`
    shape offline — one disposition vocabulary across every install path.

### Zip bomb
- **Threat:** an archive whose decompressed content vastly exceeds its
  compressed size exhausts disk or memory during extraction.
- **Mitigations:**
  - Declared-size pre-filter (G4): the sum of declared uncompressed entry
    sizes is checked against `packs.security.maxUncompressedBytes`
    (default 2147483648, i.e. 2 GiB) before decompression starts.
  - Declared-ratio pre-filter (G5): total declared uncompressed size over
    total declared compressed size (directory and zero-size entries
    skipped) is checked against `packs.security.maxCompressionRatio`
    (default 100).
  - Unspoofable backstop (G6): a written-bytes cap — streaming with a
    running total in Python, post-hoc in Node — bounds actual disk writes
    regardless of what the archive declared. Declared metadata is
    advisory; written bytes are truth.

### Entry-count bomb
- **Threat:** a huge number of tiny entries slips under the byte caps and
  exhausts file handles, inodes, or extraction time instead.
- **Mitigations:** the archive's entry count is capped by
  `packs.security.maxEntries` (default 5000) before extraction; the Node
  central-directory pre-parser enforces the same bound from archive
  metadata, and the ZIP32 limit itself refuses >65535 entries outright
  (see Known limits).

### Tampering
- **Threat:** pack contents are modified after build (or in transit) so
  that chunk text no longer matches the hashed bytes the index was built
  from — silent misalignment rather than a crash.
- **Mitigations:** `docs[].sha256` verification is mandatory and
  fail-closed: the manifest's hash is compared against the extracted file
  bytes BEFORE any chunking or insert, and any mismatch refuses the
  install with zero chunks written (present at base and preserved by C8;
  the compatibility gates below run before the copytree/chunking stage so
  a refused pack leaves no partial state).

### Embedding model mismatch
- **Threat:** a pack built for a different embedding model installs into
  a live index; every vector is silently misaligned with the chunk text
  beside it.
- **Mitigations:**
  - The gate compares `embedding.model_id` against the install target
    after canonicalization (basename via strip-through-last-`/`,
    casefold) so `BAAI/bge-small-en-v1.5` and `bge-small-en-v1.5` agree.
  - A mismatch refuses with an explicit remedy telling the operator to
    rebuild the pack with `packtool build-docs --embedding-model`.
  - Gate target: the live embedder's model id — Python resolves it from
    `settings.rag_embedding_model` (canonicalized), Node from
    `packs.security.embeddingModelId` overridable via
    `TRAININGAPP_PACKS_EMBEDDING_MODEL_ID`, defaulting to the ADR-0006 pin
    `bge-small-en-v1.5`. `packtool verify` applies the same refusal when
    `--embedding-model` is passed (advisory warning otherwise).

### Schema/sqlite-vec mismatch
- **Threat:** a pack built against a different store schema or a
  different sqlite-vec extension version installs and corrupts or
  misreads the index.
- **Mitigations:** `index.schema_version` is pinned to 3 and
  `index.sqlite_vec_version` to 0.1.9; any deviation is REFUSED with an
  explicit error when an `index` block is present (packs without one
  bypass both stamp gates by design, matching the C1 fixtures) — never
  auto-migrated. The pins mirror the packtool build-time stamps so a pack
  cannot be built for one version and installed into another.

### Unsigned packs
- **Threat:** no provenance — anyone can build a structurally valid pack,
  so the structural gates above prove shape, not origin.
- **Mitigations:** opt-in ed25519 signature verification, config
  `packs.security.requireSignature` (default false) and
  `packs.security.trustedKeys` (a list of `{key_id, public_key}` pairs,
  public key as base64 DER SPKI). The signature is verified over
  CANONICAL manifest bytes: the `pack.json` object with
  signature block removed, keys recursively sorted at every depth
  (arrays keep order), compact separators `(",", ":")`, raw UTF-8 output
  with no `\uXXXX` escapes, and integers only — a non-integer number
  fails closed as unverifiable rather than risk cross-language
  repr divergence. Python verifies via `cryptography` ed25519; Node via
  `node:crypto` DER SPKI keys; `packtool verify` accepts the same
  `--require-signature` / `--trusted-keys-file` semantics.

## Configuration surface

Canonical keys are `packs.security.*`; each backend spells them as
follows. Defaults: `maxUncompressedBytes` 2147483648 (2 GiB),
`maxEntries` 5000, `maxCompressionRatio` 100, `requireSignature` false,
`trustedKeys` empty.

Python (`config.py` field, env alias):

| Canonical key | config field | Env alias |
|---|---|---|
| maxUncompressedBytes | `rag_packs_security_max_uncompressed_bytes` | `RAG_PACKS_SECURITY_MAX_UNCOMPRESSED_BYTES` |
| maxEntries | `rag_packs_security_max_entries` | `RAG_PACKS_SECURITY_MAX_ENTRIES` |
| maxCompressionRatio | `rag_packs_security_max_compression_ratio` | `RAG_PACKS_SECURITY_MAX_COMPRESSION_RATIO` |
| requireSignature | `rag_packs_security_require_signature` | `RAG_PACKS_SECURITY_REQUIRE_SIGNATURE` |
| trustedKeys | `rag_packs_security_trusted_keys` | `RAG_PACKS_SECURITY_TRUSTED_KEYS` |

`RAG_PACKS_SECURITY_TRUSTED_KEYS` is a JSON string
(`[{"key_id": ..., "public_key": ...}]`, base64 DER SPKI). The embedding
gate target is `settings.rag_embedding_model` (canonicalized; default
`BAAI/bge-small-en-v1.5`).

Node (`BackendHostConfig.packsSecurity` fields, env override):

| Canonical key | Env |
|---|---|
| maxUncompressedBytes | `TRAININGAPP_PACKS_MAX_UNCOMPRESSED_BYTES` |
| maxEntries | `TRAININGAPP_PACKS_MAX_ENTRIES` |
| maxCompressionRatio | `TRAININGAPP_PACKS_MAX_COMPRESSION_RATIO` |
| requireSignature | `TRAININGAPP_PACKS_REQUIRE_SIGNATURE` |
| trustedKeys | `TRAININGAPP_PACKS_TRUSTED_KEYS` |
| embeddingModelId | `TRAININGAPP_PACKS_EMBEDDING_MODEL_ID` |

`TRAININGAPP_PACKS_TRUSTED_KEYS` uses the same JSON shape;
`TRAININGAPP_PACKS_EMBEDDING_MODEL_ID` defaults to
`bge-small-en-v1.5` (ADR-0006). The route-level upload cap
(`PACK_ZIP_MAX_UPLOAD_BYTES`, 50 MiB compressed) is unchanged and sits in
front of these decompression-side limits.

## Known limits (explicit, not silent)

- Entry names may contain a non-drive colon (e.g. `name:stream`): it does not escape the extraction root — the file lands inside it — but on NTFS a colon is ADS syntax, so such entries are best treated as opaque. The manifest-level `docs[].path` validators share this gap; a strict `":" in name` rejection is a possible future tightening (4.5 review, 2026-09-20).

- Node/JSZip decompresses one entry fully before the unspoofable
  written-bytes cap counts it: the declared-metadata pre-filter rejects
  spoofed declarations early, but a single entry with a spoofed (small)
  declared size still forces one memory allocation up to its real
  decompressed size. JSZip offers no streaming decompress, so this
  residual is accepted and bounded by the upload cap plus the ratio
  ceiling on honest declarations.
- Declared central-directory metadata is spoofable in general; every
  pre-filter keyed on it (G4/G5, entry count) is an early-out, and the
  written-bytes cap (G6) is the authoritative backstop.
- The Node central-directory pre-parser is ZIP32-only: ZIP64 archives
  (above 4 GiB or with more than 65535 entries) are refused with an
  explicit error rather than misparsed. Unreachable for legitimate packs
  under the 2 GiB default `maxUncompressedBytes`.
- Signature verification is off by default (`requireSignature` false):
  it becomes meaningful only once E5 (#88) ships trusted-key
  distribution. Until then an operator opting in must provision
  `trustedKeys` by hand.
