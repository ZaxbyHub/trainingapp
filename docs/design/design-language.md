# TrainingApp Design Language — "Lumen" (v1.2, approved)

Status: APPROVED by the product owner (2026-10-01; accent: Iris). Rolled out in phases (section 6); phases 0-2 add tokens, primitives and baselines with zero visual change to existing screens.
Scope: every surface of the web_ui renderer, which is shared verbatim by the browser app and the Electron desktop app (parity by construction: one component library, one token set).
Revision: v1.2 adjusts token values so every listed pair passes the computed WCAG contrast test (see web_ui/src/styles/lumen-tokens.contrast.test.ts); v1.1 incorporated an independent critic review (verdict NEEDS_REVISION, no blockers): corrected findings, AA-verified token values, non-text contrast, forced-colors, breakpoints, missing states, and a migration plan that no longer claims zero visual change.

## 1. What the visual review found

Evidence: live review of the Vite dev build (dark + light, 1440×900) on 2026-09-30 in the in-app browser, plus a code inventory of `web_ui/src` independently re-verified by the critic.

| # | Finding | Evidence |
|---|---|---|
| V1 | Two competing palettes: navy page (`#1a1a2e`) with neutral-grey cards (`#2d2d2d`) in dark mode. | `tokens.css:92-93` |
| V2 | Chat-bubble tokens are used as app surfaces (`--color-bubble-assistant` is the page background, `--color-bubble-system` is every card). | `theme.css:38`; `SettingsPage.tsx:480,559,592`; `DocumentsPage.tsx:809,821,844` |
| V3 | No component library: 67 raw `<button>`s across 24 files, each styled inline; ~23 style constants in SettingsPage alone; three near-identical radio-card groups. | style inventory |
| V4 | No branded or consistent hover/focus treatment: inline styles cannot express `:hover`/`:focus-visible`, so hover exists on only ~10 elements (JS `onMouseEnter`) and focus falls back to the browser default ring. (Earlier draft wrongly claimed missing focus rings; the cited `outline: none` sites are programmatic-focus targets or have replacements.) | `onMouseEnter` count; `SidebarConversationItem.tsx:182-188` |
| V5 | Undefined tokens referenced with literal fallbacks: `--color-border` ×10, `--color-text` ×8, `--color-accent` ×5, plus `--color-bg-surface`, `--color-bg-primary`, `--color-text-on-warning`. Fallbacks are biased both ways: the first-run wizard renders dark-ish in light mode; the desktop model-blocked card renders white in dark mode. | `FirstRunWizard.tsx:49,51`; `DesktopModelBlockedOverlay.tsx:68` |
| V6 | Inconsistent page chrome: Settings has a header, Documents has none, Training is a single unstyled line in the corner. | screenshots |
| V7 | Settings mixes two section styles, is one long scroll with no section navigation, and shows controls that cannot act in the current mode. | screenshots; trace settings-wiring-honesty AC7 |
| V8 | Composer is a saturated blue slab; Send/Stop float detached below it; "Generating…" floats orphaned on the left. | chat screenshot |
| V9 | Selected conversation and active nav item share the same saturated fill; the sidebar has no product identity ("Menu", `Sidebar.tsx:188`); primary nav sits at the bottom. | screenshots |
| V10 | Naming drift: tab title "Document Q&A Assistant", About "Document Q&A 1.0.0", product "TrainingApp 0.1.0"; favicon/theme-color hard-coded `#1a73e8`. | `index.html:10,12`; `SettingsPage.tsx:466,1867` |
| V11 | Contradictory copy on one page (wllama "Recommended for most hardware" vs "Recommended for this device: WebLLM"). | `SettingsPage.tsx:1513` vs `:1525` |
| V12 | No icon system (hand-inlined SVGs in 7 files), no motion tokens, no border token, radius drift (4/6/8/12 px literals), no monospace font. | style inventory |

## 2. Principles

1. **Calm focus.** Content first; chrome recedes. One accent color, used for the single most important action on screen.
2. **One surface system.** Every screen is built from the same surface levels and the same components.
3. **Honest state.** Every control shows what the system is really doing (model, provider, grounding, sync). Controls that cannot act are hidden with a one-line reason.
4. **Parity by construction.** Browser and desktop render the same components; platform differences live in data, not in forked UI.
5. **Accessible by default.** WCAG 2.2 AA: 4.5:1 for all text tokens on every surface they are used on, 3:1 for UI boundaries and state indicators (1.4.11), a visible outline-based focus ring on every interactive element, pointer targets ≥ 24×24 CSS px (2.5.8) with 40px for primary actions, Windows forced-colors support, reflow to 320 CSS px, reduced motion respected. A token contrast test enforces the numbers.

