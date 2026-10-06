# Lumen visual and a11y harness (runbook)

Specs in this folder run through `playwright.visual.config.ts` (opt-in; the
default `npm run test:e2e` config ignores this folder). Design context:
`docs/design/design-language.md` section 6.

| Spec | What it checks | Runs in CI |
| --- | --- | --- |
| `lumen-axe.spec.ts` | axe-core serious/critical nodes per surface, theme, width: zero allowed on every key, no baseline (fonts and two animation frames settle before each scan); plus the populated Training surfaces with a fixture course installed through the Packs panel (Documents > Training packs tab, Training library, player page host chrome with the course iframe excluded), which allow zero nodes and no baseline | yes |
| `lumen-axe-settings-full.spec.ts` | axe-core on the WHOLE Settings page (viewport grown to the content; no baseline), default and External-model-configured states, light/dark at 1440 / 1024 / 500 | yes |
| `lumen-tooltip-overflow.spec.ts` | tooltip stays inside a 500px viewport | yes |
| `lumen-doc-row-reflow.spec.ts` | document rows reflow (container query on the table), never clip Delete/Cancel/Confirm, at 320-1440px with the 64px rail or 260px sidebar; dates in several locales (en-US, de-DE, fi-FI and a worst-case string) never overflow the row; sidebar, drawer and spacing geometry is read from source, so a CSS change cannot silently drift the test | yes |
| `lumen-doc-list-scroll.spec.ts` | the real DocumentList (80 docs): keeps the same row at the top and focus on its control across the 800px stack/wide switch; inline row height equals rendered height on both sides of the boundary; delete-confirm hands focus to the neighbouring row (never `<body>`) and keeps it inside the scroll region, including two quick deletes; a focus-pinned row stays pinned only while it holds focus; adding a document does not scroll the user away; bottom-up quick deletes (first delete held in IndexedDB) never focus a row whose own delete is in flight; header Upload keeps focus around the file chooser | yes |
| `lumen-baseline.spec.ts` | `toHaveScreenshot` pixel baselines | non-required Windows job (`web-ui-visual-baseline`), never in the ubuntu job |

