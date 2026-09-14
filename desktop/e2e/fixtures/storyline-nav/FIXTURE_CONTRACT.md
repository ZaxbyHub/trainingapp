# Fixture contract: `storyline-nav` — runnable trimmed OpMed Storyline publish (issue #81, D5)

This document is the FROZEN SPEC for the committed e2e fixture the implementer must build.
The acceptance checks C2 (`@ac2`) and C3 (`@ac3`) in `desktop/e2e/training-player.spec.ts`
run against exactly this layout; the drivers refuse to run without it.

## 1. Source publish (local, external to the repo)

Build the fixture by TRIMMING a copy of the real publish at:

```
E:\ClaudeCode\OpMed CDP MicroLearning Companion_7-10-26
```

(Storyline 360 3.114.36620.0, published 2026-07-10, courseid `5fox24EQH9w`, `lmsPresent:false`
— the same publish the A8 probe characterized; see trace evidence `a8-recipe-probe.json`.)

CI cannot use the external publish; that is why this trimmed copy is committed.

## 2. Target layout (committed, repo-relative)

Everything below lives under `desktop/e2e/fixtures/storyline-nav/`. The directory contents
are the PLAYER ROOT: the e2e spec stages them to
`<temp packs root>/opmed-cdp-mlc/assets/player/` (pack layout per
`packtool/build/pack-json.ts`: `PLAYER_ASSETS_PREFIX = 'assets/player'`), so the app serves
them at `app://training/opmed-cdp-mlc/<rest>`.

The frozen packId is **`opmed-cdp-mlc`** (matches `PACK_ID_PATTERN`
`^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$`).

Required files (copy from the source publish unless noted):

```
desktop/e2e/fixtures/storyline-nav/
  story.html                                  # copied, PLUS the one bridge <script> tag (§5)
  story_content/
    user.js                                   # copied verbatim
    trainingapp-bridge.js                     # COMMITTED VERBATIM from this directory (§4) — already staged
  html5/
    data/
      css/output.min.css
      js/data.js                              # keep whole (see §6 trimming note)
      js/frame.js
      js/paths.js
      js/<slideId>.js                         # per-slide JS for exactly the 12 manifest slides (§3)
    lib/
      img/                                    # player chrome images, copied as-is
      scripts/bootstrapper.min.js
      scripts/frame.desktop.min.js
      scripts/frame.mobile.min.js
      scripts/slides.min.js
      stylesheets/                            # player chrome css, copied as-is
  FIXTURE_CONTRACT.md                         # this file
```

Optional (may be omitted): `meta.xml`, `mobile/`, `analytics-frame.html`,
`html5/data/js/<other-slide>.js`, slide media under `html5/data/` for other slides.

Do NOT copy: `html5/lib/scripts/frame.mobile.min.js` may be dropped only if boot still
succeeds; when in doubt keep it.

## 3. Frozen 12-slide manifest (3 sections x 4 slides)

Verified against the real publish `html5/data/js/frame.js` navigation tree
(`navData.outline`; scene ids shown; bare slide ids are the jump targets — the compound
`_player.<sceneId>.<slideId>` form is NOT):

| # | section | scene id | slide id | slide title |
|---|---------|----------|----------|-------------|
| 1 | Launch Menu | `_player.6Mxw9SBMlYW` | `5rN4PvXJM5d` | Welcome |
| 2 | Launch Menu | `_player.6Mxw9SBMlYW` | `6RdggQhakWc` | Roles Menu |
| 3 | Launch Menu | `_player.6Mxw9SBMlYW` | `5WPdDfMu1kK` | Patient Information Disclaimer |
| 4 | Launch Menu | `_player.6Mxw9SBMlYW` | `6mEtFwFWVpq` | Main Menu |
| 5 | The CDS Library: What you need to know in Ambulatory | `_player.6eI53oV9Txs` | `6o652ZiseLC` | Select Ambulatory |
| 6 | The CDS Library: What you need to know in Ambulatory | `_player.6eI53oV9Txs` | `6mZvfaT2voE` | Select Chief Complaint/HPI |
| 7 | The CDS Library: What you need to know in Ambulatory | `_player.6eI53oV9Txs` | `5aekClXIESa` | Select Chief Complaint |
| 8 | The CDS Library: What you need to know in Ambulatory | `_player.6eI53oV9Txs` | `6ZYUMez1qPq` | Select Confusion |
| 9 | Registering a Patient with a CAC | `_player.5oENLbNfcDC` | `6cdRMINdr9M` | Select New Encounter |
| 10 | Registering a Patient with a CAC | `_player.5oENLbNfcDC` | `5WB9cNnxOlq` | Registering a Patient with a CAC Video |
| 11 | Registering a Patient with a CAC | `_player.5oENLbNfcDC` | `6e9cgBrg3Fe` | Select New Patient |
| 12 | Registering a Patient with a CAC | `_player.5oENLbNfcDC` | `6DFIkaCmtTO` | Select Sex |

