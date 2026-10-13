# ADR-0013: Real-weights distribution is a two-artifact bundle (Setup.exe + models sidecar)

- **Status:** Accepted (2026-10-13, owner decision recorded on issue #131;
  build-out deferred to issue #171)
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

### Option C — revisit the model/budget decision (rejected)

Reopen ADR-0002 / the ≤7 GB budget to squeeze the payload below the NSIS cap.
Rejected: the budget holds post-#156 (measured 6.38 GB ≤ 7 GiB in
`bench/RESULTS.md`), so size is not the failing dimension — the cap is about
single-file embedding, not total footprint — and a model revisit would undo
the measured #156 lineup for an installer-format reason.

## Consequences

- The distribution decision is recorded; the build-out is issue #171
  (electron-builder split targets, sidecar staging pipeline, install-time
  staging UX, and how sidecar entries ride the E5 signed update feed from
  ADR-0010 with their own manifest + signature coverage).
- Until #171 lands, the portable `win-unpacked` .7z + .sha256 + README
  bundle remains the shipping form for real weights; the fixture-mode
  Setup.exe remains CI-only and must never be mistaken for a real-weights
  installer (loud in the manifest note and artifact name).
- The startup integrity gate stays the single trust anchor for BOTH
  artifacts: whatever is staged is verified against `resources/manifest.json`
  at every launch, so a missing or corrupted sidecar fails closed with named
  files rather than crashing.
