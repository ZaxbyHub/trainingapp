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

The manifest's `docs[].path` values are PACK-RELATIVE (e.g. `docs/welcome.json`,
`docs/outline.json`) — NOT relative to the `docs/` directory. Consumers must
join them onto the pack root directly.

- `<pack-id>/pack.json` at the pack root (the manifest).
- `<pack-id>/docs/<pack-relative entries>` — doc bytes whose sha256 is
  declared in the manifest.
- Optional `<pack-id>/index.sqlite` (prebuilt index; `index.schema_version`
  must match `contracts/store.schema.sql`'s `meta.schema_version` — `2` at
  freeze time, `3` since C3/#70's per-version packs — and
  `index.sqlite_vec_version` the sqlite-vec pin from ADR-0005, `0.1.9`).
- Optional `<pack-id>/pack.sig` (detached signature; format finalized by C8).
- Zip form: the zip is rooted at the pack root — `pack.json` is a top-level
  entry and there is NO enclosing `<pack-id>/` folder (this is what
  `packtool build-storyline` writes and both validators read). Entry ORDER is
  not constrained, only presence and exact spelling. Validators must read
  entries by exact name (case-sensitive, per the zip spec) and never extract
  to disk (zip-slip-by-lookup), which is how both `packtool verify` and
  `contracts/validate_pack.py` behave; folder sources follow the host
  filesystem's case rules (case-sensitive on Linux, insensitive on Windows),
  so manifests must declare paths with exact casing.

## Chunk identity (normative)

Content-derived only — never derived from a document path (this replaces the
legacy path-hash `doc_id` at `document_processor.py:459` at the contract
level, exactly as the store schema froze for B5):