Notes:
- Slide 8 `6ZYUMez1qPq` (Select Confusion) is the VERIFIED 4th leaf of the CDS Library
  section in `frame.js` (the candidate id `6Gv9HNv8MT8a` mentioned during check authoring
  does not exist in this publish — checked, zero occurrences in frame.js).
- Slide 12 `6DFIkaCmtTO` (Select Sex) is the VERIFIED 4th leaf of Registering a Patient
  with a CAC.
- Slides 1-10 (the first ten rows) are the frozen AC2 jump targets: 10 distinct ids
  spanning exactly 3 scenes/sections.
- The first 9 of the 10 verified jumps in the A8 probe (220-314 ms each) used this same
  sequence; slide 8 replaces the probe's 10th (which was `6cdRMINdr9M`, row 9 here).

## 4. The pack-local bridge (`story_content/trainingapp-bridge.js`)

Rationale: the `GetPlayer` facade exposes NO jump method (verified: keys are
GetVar/SetVar/object/... only), and `GetVar('projectSlideNumber'|'projectSlideTitle')`
returns null in this publish (system playervars unregistered). The proven jump mechanism is
the A8 recipe on the internal `DS` runtime, which only pack-local script can reach. The
bridge is PACK CONTENT, not renderer code: it ships inside the fixture (and, later, inside
real packs built by packtool).

The file `story_content/trainingapp-bridge.js` is committed with this contract and MUST be
kept byte-identical to the version staged beside it. It provides, inside the player
document:

- `window.__trainingappJump(slideId): Promise<boolean>` — waits for player readiness
  (`DS.windowManager.getCurrentWindowSlide()` non-null; jumps before course start throw in
  the raw runtime), then `DS.presentation.getFlatSlides().find(s => s.id === slideId)` +
  `await DS.windowManager.requestSlideForReview(slide, '_frame')`, resolves `true` iff the
  player's own state then reports the target id, `false` for unknown ids / not-ready /
  readback mismatch. Never rejects.
- `window.__trainingappState(): Promise<{slideId, slideTitle} | null>` — live read via
  `getCurrentWindowSlide()` -> `{id, attributes.title}`; `null` before course start.
- a `postMessage` RPC listener (protocol in §5) so the renderer-side
  `web_ui/src/components/training-player-bridge.ts` can drive the same operations without
  same-origin window access (`app://index.html` and `app://training/...` are distinct
  WHATWG hosts under the standard `app://` scheme).

## 5. The one permitted story.html edit + the postMessage protocol

`story.html` gets exactly ONE appended tag, immediately before `</body>`:

```html
<script src="story_content/trainingapp-bridge.js"></script>
```

No other story.html modification is permitted (the file's inline bootstrap script is why
the training CSP profile needs `'unsafe-inline'` in `script-src` for pack documents).

Frozen postMessage protocol (bridge listens on `window` 'message'; replies are posted to
`event.source` with the same `__trainingapp: true` marker):

```
renderer -> frame:  { __trainingapp: true, kind: 'jump',  reqId: number, slideId: string }
frame -> renderer:  { __trainingapp: true, kind: 'jump-result',  reqId: number, ok: boolean }
renderer -> frame:  { __trainingapp: true, kind: 'state', reqId: number }
frame -> renderer:  { __trainingapp: true, kind: 'state-result', reqId: number,
                      state: { slideId: string, slideTitle: string } | null }
```

## 6. Trimming procedure + tolerated noise

1. Copy the whole source publish into `desktop/e2e/fixtures/storyline-nav/`.
2. Delete `html5/data/js/<slideId>.js` for every slide id NOT in the 12-slide manifest.
3. Keep `data.js`, `frame.js`, `paths.js`, `output.min.css`, `story.html`,
   `story_content/user.js`, `html5/lib/**` whole.
4. Add the bridge script tag to `story.html` (§5); commit `story_content/trainingapp-bridge.js`.
5. Delete `mobile/`, `meta.xml`, `analytics-frame.html` (optional).

The player lazy-loads per-slide JS, so the trimmed publish still boots (cover = Welcome,
slide 1) and every manifest jump resolves. Media referenced by kept slides but not copied
produce resource 404s — TOLERATED by the checks (the AC1 console gate filters COOP/COEP
errors only; favicon 404s and slide-media 404s are ignored). If the fixture stays under
~10 MB committed size, no further trimming is required.

## 7. Proven runtime facts this fixture relies on (A8 probe)

- Player boots under COOP same-origin / COEP require-corp / CORP same-origin with zero
  COOP/COEP console errors (favicon 404 only) — same header posture the app:// handler
  attaches to every response.
- Cover slide = Welcome with a Start button (`acc-button`, `aria-label="Start"`); after a
  reload with persisted position the player shows a Resume/Restart prompt instead.
- Jumps before course start throw (`windowManager` has no window); deferred jumps (poll
  `getCurrentWindowSlide()` until non-null) work after Start AND after Resume/Restart.
- Section nodes themselves are NOT jump targets (only leaf slide ids resolve in
  `getFlatSlides()`); `getFlatSlides()` = 386 entries (384 content + 2 internal prompts).
