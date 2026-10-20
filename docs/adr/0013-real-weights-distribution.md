# ADR-0013: Real-weights distribution is a two-artifact bundle (Setup.exe + models sidecar)

- **Status:** Accepted (2026-10-13; the owner's pick was made during the
  issue-tracer session for #131 and is recorded by this ADR, by PR #172's
  body/trace, and corroborated by the follow-up build-out issue #171 — it
  was not itself posted as a comment on issue #131; build-out deferred to
  issue #171)
- **Context:** Workstream E slot E1 (issue #84, PR #130) packaged models and
  packs with an integrity manifest and a measured ≤7 GB size budget, and its
  review left the distribution FORM as an open product fork (PRR-129, tracked
  as issue #131 item 1). The constraint is mechanical: `makensis.exe` aborts
  with `File: failed creating mmap of …-x64.nsis.7z` because the app archive
  is 4,177,827,908 bytes and NSIS's 32-bit installer format caps embedded
  files (single files generally) at 2 GB — see the "Known limit" note in
  `bench/RESULTS.md`, which carries the #156 update (the quality GGUF alone is
  now 1,674,455,040 bytes, under the cap on its own, but the full real-weights
  payload of ~2.4 GB of LLM GGUFs before packs and runtime still exceeds it).
  No single-file NSIS exe can therefore contain the ADR-0002 lineup. The
  verified real-weights artifact today is the `win-unpacked` directory target
  (integrity gate passes over it; layout/budget verified — `bench/RESULTS.md`
  E1 section), shipped as a .7z portable bundle, while CI's NSIS artifact is
  fixture-mode (~350 MB payload, `-fixture` marker in the manifest note).

## Options

### Option A — custom multi-volume NSIS machinery (rejected)

A bundled extractor plus multi-volume NSIS output so one Setup.exe still
works. Rejected: highest build-engineering cost, and it introduces new
failure modes (partial extracts, volume ordering, resume semantics) for a
problem the app's existing manifest verification already solves elsewhere.

### Option B — two-artifact bundle: Setup.exe + models sidecar (accepted)

Ship a small Setup.exe carrying the app shell (runtime, renderer, natives —
comfortably under the 2 GB cap; CI already builds exactly this in fixture
mode) together with a separate models/packs sidecar artifact, staged and
verified by the same E1 manifest mechanics the app already runs at every
startup (`desktop/main/integrity-check.ts`, `desktop/main/first-run/manifest-verifier.ts`).
The sidecar reuses the staging/verification vocabulary the first-run wizard
already speaks (a not-yet-staged install reports `staged:false` honestly and
the `<userData>/models` compatibility surface accepts the staged payload).
Those are two different components with two different notions of "staged", and
the distinction matters when reading the code:

- `staged` is a field on `WizardManifestResult`
  (`desktop/main/first-run/wizard-manifest.ts`). A packaged install with no
  manifest on disk returns `{ staged: false, manifest: null, verify: null,
  loadError: null }`, and the wizard treats that as a state to guide the user
  out of — NOT an error.
- The startup integrity gate (`desktop/main/integrity-check.ts`) has no
  `staged` field at all; `IntegrityGateResult` is `{ decision, failures,
  manifestPath, manifest, modelDirs }`. For a packaged build with no manifest
  the gate's decision is `block` with a named `manifest-unreadable` failure,
  never a silent `staged:false` skip. The `staged:false` phrase in that file's
  header comment describes the DEV-and-no-manifest skip arm, not a reported
  field.

### Option C — revisit the model/budget decision (rejected)

Reopen ADR-0002 / the ≤7 GB budget to squeeze the payload below the NSIS cap.
Rejected: the ≤7 GiB budget held at the pre-#156 measured 6.38 GB
installed footprint (bench/RESULTS.md E1 TOTAL row), the post-#156 staged
resources are ~1.5 GB SMALLER, and the post-swap installed total re-measure
is recorded PENDING per the RESULTS.md provenance rules — every direction
of travel is away from the budget, not toward it. The cap that actually
blocks shipping is about single-file embedding, not total footprint, and a
model revisit would undo the measured #156 lineup for an installer-format
reason.

## Decision

Option B — the two-artifact bundle — is accepted as the real-weights
distribution strategy: a small Setup.exe carrying the app shell plus a
separate models/packs sidecar staged and verified by the E1 manifest
mechanics. Options A (multi-volume NSIS) and C (model/budget revisit) are
rejected for the reasons recorded above.

## Consequences

- The distribution decision is recorded; the build-out is issue #171
  (electron-builder split targets, sidecar staging pipeline, install-time
  staging UX, and how sidecar entries ride the E5 signed update feed from
  ADR-0010 with their own manifest + signature coverage).
- Until #171 lands, the portable `win-unpacked` .7z + .sha256 + README
  bundle remains the shipping form for real weights; the fixture-mode
  Setup.exe remains CI-only and must never be mistaken for a real-weights
  installer (loud in the manifest note and artifact name).
  **How that bundle is actually produced** (corrected 2026-10-20, issue #171
  Part 1 — the previous wording implied a build-time producer that does not
  exist): `.7z` and `.sha256` have NO automated producer in this repository.
  They come from a MANUAL operator procedure documented in `desktop/README.md`
  ("Real-weights portable bundle"): a `7z a -mx=9 …` archive step followed by a
  `Get-FileHash … -Algorithm SHA256` pipeline. `README-portable.txt` is weaker
  still — no command in the documentation and no script in the repository
  creates it, it is untracked, and any copy on disk is local build output. So
  the shipping form is an operator-run sequence with one unproduced component,
  not a build artifact; treat "ship the README" as an instruction to an
  operator, and do not read the old wording as evidence that a packaging step
  emits it.
- The startup integrity gate is the single CORRUPTION anchor for BOTH
  artifacts: whatever is staged is verified against `resources/manifest.json`
  at every launch, so a missing or corrupted sidecar fails closed with named
  files rather than crashing. Honest limit: the manifest is unsigned
  (manifest-verifier.ts — protected only by write access to the install
  directory, none for portable builds per ADR-0011), so against a
  ADVERSARIAL sidecar writer this anchor proves self-consistency, not
  provenance; the signature coverage that closes that gap is part of #171's
  scope, as the first Consequences bullet states.
- **SCOPE BOUNDARY (stated explicitly rather than left to be discovered):
  `<userData>/models` is OUTSIDE the integrity gate.** The gate verifies only
  what `resources/manifest.json` lists, resolved under the manifest roots
  (`verifyManifest(manifest, roots)`); the first-run wizard's
  `<userData>/models` compatibility surface is a separate, wizard-only
  staging area and is not covered by that gate. This is deliberate and it is
  the property that makes the two-artifact split necessary in the first place
  — content placed there is outside the startup corruption anchor — but it
  also means a user who populates `<userData>/models` gets no
  startup verification for it.