```text
doc_id      = sha256(raw doc bytes)
chunk_id    = sha256(doc_sha256 + ":" + chunk_index + ":" + normalized_text)
content_hash = sha256(normalized_text)
normalized_text = text with CRLF normalized to LF (bare CR is NOT
                  normalized — byte-matching the implementations) and
                  trailing horizontal whitespace stripped per line
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
- The schema's `name` `maxLength: 200` (issue-frozen) is NOT enforced by
  today's packtool: `compose.ts` derives the pack name from the course title
  with no length cap, so a course titled longer than 200 chars would build a
  pack the frozen schema rejects. C6/#73's re-plug must enforce the cap at
  build time; until then `packtool build-storyline` accepts `--name`.
- #76 (C9) owns the separate browser-surface decision (browser adapter vs
  capability gate) and consumes this schema by path, as do C2-C8; nothing in
  this freeze predetermines it.
- If ADR-0001 (issue #55, embedding bake-off) re-pins `model_id`/`dims`,
  fixtures are regenerated (hashes are content-derived) — the schema shape
  does not change.
- `contracts/tests/test_pack_schema.py` runs in CI via the store-interop job
  in `.github/workflows/desktop-build.yml` (that job triggers on
  `contracts/**` among other paths; store-interop precedent);
  `scripts/check_test_collection.py` ignores `contracts/` by design.
- The validator's named path-traversal rejection is defense-in-depth ahead of
  C8/#75 runtime hardening.

## C2 PackManager install policy (recorded at C2 implementation, issue #69)

This section records the install-policy decisions ADR-0004 delegated to the
PackManager implementations (C2 Python, C3 Node):

- **Implicit upgrade (unchanged):** installing a pack whose `id` equals an
  installed pack's `id` with a HIGHER semver version is an upgrade; the prior
  active version's changed docs are delete-before-reingested (content-hash
  identity; docs whose sha256 is unchanged at the same manifest path keep
  their chunks).
- **Downgrade and equal-version installs are refused** by `install`:
  downgrades belong to `rollback`, and a same-version reinstall belongs to
  `remove` + `install`.
- **Cross-id `supersedes` entries are honored:** an entry naming an INSTALLED
  foreign `id@version` deactivates that version and deletes its chunks from
  the live collection; its managed files are retained (rollback-able). The
  issue #69 acceptance prose names a foreign id `a@1.0.0` which is
  schema-invalid (id pattern requires 3+ chars); the frozen schema pattern
  outvotes the prose — tests pin the equivalent schema-valid
  `pack-a@1.0.0`. Entries naming nothing installed are recorded on the new
  row and warn (C8/#75 may tighten this to a refusal).
- **Verb symmetry:** `supersede(pack_id, from, to)` and
  `rollback(pack_id, to)` are state verbs over ALREADY-INSTALLED rows;
  activation re-ingests from the retained per-version managed directory
  (`<packs_root>/<pack_id>/<version>/`), which content-hash identity makes
  byte-identical to the original install. Managed files are retained on
  deactivation and deleted only by `remove` (irreversible).
- **Folder-form install only (C2 Python):** `PackManager.install` refuses
  `.zip` sources with a clear `PackManagerError` naming the C6/C8 surface;
  zip ingestion (and prebuilt `index.sqlite` consumption) is the C6
  packtool / C8 hardening deliverable, not a C2 capability.

## Recency ranking implementation (amended at C4, issue #71)

C4 implements the ranking rules this ADR specified prospectively. The
shipping formula is the linear form decided above, now with a configurable
horizon: `packs.recency.floorMonths` (default `18`, the age at which the
floor is reached) and `packs.recency.floor` (default `0.85`) parameterize
`multiplier = 1.0 - (1.0 - floor) * min(1.0, age_months / floorMonths)` with
`age_months = (now - published_at) / 30.44 days`, applied multiplicatively to
the fused RRF score AFTER fusion (`adjusted = rrf * multiplier`) in BOTH the
Python (`recency.py` -> `VectorStore.get_context` hybrid path) and Node
(`desktop/main/backend/retrieval/recency.ts` -> `hybridRetrieve`) backends.
`packs.recency.halfLifeMonths` (default `9`) remains reserved for the
optional exponential half-life variant and is NOT wired: both backends ship
the linear form so they cannot silently diverge. Recorded decisions that
close the issue's open choice:

- The prior is defined on fused RRF scores only. The Python vector-only
  fallback path applies the version-precedence exclusion and cross-pack
  dedup (below) but not the recency multiplier, because it ranks by raw
  similarity, not fused RRF scores.
- Chunks without pack metadata (unpackaged/user-uploaded documents) are
  neutral: never excluded, never deduped, multiplier 1.0. Making them
  content-hash identified like pack chunks is a potential follow-up, not
  part of C4.
- Ordering scope note: all three passes (exclusion, dedup, multiply)
  operate on the FUSED candidate set, after RRF fusion — the issue's
  "excluded from the candidate set entirely before RRF" phrasing is
  satisfied in the observable sense (an inactive-pack chunk never surfaces
  in any ranking result, and is never merely down-weighted); the review
  trace (PR #117, finding OD-01) resolved the wording in favor of AC7,
  which pins the prior as an after-fusion multiplier.
- Exclusion ordering per candidate: inactive-pack exclusion first, then
  cross-pack dedup by precedence (greater owning-pack `published_at`, then
  semver-highest `version`, then lexicographically greatest pack `id` —
  exactly the dedup semantics section above), then the recency multiply.
  A chunk attributed to a pack that no active version claims (orphan of a
  superseded/removed version) is excluded from the candidate set entirely —
  defense-in-depth at the ranking layer against a PackManager delete bug.
- Citations in both /ask responses carry `pack_id`, `pack_version`,
  `pack_published_at` alongside the existing filename/page fields
  (`Citation` schema in contracts/api.openapi.yaml; contracts stay
  authoritative).
- Registry/parity note: the Python pack registry persists each active
  version's manifest `published_at` additively; pre-C4 registries load as
  null and render the neutral multiplier. The scale-invariance property
  the issue records still holds: the multiplier is multiplicative on
  whatever the fused score is, so an A5 embedding/reranker scale change
  does not require rework.
