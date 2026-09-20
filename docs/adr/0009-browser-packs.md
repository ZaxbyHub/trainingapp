# ADR-0009: Knowledge Packs on the browser surface — explicit capability gate

- **Status:** Accepted (2026-09-20)
- **Context:** Workstream C, slot C9, issue #76 (epic #50). Workstream C built
  the Knowledge Pack system for the desktop: the format freeze (ADR-0004),
  the Python and Node PackManagers (C2/C3), version precedence (C4),
  provenance citations (C5), the packtool prebuilt-index builder (C6), the
  desktop pack UX (C7), and install hardening (C8). The **pure-browser
  web_ui surface** (the secondary surface once Electron ships) never gained
  pack support: `web_ui/src/pages/DocumentsPage.tsx` mounts `PacksPanel` only
  under `electronMode && desktopSession`, and the browser-mode DropZone accept
  list excludes `.zip`, so a dropped pack zip is generically rejected as
  "Unsupported file type". ADR-0004 explicitly deferred this decision: "#76
  (C9) owns the separate browser-surface decision (browser adapter vs
  capability gate) … nothing in this freeze predetermines it."

  Two facts frame the decision. First, the browser storage stack is
  structurally different from the pack runtime: documents live in IndexedDB
  (Dexie) with EdgeVec (WASM HNSW) and FlexSearch, namespaced per profile as
  `${prefix}-doc-qa-documents`, `-doc-qa-indexes`, `-doc-qa-index` and
  `-doc-qa-keywords` (`web_ui/src/lib/storage/profile.ts:92-99`); there is no
  SQLite dependency anywhere in `web_ui/`, so C6's prebuilt `index.sqlite`
  (sqlite-vec `vec0` + FTS5, `contracts/store.schema.sql`) cannot be mounted
  client-side at all. Second, the browser surface has unresolved
  foundational gaps of its own: `web_ui/src/lib/llm/model-readiness.ts:72-77`
  budgets the browser LLM at 4 GB against its own documented 4.7–5.1 GB peak,
  and `web_ui/src/lib/llm/wllama-service.ts:192,312` re-fetches the GGUF from
  same-origin on every page load because the in-memory storage backend has no
  cross-session persistence.

  Numbering note: the issue text pinned this ADR at
  `docs/adr/0005-browser-packs.md`, written when `docs/adr/` was still empty.
  ADRs 0004–0008 have since landed, so this record takes the next free
  number, `0009`. All downstream references use ADR-0009.

## Options

### Option A — Browser adapter (client-side importer)

A client-side importer reads a pack zip's `docs[]` (raw files + the C1
manifest's `path`/`sha256`/`title` metadata), re-extracts and re-chunks them
through the existing browser pipeline (`extractDocument`, `TextChunker`),
re-embeds with the browser's own model (`snowflake-arctic-embed-m-v1.5`,
768-dim, Transformers.js ONNX WASM), and writes the result into the standard
per-profile IndexedDB/EdgeVec/FlexSearch namespaces exactly like a manual
multi-file upload. The pack's prebuilt `index.sqlite` is ignored entirely —
the "zero re-embed" property C6 was built to guarantee does not survive the
crossing (and the embedding-model mismatch is not cosmetic: packs are built
against `bge-small-en-v1.5` at 384 dims, so the browser re-embed produces a
different vector space, and the desktop/Python install gates would refuse
that model mismatch outright). Citations can still display pack name/version
because those come from the manifest, not the index. Cost: an adapter plus a
renderer-side re-implementation of the C8-class untrusted-zip guards
(zip-bomb bounds, entry-name checks, hash verification) — the browser has no
equivalent of `pack-extract.ts` today.

### Option B — Explicit capability gate

The browser Documents page detects a dropped or selected file that carries
the C1 pack manifest signature (a zip whose root `pack.json` matches the schema's
required shape — the same recognition signal desktop guard G1 uses) and
shows a persistent message: **"Knowledge Packs require the desktop app —
install the Electron build to use bundled/training packs; plain documents
can still be uploaded here."** No import is attempted and nothing is written
to IndexedDB. Cost: a bounded signature sniffer (JSZip is already a web_ui
dependency) plus the notice; zero new import code and zero new storage.

## Decision table

| Option | Implementation cost | User experience | "Zero re-embed" property preserved? | Security surface added | Maintenance burden |
|---|---|---|---|---|---|
| Option A — Browser adapter | Moderate-to-high: importer + renderer-side C8-class zip guards + UI for pack picking; re-embed runs on WASM CPU for every doc | Bundled/training packs usable in-browser only after a slow client-side re-embed; long waits with no parallel desktop benefit | No — the prebuilt index is discarded; every pack is re-embedded with a different model (arctic-embed-m 768-dim vs bge-small 384-dim) into a new vector space | New: the renderer now buffers and parses untrusted zip archives client-side; G1–G6-class guards must be re-implemented where no hardened precedent exists | High: pack validation logic now exists in three places (Node, Python, browser) and will drift |
| Option B — Capability gate (chosen) | Low: a bounded manifest-signature sniff plus a persistent notice; no import path exists to harden | Clear, honest redirect to the desktop app for packs; plain-document upload on the browser surface is unchanged | Not claimed on this surface — the property is preserved where it was built (desktop/sqlite-vec); the browser never pretended to mount the prebuilt index | Minimal: one bounded root-entry read of an already-user-supplied file; no extraction, no writes, size-capped detection | Low: a single detector module mirroring the C1 schema's required-field signature; full validation stays server-side |