## 3. Foundations (tokens)

Layered: **primitives** → **semantic** (the only layer components use). All values below are AA-verified by the critic's contrast script (WCAG 2.x relative luminance; rgba blended over the intended surface).

### 3.1 Color — primitives
- Slate (cool neutral): `0 #ffffff`, `50 #f7f8fa`, `100 #eef0f4`, `150 #e6e9ef`, `200 #dfe3ea`, `300 #c5ccd8`, `400 #9ea8b7`, `450 #7c8698`, `500 #6b7588`, `550 #5a6578`, `600 #4d566a`, `700 #353c4d`, `800 #232837`, `850 #1c2030`, `900 #171a25`, `950 #0f111a`.
- Iris (accent): `50 #eef2ff`, `100 #dde5ff`, `300 #9db0ff`, `400 #7a8fff`, `500 #5b6cff`, `600 #4a55f0`, `700 #3b41c9`.
- Status (light fg / dark fg): success `#157e3c / #4ade80`, warning `#9c5f07 / #fbbf24`, danger `#b91c1c / #f87373`, info `#0369a1 / #38bdf8`. (v1.2: success/warning light and danger dark were nudged by the minimum needed to pass the computed WCAG contrast test on every surface they are used on; see `web_ui/src/styles/lumen-tokens.contrast.test.ts`.)

### 3.2 Color — semantic (light / dark)
| Token | Light | Dark | Use / contrast note |
|---|---|---|---|
| `--bg-canvas` | slate-50 | slate-950 | app background |
| `--bg-surface` | slate-0 | slate-900 | cards, panels, sidebar |
| `--bg-raised` | slate-0 + shadow | slate-800 | popovers, composer, dialogs |
| `--bg-sunken` | slate-100 | #0b0d14 | inputs, code blocks, wells |
| `--bg-hover` | slate-150 | slate-850 | hover on canvas/surface (distinct from sunken and raised) |
| `--bg-hover-raised` | slate-100 | slate-700 | hover inside raised surfaces (menus, dialogs, composer) |
| `--bg-selected` | iris-50 | rgba(91,108,255,.16) | selected item — ALWAYS paired with a non-color cue (3px accent indicator or weight 600) |
| `--border-subtle` | slate-200 | rgba(255,255,255,.07) | decorative dividers only (not a state boundary) |
| `--border-control` | slate-450 #7c8698 | #6b7588 | input/checkbox/switch/radio-card boundaries: ≥3:1 on surface and sunken |
| `--text-primary` | slate-900 | slate-50 | body |
| `--text-secondary` | slate-600 | slate-300 | descriptions |
| `--text-tertiary` | slate-550 #5a6578 | slate-400 | captions, timestamps, help (≥5.1:1 on canvas, sunken, selected) |
| `--text-placeholder` | slate-550 | slate-400 | input placeholders (AA, not the browser default grey) |
| `--text-disabled` | slate-400 | slate-600 | disabled labels (exempt from 1.4.3; paired with `aria-disabled`) |
| `--accent` | iris-600 | iris-400 | primary action, links, focus |
| `--accent-hover` | iris-700 | iris-300 | |
| `--accent-fg` | #ffffff | slate-950 | text on accent (5.46 / 6.46) |
| `--focus-ring` | iris-600 | iris-400 | `outline: 2px solid; outline-offset: 2px` — outline, never box-shadow |
| `--{success,warning,danger,info}` | per 3.1 | per 3.1 | status text/icon on surface |
| `--{status}-subtle` | success `#dcfce7`, warning `#fef3c7`, danger `#fee2e2`, info `#e0f2fe` | 12% alpha of the dark fg over surface | badge/banner fills (status text on them ≥4.5:1) |
| `--{status}-border` | success/warning fg @ 75%, danger @ 60%, info @ 70% | danger @ 60%, info @ 55%, others @ 45% | banner edges (≥3:1 as a boundary, computed) |
| `--{status}-fg-on-fill` | #ffffff | slate-950 | text on solid status fills (dark: 6.8–11.3:1) |
| `--bubble-user` | iris-50 | rgba(91,108,255,.14) | user message tint |

Dark mode communicates elevation by surface lightening plus borders, not shadows.

### 3.3 Typography
Inter (already bundled via `@fontsource/inter` 400–700, airgap-safe). Monospace: a system stack `"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace` as `--font-mono` (no new dependency; an optional bundled `@fontsource/jetbrains-mono` is a separate decision). Type tokens use the `--type-*` prefix so they cannot be confused with text colors.
| Token | Size/line | Weight | Use |
|---|---|---|---|
| `--type-display` | 30/36 | 600 | empty-state hero |
| `--type-title` | 22/28 | 600 | page title |
| `--type-heading` | 17/24 | 600 | section heading |
| `--type-body` | 15/24 | 400 | body, chat |
| `--type-label` | 14/20 | 500 | control labels, buttons |
| `--type-caption` | 13/18 | 400 | help text, metadata |
| `--type-micro` | 12/16 | 500 | badges, kbd |

