# Lumen visual and a11y harness (runbook)

Specs in this folder run through `playwright.visual.config.ts` (opt-in; the
default `npm run test:e2e` config ignores this folder). Design context:
`docs/design/design-language.md` section 6.

| Spec | What it checks | Runs in CI |
| --- | --- | --- |
| `lumen-axe.spec.ts` | axe-core serious/critical nodes per surface, theme, width | yes |
| `lumen-axe-settings-full.spec.ts` | axe-core on the WHOLE Settings page (viewport grown to the content; no baseline), default and External-model-configured states, light/dark at 1440 / 1024 / 500 | yes |
| `lumen-tooltip-overflow.spec.ts` | tooltip stays inside a 500px viewport | yes |
| `lumen-doc-row-reflow.spec.ts` | document rows reflow (container query on the table), never clip Delete/Cancel/Confirm, at 320-1440px with the 64px rail or 260px sidebar | yes |
| `lumen-doc-list-scroll.spec.ts` | the real DocumentList (80 docs): keeps the same row at the top and focus on its control across the 800px stack/wide switch; inline row height equals rendered height on both sides of the boundary; delete-confirm hands focus to the neighbouring row (never `<body>`) and keeps it inside the scroll region, including two quick deletes; a focus-pinned row stays pinned only while it holds focus; adding a document does not scroll the user away | yes |
| `lumen-baseline.spec.ts` | `toHaveScreenshot` pixel baselines | no (Windows only) |

CI runs only the a11y subset (`npm run test:visual:a11y:ci`: every spec above
marked "yes", reusing the `web-ui-e2e` job's `dist/`). Locally,
`npm run test:visual:a11y` builds first and runs the same specs; `npm run test:visual` runs everything including pixels.

## Who re-baselines, and when

The author of each phase 3-8 PR re-baselines. Do it in any PR that changes
pixels, and in any PR that bumps the `@playwright/test` / Chromium lockfile
entries (the lockfile, not an exact pin in `package.json`, fixes the Chromium
build; the repo uses caret ranges, so do not exact-pin).

## Screenshot baselines (Windows only)

Baselines are rendered by Windows Chromium and stored under
`e2e/visual/__screenshots__/win32/`. Ubuntu CI never runs the pixel spec. Outside CI,
running it on Linux or macOS (only `win32/` baselines exist) does not diff: the
config sets no `updateSnapshots`, so Playwright's default `missing` mode FAILS with
missing-snapshot errors and WRITES new PNGs under `e2e/visual/__screenshots__/<platform>/`.
Delete those generated folders and never commit them. Regenerate on Windows only:

1. Remove any `web_ui/.env.production` (written by `prepare-models`; it changes
   the model-blocked overlay pixels).
2. `npm run build` from a clean state.
3. `npx playwright test --config playwright.visual.config.ts --update-snapshots`
4. Review every changed PNG and include before/after images of the changed
   PNGs in the PR description. Unreviewed bulk snapshot updates are not accepted.

## Axe baseline regeneration

`KNOWN_BASELINE` in `lumen-axe.spec.ts` lists pre-existing serious/critical
nodes per `surface:theme:width` key. New nodes fail, and so do stale entries
(fixed violations must be removed).

Caveat: entries are rule id plus a positional (`nth-child`) selector, so a different element
violating the same rule at the same selector is indistinguishable from the baselined node;
reviewers should re-inspect baseline entries whenever DOM order changes.

1. `npm run build`
2. `LUMEN_AXE_INVENTORY=1 npx playwright test --config playwright.visual.config.ts lumen-axe`
   (on Windows Git Bash the inline variable works; in PowerShell set `$env:LUMEN_AXE_INVENTORY=1` first).
3. Copy each `AXE <key> [...]` console line's array into the matching
   `KNOWN_BASELINE['<key>']` entry (delete the key when the array is empty).
4. Re-run without the variable and confirm green.