## Recommendation

**Adopt Option B — the explicit capability gate.** The verified evidence
makes the adapter's core promise uneconomic on this surface:

1. **The prebuilt index cannot be reused in the browser.** The browser's
   documents and vectors live in the per-profile IndexedDB namespaces
   (`${prefix}-doc-qa-documents` and siblings, `profile.ts:92-99`); there is
   no SQLite anywhere in the web_ui dependency tree, so C6's `index.sqlite`
   has no client-side consumer.
2. **The re-embed cost is real and the model mismatch is dispositive.** A
   browser adapter would have to re-embed every pack document with
   `snowflake-arctic-embed-m` (768-dim) although the pack fleet is produced
   against `bge-small` (384-dim) — a full WASM-CPU re-embed into a different
   vector space that discards exactly what C6 exists to precompute, and
   whose desktop/Python install gates would reject as a model mismatch.
3. **The browser surface has more foundational gaps to close first.**
   `model-readiness.ts` under-budgets the browser LLM (4 GB budget vs
   documented 4.7–5.1 GB peak) and the model binary is re-fetched on every
   page load; investing in browser pack ingestion would deepen a surface
   whose core question loop is already constrained.
4. **The desktop is the primary pack surface.** ADR-0004 froze the format
   for the desktop runtimes, C7 built the pack UX there, and the Electron
   app is the primary surface of the v3 roadmap; the gate preserves a clean
   boundary and gives users the correct remedy instead of content-blind
   feedback.

Option A remains the right shape if the browser surface later becomes
primary or if user-generated packs (already in the browser's embedding
space) justify a dedicated follow-on; nothing in this decision forecloses
it — it records that the evidence does not support building it now.

## PoC shipped with this decision

A thin proof-of-concept of Option B only, sufficient to validate the cost
and UX claims: `web_ui/src/lib/packs/pack-detect.ts` (the bounded manifest-
signature sniffer: size cap, root `pack.json` read, minimal required-field
shape mirroring `contracts/pack.schema.json` — a trigger, not a validator)
and a persistent gate notice on the browser Documents page
(`data-testid="pack-gate-notice"`) shown when a pack zip is dropped OR
selected — both entry points are classified with the same content-based
signature check, because the file picker's `accept` attribute is a chooser
hint, not an enforcement boundary. The generic unsupported-type toast is
preserved for everything else. The
behavior is pinned by the frozen Playwright check
(`web_ui/e2e/packs-gate.spec.ts`: gate appears for a real fixture pack zip,
no IndexedDB namespaces are created or written, and a non-pack zip does not
trigger the gate) plus component/unit tests running in the ordinary vitest
CI leg. Electron mode is untouched: there, PacksPanel and the C7 install
path continue to own `.zip` files.

Residual risk accepted for this PoC: the detector reads a user-supplied zip
in the renderer. The compressed input is size-capped
(`MAX_PACK_DETECT_BYTES`), only the central directory and the single root
`pack.json` entry are read, nothing is extracted to disk, and every
read/parse failure is treated as "not a pack". Two bounds must be stated
precisely: the size cap bounds the COMPRESSED input only — a zip entry's
decompressed size is not known until JSZip materializes it (JSZip does not
stream), so a hostile small archive can inflate a `pack.json` entry to a
large in-memory string; the detector therefore rejects oversized manifest
text before `JSON.parse` (`MAX_MANIFEST_CHARS`), but the materialization
residual itself remains, exactly as the desktop path already accepts for
JSZip-based extraction (docs/security/packs.md). A manifest within bounds
can at worst cost one linear parse. The full C8 guard set (ratio and
declared-size ceilings, written-bytes backstop) remains a desktop-install
concern and is explicitly out of scope here.

## Consequences

- **Decision recorded for downstream:** Future browser-surface work must reference this decision per ADR-0009 before adding any pack ingestion to the browser surface; a future revisit should reopen this ADR (supersede, not edit) with new evidence about the browser surface's foundations.
- Full production implementation of either option remains a follow-on issue
  (outside the C-slot list, per the issue's own scope rule); this change
  ships only the PoC above.
- The desktop/Electron pack surface (C7) is intentionally unchanged, and the
  browser-mode Electron branch of the Documents page keeps routing `.zip`
  files to the pack install API.
- The detector's minimal signature check must stay in sync with
  `contracts/pack.schema.json`'s required fields; it deliberately re-checks
  only the load-bearing subset (id and sha256 patterns) and must not grow
  into a parallel validator.
