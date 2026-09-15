# Embedded Storyline player (D5, issue #81)

How the app serves an installed Storyline training pack and drives it
programmatically. This doc extends the A8 spike evidence (issue #58): the
recipes below were proven against the live OpMed publish (Storyline 360
3.114.36620.0, published 2026-07-10) before any production code was written.

## Serving route

`app://training/<packId>/<rest>` maps to
`<packsRoot>/<packId>/assets/player/<rest>` — the player asset layout that
`packtool build-storyline` writes into every training pack
(`PLAYER_ASSETS_PREFIX`, `packtool/build/pack-json.ts`). The route lives in
`desktop/main/protocol.ts` (`resolveTrainingRequest` + `serveUnderRoot`),
dispatched before the generic renderer mapping, exactly as the "Reserved
namespaces" note in `desktop/README.md` required.

- `packsRoot` is `TRAININGAPP_DESKTOP_PACKS_DIR` if set, else
  `<userData>/packs` (`desktop/main/index.ts`, `resolvePacksRoot`). A future
  pack lifecycle (#70) extracts pack zips into that layout.
- `packId` must match `^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$`
  (mirror of `PACK_ID_PATTERN` in packtool). Everything else — percent-decode
  refusal, backslash/NUL refusal, `.`/`..` segment refusal, containment check,
  realpath re-check — is the same discipline the renderer route has used
  since B2.
- Every response keeps the B2 header posture (COOP `same-origin`, COEP
  `require-corp`, `nosniff`, `no-cache`). CORP is `cross-origin` on pack
  responses: the player frame is a different `app://` host from the renderer,
  so the frame must be cross-origin embeddable — CORP `same-origin` made
  Chromium abort the frame with `chrome-error://chromewebdata` despite a 200.
  The player runs cleanly under `require-corp` — verified live, zero
  COOP/COEP console errors.

### Training CSP profile

Pack documents get `buildTrainingCspPolicy()` (`desktop/main/security/csp.ts`)
instead of the strict renderer policy. Deltas, each proven necessary by the
live probe (boot fails or 100+ console violations without them):

| Delta | Why |
|---|---|
| `script-src` + `'unsafe-inline'` | `story.html` boots from an inline `<script>` (`window.globals` + the dynamic bootstrapper loader). No `'unsafe-eval'` needed: the probe recorded no other script violations. |
| `style-src` + `'unsafe-inline'` | The player writes inline styles constantly (72 violations in the probe run). |
| `font-src` + `data:`, `media-src 'self' app: data:` | The publish inlines fonts and narration as `data:` URIs (28 + 79 violations). |
| `connect-src` tightened to `'self' app:` | Pack content never calls the loopback backend (probe: zero such requests). |
| `frame-ancestors` omitted | On the pack document, `frame-ancestors` would govern who embeds the pack; the only embedder is our own renderer (gated by the renderer policy's `frame-src 'self' app:`). A pack-side `'none'` would forbid the app's own iframe. The renderer document keeps `frame-ancestors 'none'`. |

## Player runtime recipe (A8, proven live)

The `GetPlayer()` facade (`slides.min.js` assigns `window.GetPlayer`; this is
the hook `story_content/user.js` already used) exposes only
`GetVar`/`SetVar`/timeline primitives — **no jump method**. The working
mechanisms, reached from inside the player document:

```js
// Jump (exact call; the runtime's own internal JumpToSlide does the same
// getFlatSlides lookup + requestSlideForReview, gated by isCourseStarted):
const slide = DS.presentation.getFlatSlides().find((s) => s.id === slideId);
await DS.windowManager.requestSlideForReview(slide, '_frame');

// Current state (live; updates on every navigation, jumps included):
const s = DS.windowManager.getCurrentWindowSlide();
// -> { id, attributes: { title, ... } }
```

Demonstration: 10 distinct slide ids across 3 course sections, all jumped
programmatically and verified through the player's own state (220–314 ms per
jump). Full transcript: the #81 trace `evidence/a8-recipe-probe.json`.

### Fallback findings (each proven, not assumed)

- **`GetVar('projectSlideNumber' / 'projectSlideTitle')` does not work in
  this publish.** The variables are declared in `data.js` but never
  registered in the runtime variable map (GetVar returns `null`; console
  warns `resolver::resolvePath - Path did not resolve`). GetVar DOES resolve
  course-authored variables. The player service therefore reads slide
  id/title from `getCurrentWindowSlide()` and derives the slide number from
  the player's flat slide list — this is the documented fallback per the A8
  contract, and it is what `TrainingPlayer` implements.
- **Jumps before course start are refused** (`windowManager` has no window;
  the internal `JumpToSlide` rejects via `isCourseStarted()`). Integration
  consequence: queued jumps wait for readiness — the pack bridge polls
  `getCurrentWindowSlide()` until it reports a slide, then jumps.
- **Re-opening a player may show a Resume/Restart prompt** instead of the
  cover (`PlayerMemoryEnhancements` persists course position). Host code must
  not assume the cover's Start button exists.

## Pack-local bridge

The renderer and the player document are distinct origins, so the component
never reaches into the frame directly. Each pack ships
`story_content/trainingapp-bridge.js` (one appended `<script>` in
`story.html`), exposing:

- `window.__trainingappJump(slideId): Promise<boolean>` — the jump recipe
  above, readiness-deferred, resolving `true` only when the player's own
  state then reports the target.
- `window.__trainingappState(): Promise<{slideId, slideTitle} | null>` —
  the live state read.
- a `postMessage` RPC listener (`{ __trainingapp: true, kind: 'jump'|'state',
  reqId, ... }`) that the renderer-side
  `web_ui/src/components/training-player-bridge.ts` drives.

The committed e2e fixture `desktop/e2e/fixtures/storyline-nav/` is a trimmed
runnable copy of the real publish (12 slides across 3 sections) with this
bridge; its layout contract is `FIXTURE_CONTRACT.md` in that directory.

## Renderer component

`web_ui/src/components/TrainingPlayer.tsx` — `TrainingPlayer` accepts
`{ packId, initialSlideId?, onSlideChange? }`, renders the player iframe, and
emits `onSlideChange({slideId, slideTitle})` on slide id change only (1000 ms
poll cadence). `jumpToSlide(slideId): Promise<boolean>` is available via ref
and via the `window.__trainingappTrainingPlayer` automation seam. The
Training page (`?pack=<packId>`) mounts it from the app navigation; the Learn
panel drives it since D6 (#82).

### Learn-panel deep links (D6, #82)

The chat's Learn panel ("Open in training" buttons on each `learn[]` row)
navigates to the training page through a lifted `trainingTarget` in
`App.tsx`. `TrainingPage` accepts `initialPackId` + `pendingSlideId`; the
pending slide is passed to `TrainingPlayer` as `initialSlideId` only once a
pack resolves, so the mount-time auto-jump fires exactly once (readiness-
deferred per the pack bridge). The Node backend's `learn[]` rows carry
`pack_id`, so Electron-mode deep links open the right pack directly; on
surfaces without a pack id the page shows its no-pack prompt (open a pack
via `?pack=<packId>`) and the pending slide jumps once a pack is opened —
there is deliberately no in-app pack picker yet (pack support on non-Node
surfaces is #76).

## Native menu dependency: confirmed disabled

This publish ships with the player's own outline/menu chrome **disabled**:
every `controlLayouts` entry in `html5/data/js/frame.js` has
`outline: {enabled: false, search: false}`, including the default layout. The
outline DATA (`navData.outline.links`, 12 sections / 384 slides) is complete —
that is what the pack extractor (#77) consumed — but there is no clickable
in-player menu UI. App-level navigation (the component's `jumpToSlide` plus
the app's own UI built from the pack outline) is the only navigation surface;
no code may assume a Storyline menu button exists to click. A static check
(the C4 scan from the #81 trace) enforces this on shipped sources.

## Known runtime defect and the bridge's recovery (observed live, #81 e2e)

Under `PlayerMemoryEnhancements` (enabled in this publish), the runtime's
`componentWillUnmount` cancels every pending `htmlReady`
`requestAnimationFrame` (`htmlReadyIds.forEach(cancelAnimationFrame)` in
`slides.min.js`). On scene-entry transitions a reconcile cycle can swallow
the newly-mounted slide's readiness rAF: the slide's model loads and is
reported as current (`loadedDfd` resolved, content displayed), but its view's
`slideReady` flag stays false forever. Every subsequent review request then
queues behind a `slide.READY` event that never fires — the serialized
navigation queue deadlocks (reproduced ~50-60% of Electron runs at the CDS
scene entry; captured as `cur=<target>/false` for 150s with zero outstanding
requests).

The pack bridge carries a targeted recovery: when a jump has LANDED (the
model reports the target as current) but readiness stays false for 4s, the
bridge sets the landed model's `slideReady` back to true, restoring the
runtime's own synchronous stage-1 path (`requestSlideForReview` resolves
immediately when the current slide reports ready). With the recovery, the
10-jump sequence is deterministic (10/10 sequential runs, plus the @ac3 leg
5/5).

## Decision summary (#58 acceptance)

- iframe-vs-window: iframe embed (same-origin under the private `app:` scheme;
  no COEP-nesting fallback needed — the player boots cleanly in-frame).
- jump-method: `requestSlideForReview` via the internal DS runtime (recipe
  above) with the slideReady gate and landed-slide recovery.
- polling-interval: 1000 ms `setInterval` on the pack bridge's state read,
  emit-only-on-change.

## Provenance and licensing note

The e2e fixture (`desktop/e2e/fixtures/storyline-nav/`) embeds a trimmed copy
of the Articulate Storyline 360 publish (minified runtime, slide payloads,
narration MP3s). That content is third-party Articulate output used
internally for testing only; it is not covered by this repo's MIT license and
must not be redistributed outside the organization. Fixture deviations from
the original contract are recorded in `FIXTURE_CONTRACT.md` §8.

## Invalidations

Re-verify this recipe if the OpMed course is re-published with a newer
player (`story.html` `playerVersion` != 3.114.36620.0) or if a re-publish
enables `outline.enabled: true` (the native menu assumption would change).