CI runs only the a11y subset (`npm run test:visual:a11y:ci`: every spec above
marked "yes", reusing the `web-ui-e2e` job's `dist/`; Chromium only, like every pixel and axe baseline here: the screenshots are
engine-specific, so they are never taken in Firefox. Firefox is covered by the browser e2e suite (`playwright.config.ts`,
`npm run test:e2e`, run under both Chromium and Firefox in the required `web-ui e2e` job). Locally,
`npm run test:visual:a11y` builds first and runs the same specs; `npm run test:visual` runs everything including pixels.

## Who re-baselines, and when

The author of each phase 3-8 PR re-baselines. Do it in any PR that changes
pixels, and in any PR that bumps the `@playwright/test` / Chromium lockfile
entries (the lockfile, not an exact pin in `package.json`, fixes the Chromium
build; the repo uses caret ranges, so do not exact-pin).

## Screenshot baselines (Windows only)

Baselines are rendered by Windows Chromium and stored under
`e2e/visual/__screenshots__/win32/` (88 PNGs: chat, documents and settings 16 each, training 8, overlays 8, crash page 8, boot screen 16 (loading and error)). The crash and boot-screen states cover surfaces outside the app shell (the outer ErrorBoundary fallback and the desktop boot gate, where only `<body>` paints); the crash is forced by making the web-storage read of the sidebar-open key throw in the test page, the failure a browser with storage blocked produces, which AppLayout's unguarded `useSidebarState` read turns into an AppContent crash (no production hook) and the boot gate by stubbing `window.desktopApi`. The training player's course `<iframe>` frame is deliberately NOT baselined: its rounded-corner rasterization differs by 1/255 on a few pixels between runs of the same build (light theme), which zero tolerance cannot absorb. Ubuntu CI never runs the pixel spec;
the non-required `web-ui-visual-baseline` job (`windows-latest`) runs it WITHOUT `--update-snapshots` on a clean build with no staged weights, and
may be red if the runner's fonts differ from the generating machine (no tolerance is added). Outside CI,
running it on Linux or macOS (only `win32/` baselines exist) does not diff: the
config sets no `updateSnapshots`, so Playwright's default `missing` mode FAILS with
missing-snapshot errors and WRITES new PNGs under `e2e/visual/__screenshots__/<platform>/`.
Delete those generated folders and never commit them. Regenerate on Windows only:

1. Remove any `web_ui/.env.production` (written by `prepare-models`; it changes
   the model-blocked overlay pixels).
   The overlay baselines embed hardware-derived text (the model-gate readiness copy reads `navigator.deviceMemory` and
   WebGPU presence), so `lumen-baseline.spec.ts` pins the hardware instead of depending on the regenerating box:
   `stubHardware()` reports `navigator.deviceMemory` = 8 and a WebGPU API with no adapter (`requestAdapter()` resolves
   `null`), which is what the committed `overlay-model-not-ready-*.png` baselines show. A regeneration on a 4 GB or
   WebGPU-capable machine renders the same text; an overlay diff is therefore a real change, not a machine difference.
   The model-gate opt-out `LUMEN_ALLOW_NO_OVERLAY=1` (a local build with staged weights, no gate) is refused when `CI`
   is set: the spec fails to load rather than silently skipping a gate regression.
2. `npm run build` from a clean state.
3. `npx playwright test --config playwright.visual.config.ts --update-snapshots`
4. Review every changed PNG and include before/after images of the changed
   PNGs in the PR description. Unreviewed bulk snapshot updates are not accepted.

## Axe baseline regeneration

There is no axe baseline. `lumen-axe.spec.ts` allows zero serious/critical nodes on every
`surface:theme:width` key; `KNOWN_BASELINE` is intentionally empty and the spec fails any key
that has an entry, so a violation cannot be baselined, only fixed.

To diagnose a failure:

1. `npm run build`
2. `LUMEN_AXE_INVENTORY=1 npx playwright test --config playwright.visual.config.ts lumen-axe`
   (on Windows Git Bash the inline variable works; in PowerShell set `$env:LUMEN_AXE_INVENTORY=1` first).
   Each `AXE <key> [...]` console line lists that key's nodes (rule id plus a positional `nth-child` selector).
3. Fix the violation, then re-run without the variable and confirm green.

## The model gate during scans and captures

Surfaces other than `overlay` and `drawer` are scanned or captured with the model gate hidden. `hideModelGate`
(`e2e/model-gate.ts`) hides every gate backdrop and removes the chat content's `inert`, for the rest of that page
(it is not restored; the page is discarded with the test), and re-checks that post-condition before each scan.
The gated state itself (gate up, content inert) is covered by the `overlay` axe pass, the `overlay-model-not-ready`
baselines and `e2e/model-gate-keyboard.spec.ts` (the in-chat gate, in the browser build).

The desktop model gate is covered by unit tests (`DesktopModelBlockedOverlay.test.tsx`,
`App.firstRunModelGate.test.tsx`, `ChatPage.overlay.test.tsx`) and by an Electron e2e,
`desktop/e2e/desktop-model-gate.spec.ts`. Every other desktop e2e spec runs the stub engine, which the gate never
covers, so this spec boots the real engine resolution against an EMPTY model directory (no weights are loaded). It
asserts the gate's role, name and actions, that the covered chat content is `inert` under Tab and Shift+Tab (including
a full cycle that wraps), that Open Settings and "Use a local server or cloud model" navigate to Settings, and that only
the desktop gate renders when "In this window" is selected. It runs in the non-required `renderer-e2e` job of
`desktop-build.yml` (`npm --prefix desktop run test:e2e`). The other desktop e2e specs cover the first-run wizard
(`first-run-wizard.spec.ts`), packs, the training player and settings layout.