### 3.4 Space, radius, elevation, motion, layout
- Space: `--space-1 4` `2 8` `3 12` `4 16` `5 20` `6 24` `8 32` `10 40` `12 48` `16 64`.
- Radius: new names avoid collision with today's `--radius-*`: `--r-control 6`, `--r-card 10`, `--r-overlay 14`, `--r-pill 999px`.
- Elevation (light only): `--shadow-1` 0 1px 2px rgba(16,24,40,.06); `--shadow-2` 0 4px 12px rgba(16,24,40,.08); `--shadow-3` 0 12px 32px rgba(16,24,40,.12).
- Motion: `--dur-fast 120ms`, `--dur-base 200ms`, `--dur-slow 320ms`; `--ease-standard cubic-bezier(.2,0,0,1)`; disabled under `prefers-reduced-motion`.
- Widths: `--w-reading 760px`, `--w-form 880px`, `--w-wide 1200px`.

### 3.5 Breakpoints and reflow
| Width | Shell | Settings | Chat | Documents / Training |
|---|---|---|---|---|
| > 1024 | sidebar 260px, collapsible to 64 | section nav + form | reading column | table / grid (3–4 cols) |
| 769–1024 | sidebar collapsed to 64 by default (matches `useSidebarState.ts:14`) | section nav collapses into a top `Tabs` row | reading column fills | grid 2–3 cols |
| 501–768 | sidebar becomes an overlay drawer | single column, section select | full width, 16px gutter | table → list rows; grid 2 cols |
| ≤ 500 ("EHR side-panel / split-screen", `theme.css:68-74`) | drawer; header actions wrap | single column | composer controls wrap; citations collapse into a count chip | list rows; grid 1 col |
Must reflow without horizontal scroll at 320 CSS px (200%/400% zoom).

### 3.6 States
Every interactive primitive defines: rest, hover, active, focus-visible (outline), selected/checked (color + non-color cue), disabled (`aria-disabled`, `--text-disabled`, no hover), loading (spinner + `aria-busy`), error (`--danger` text + `aria-invalid` + `aria-describedby` message), empty (EmptyState).

### 3.7 Forced colors (Windows High Contrast)
`@media (forced-colors: active)`: focus uses `outline` (survives), selected items add a `2px solid Highlight` border/indicator, SegmentedControl "on" state gets `outline: 2px solid Highlight`, icons use `currentColor`, no information carried by background tint alone.

## 4. Components (one library: `web_ui/src/ui/`)

Plain CSS per component with namespaced classes (`ui-button`, …) so pseudo-classes and media queries work. CSP-compatible: Vite extracts CSS to `dist/assets/*.css` (`style-src 'self' app:` allows it); inline React styles are applied via CSSOM and are not governed by `style-src`. Guardrail: no CSS-in-JS runtimes, `cssText`, `insertRule`, or `innerHTML`-injected `style=""`. Icons: an in-repo `Icon` component with a curated, vendored Lucide-compatible (ISC; portions from Feather, MIT) SVG path set — no runtime dependency, airgap-safe, `currentColor` fill/stroke.

| Component | ARIA contract (kept stable so existing role/label tests survive) |
|---|---|
| `Button` (primary · secondary · ghost · danger; md 40px, sm 32px with 24px min hit area) | native `<button>`; loading sets `aria-busy`; danger uses `--danger` fill + `--danger-fg-on-fill` |
| `IconButton` | native button, required `aria-label`, tooltip |
| `Card` / `Section` | `Section` renders `<section aria-labelledby>` + heading |
| `Field` | `<label for>`, help via `aria-describedby`, error via `aria-invalid` + message |
| `TextInput`, `PasswordInput` (reveal toggle), `Select`, `Combobox` (model picker) | native inputs; Combobox follows the ARIA 1.2 combobox pattern |
| `Switch`, `Checkbox` | native `<input type=checkbox>` (`role="switch"` for Switch) |
| `SegmentedControl`, `RadioCardGroup` | `<fieldset>`/`<legend>` + native `<input type=radio>` — keeps `getByRole('radio', …)` working |
| `Badge` / `StatusPill` | text always present (no color-only status) |
| `Banner` | `role="status"` or `role="alert"` by severity |
| `Dialog` | native `<dialog>` or `role="dialog"` + `aria-modal`, focus trap, return focus |
| `Toast`, `Tabs`, `Tooltip`, `EmptyState`, `Skeleton`, `ProgressBar`, `KeyValueList`, `Kbd`, `PageHeader`, `AppShell` | standard WAI-ARIA patterns |

