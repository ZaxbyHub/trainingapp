# ADR-0004: Knowledge Pack specification and format freeze

- **Status:** Accepted (2026-09-16)
- **Context:** Workstream C, slot C1, issue #68 (epic #50). "Bundled docs" is a
  stated product requirement that was built and then deliberately removed
  (`verify_remediation.py:145-148` audits the `seed_loader.py` deletion), and
  the v3 roadmap reintroduces the concept as Knowledge Packs — one artifact
  format that the Python and Node/Electron backends can validate, install, and
  reason about with identical semantics. Workstream D shipped consumers of the
  DRAFT format before this freeze: `packtool/build/pack-json.ts` implements the
  draft manifest shape and its header explicitly defers to this issue
  ("When #68 lands with contracts/pack.schema.json, validate against that
  file"), `packtool/build/verify.ts` and `packtool/links/link-pack.ts` validate
  packs with it, and `desktop/main/protocol.ts` serves installed packs from
  `<packsRoot>/<packId>/`. The format therefore had to be frozen to match what
  already ships, not reinvented.

- **Decision:** Freeze the Knowledge Pack manifest format at
  [`contracts/pack.schema.json`](../../contracts/pack.schema.json)
  (JSON Schema draft 2020-12, `additionalProperties: false`) and provide the
  runtime-neutral validator `contracts/validate_pack.py` (driven by the schema
  file itself via the `jsonschema` library — the file is the single source of
  truth; the validator never re-encodes schema rules by hand), fixtures under
  `contracts/fixtures/packs/`, and rejection tests in
  `contracts/tests/test_pack_schema.py`. Top-level manifest fields:
  `id`, `name`, `version`, `published_at`, `source_class`, `embedding`,
  `chunking`, `docs` (required); `supersedes`, `index`, `signature` (optional).
  This ADR records the format decision, the chunk-id formula, the
  supersede/rollback/dedup semantics, and the recency formula chosen for C4.

## Folder and zip layout

- `<pack-id>/pack.json` at the pack root (the manifest).
- `<pack-id>/docs/<relative paths from the manifest>` — doc bytes whose sha256
  is declared in the manifest.
- Optional `<pack-id>/index.sqlite` (prebuilt index; `index.schema_version`
  must match `contracts/store.schema.sql`'s `meta.schema_version` — `2` at
  freeze time — and `index.sqlite_vec_version` the sqlite-vec pin from
  ADR-0005, `0.1.9`).
- Optional `<pack-id>/pack.sig` (detached signature; format finalized by C8).
- Zip form: the same tree zipped with `pack.json` present as a root-level
  entry; entry ORDER is not constrained, only presence. Validators must read
  entries by exact name and never extract to disk (zip-slip-by-lookup), which
  is how both `packtool verify` and `contracts/validate_pack.py` behave.

## Chunk identity (normative)

Content-derived only — never derived from a document path (this replaces the
legacy path-hash `doc_id` at `document_processor.py:459` at the contract
level, exactly as the store schema froze for B5):

```text
doc_id      = sha256(raw doc bytes)
chunk_id    = sha256(doc_sha256 + ":" + chunk_index + ":" + normalized_text)
content_hash = sha256(normalized_text)
normalized_text = text with CRLF/CR normalized to LF and trailing horizontal
                  whitespace stripped per line
```

The `":"` separators are part of the frozen formula. This byte-matches the
shipped, interop-pinned implementations:
`desktop/main/backend/ingest/pipeline.ts` (`normalizedText`/`chunkId`),
`packtool/build/chunk.ts` (`normalizedText`/`chunkIdFor`), and
`contracts/tests/store-interop/run_interop.py` (`normalized()`); the
`contracts/store.schema.sql` chunks-table comment states the same function
without spelling the separators.

**Considered and not chosen:** the issue text sketched a variant with Unicode
NFKC normalization plus leading/trailing strip and internal whitespace
collapse. No shipped implementation does this, and pack rows must remain
byte-indistinguishable from runtime-ingested rows (the D3 design constraint
that makes installed packs identical to ingested content for B7 eval parity),
so adopting NFKC here would have broken every existing consumer. If a future
need for NFKC identity arises it is a schema-version bump, not an edit.

## Supersede, upgrade, and rollback semantics

- **Implicit in-place upgrade (the common case):** installing a pack whose
  `id` equals an installed pack's `id` and whose `version` compares higher is
  an upgrade; no `supersedes` entry is required.
- **`supersedes` at the format layer:** entries must match
  `<pack-id>@<semver>` (no build metadata). The format deliberately does NOT
  constrain the entry's id relative to the manifest's own id — the shipped
  TS validator imposes no such rule, and issue #68's own text is
  self-contradictory here (its schema description says the entry id MUST equal
  the pack's own id, while its semantics bullet reserves `supersedes` for
  cross-id replacement). Resolution: own-id-vs-cross-id adjudication is
  **PackManager install policy**, owned by C2 (#69) and C3 (#70), not a
  format-level rule; this ADR and the schema description point at this
  section. The frozen fixtures pin only well-formedness.
- **Rollback:** rolling back means reactivating a previously superseded
  `id@version` and deactivating the superseding version. Superseded packs'
  files and metadata rows are retained on disk specifically to make this
  possible — never physically delete on supersede; physical deletion happens
  only on explicit `remove` (C2/C3 verbs).

## Dedup semantics (specified here, implemented in C4/#71)

When two *active* packs contain chunks with the identical `chunk_id`,
retrieval keeps exactly one copy, choosing by: greater owning-pack
`published_at`; ties break on semver-highest `version`; remaining ties break
on lexicographically greatest `id` (pinned here so the ordering is total and
deterministic across runtimes).

## Recency ranking (chosen here, implemented in C4/#71)

The issue text documents two contradictory variants and directs this ADR to
pick one. **Chosen (shipping default) — linear interpolation to the floor:**

```text
r(age_months) = 1.0                              for age_months <= 0
r(age_months) = 1.0 - 0.15 * min(1, age_months / 18)   for 0 < age_months <= 18
r(age_months) = 0.85                             for age_months > 18
```

Config: `packs.recency.floor` (default `0.85`), horizon fixed at 18 months in
the default formula. The exponential half-life variant
(`packs.recency.halfLifeMonths`, default `9`) is retained only as an optional
C4 experiment behind configuration — it is NOT the shipping default, and both
implementations (Node and Python) must ship the linear form first so the two
backends cannot silently diverge.

## Fixtures

`contracts/fixtures/packs/` carries deterministic validation fixtures:
`bundled-min` (2 docs, no index), `training-stub` (1 doc, `source_class:
training`, `slide-aware`), `user-sample` (1 doc, `source_class: user`),
`versioned-a-1.0.0` + `versioned-a-2.0.0` (shared `id` `versioned-a`,
differing `version`, no `supersedes` — the implicit-upgrade pair), and
`invalid-traversal` (valid except `docs[0].path = "../../etc/passwd"`, which
must be rejected with the path echoed). The source-class fixtures carry no
`supersedes` field; supersedes coverage lives in the validator tests and the
full-optional-blocks pin.

## Consequences

- `packtool` adopts the schema file as its validation source in a follow-up
  (owned by C6/#73 per `pack-json.ts`'s header); this freeze changes no
  runtime code. The TS validator may stay stricter for its own builds (e.g.
  `slide-aware`-only) — the schema is the superset contract across
  bundled/training/user.
- If ADR-0001 (issue #55, embedding bake-off) re-pins `model_id`/`dims`,
  fixtures are regenerated (hashes are content-derived) — the schema shape
  does not change.
- `contracts/tests/test_pack_schema.py` runs in CI via the
  contracts-triggered step in `.github/workflows/desktop-build.yml`'s
  store-interop job (store-interop precedent); `scripts/check_test_collection.py`
  ignores `contracts/` by design.
- The validator's named path-traversal rejection is defense-in-depth ahead of
  C8/#75 runtime hardening.