## 5. Surface patterns

### App shell & navigation
Sidebar: product mark + "TrainingApp" at top, primary nav (Chat, Documents, Training, Settings) at the TOP, then "Conversations" (search, New chat), then a footer connection chip ("Local · Gemma 4 E2B", "OpenAI · gpt-4.1", "LM Studio · 192.168.1.20") that deep-links to Settings → Model & connection. Active nav = `--bg-selected` + accent text + 3px accent indicator; selected conversation = `--bg-selected` + weight 600 (hover remains `--bg-hover`, visually distinct).

### Chat
Centered `--w-reading` column; assistant messages on the canvas, user messages as right-aligned tinted bubbles; numbered citation chips; grounding badge ("From your documents" / "General knowledge"). Composer: one raised card (`--r-overlay`, `--shadow-2`) with textarea, attach, and an integrated Send/Stop icon button inside the card; status row inside the card.

### Documents
`PageHeader` ("Documents", counts, "Upload"); dashed sunken dropzone; table (type icon, name, size, chunks, status pill, row actions); "Documents | Training packs" tabs — identical in browser and desktop.

### Training
Course library grid (cover, title, slide count, progress, version badge); player page with a slim header (back, title, slide x of n, pin-slide) and the player filling the remaining height.

### Settings
Section nav (Model & connection · Answers · Appearance · Storage & privacy · Updates · About) + `--w-form` content, one `Section` style. Model & connection: generator source (Built-in model / Local or network server / Cloud provider), protocol (OpenAI-compatible / Anthropic-compatible), Base URL, API key (`PasswordInput` with a per-platform storage note), model `Combobox` from the endpoint, "Test connection" with a cause-specific `Banner`, "Use my documents (grounded)" switch on by default. Non-applicable controls collapse to a single muted explanation line.

### Overlays & first-run
All blocking states use `Dialog` + `Banner`; the missing-model state offers "Use a local server or cloud model" as a first-class action.

## 6. Implementation plan (phased; each phase ships independently)

0. **Baseline** — Playwright `toHaveScreenshot` baselines of every surface in light + dark at 1440, 1024, 768, 500 widths (today there are none), plus an axe pass (`@axe-core/playwright`, MPL-2.0, devDependency only), so every later phase shows its visual diff explicitly.
1. **Foundations (additive)** — add primitive + semantic tokens NEXT TO the existing `--color-*`/`--radius-*` tokens (old values untouched, no consumers changed ⇒ zero visual change is actually true here); global base styles scoped to new classes only; a token contrast test covering text pairs (4.5:1) AND UI/state pairs (3:1) in both themes, plus forced-colors rules.
2. **Primitives** — `web_ui/src/ui/*` with role/label unit tests and a dev-only gallery route.
3. **Shell & navigation** — AppShell, sidebar rework, PageHeader everywhere, one product name, favicon/theme-color.
4. **Settings** — rebuilt on primitives together with traces T1 (external model endpoints) and T2 (settings wiring/honesty).
5. **Chat** — composer, messages, header, model chip.
6. **Documents & Training** — together with trace T3 (browser training parity).
7. **Overlays, wizard, toasts** — remove undefined-token fallbacks.
8. **Retire old tokens** — an explicit pairwise remap table (every fill token with its foreground, e.g. `--color-primary` + `--color-text-on-primary` → `--accent` + `--accent-fg`; `--color-danger` + white → `--danger` + `--danger-fg-on-fill`; `--color-primary-rgb` consumers rewritten, since an RGB triple cannot alias a hex token), covered by the contrast test; then delete old tokens. Guardrails: lint ratchet on hex/rgb literals in `.tsx`, on `outline: none` without replacement, and on color/spacing inline styles in migrated files.

Test budget: existing tests that assert inline style strings (`ToastProvider.test.tsx:117,129`, `LoadingSkeleton.test.tsx:61-109`, `SidebarConversationItem.test.tsx:78-79`, `ChatInput.test.tsx:270`, `SettingsMetrics.test.tsx:61`) are rewritten to role/state assertions in the phase that migrates their component; label changes (e.g. "Browser-local", "API Server") update `SettingsPage.test.tsx` queries in phase 4. New acceptance checks in traces T1–T3 assert roles and labels only.

## 7. Open decision for the user
- **Accent hue.** Iris (#4a55f0 / #7a8fff) is in common indigo territory; the alternative is keeping today's Google-style blue (#1a73e8 family) re-tuned for AA. Both pass contrast; this is a brand choice.
