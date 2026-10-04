/**
 * lumen-baseline.spec.ts — Lumen design-language (docs/design/design-language.md)
 * phase 0 (section 6): visual-regression baselines of every top-level
 * browser-mode surface, light + dark, at widths 1440 / 1024 / 768 / 500, so
 * every later phase shows its visual diff explicitly.
 *
 * Run through playwright.visual.config.ts (opt-in; see its header).
 *
 * FULL-CONTENT coverage. The app scrolls inside <main> (AppLayout), so a
 * viewport screenshot only sees the first screenful (Settings is ~3100 px tall
 * at 1440 and ~3400 px at 500). Each capture therefore grows the viewport
 * height until no element scrolls vertically (fitViewportToContent) and takes
 * one tall PNG of the whole surface.
 *
 * States (id -> what is captured):
 *   chat-empty            Chat with no conversations
 *   chat-populated        seeded conversation: markdown, grounded badge, citation, abstain card
 *   documents-empty       Documents with no files
 *   documents-populated   seeded documents: ready x2 and an error row
 *   training-empty        Training page as the BROWSER app renders it. Populated
 *                         training (pack list, player) exists only in the desktop
 *                         app (window.desktopApi + packs backend); the browser app
 *                         shows a single "available in the desktop app" notice and
 *                         has no reachable populated state without faking the bridge.
 *   settings              Settings, every section (Model & connection, Answers, Appearance,
 *                         storage, hardware, about)
 *   settings-external     Settings with Model & connection on a server source, configured and
 *                         switched on ("Local or network server", Base URL + Model filled, "Use
 *                         external model" on). Replaces the old
 *                         settings-provider state: #142 retired the "Provider server" inference
 *                         mode (and its radio), moving those connection fields into this section.
 *                         No connection test runs (cross-origin traffic is aborted anyway).
 *   overlay-model-not-ready   the alertdialog browser builds without staged weights show
 * Seeding writes raw IndexedDB records (conversations: Dexie store
 * `docqa_conversations`; documents: `<profile>-doc-qa-documents`) and reloads;
 * no model weights are needed. A fixed clock and UTC/en-US keep dates stable.
 *
 * NOT covered (deferred, reported): FirstRunWizard and DesktopModelBlockedOverlay
 * render only when window.desktopApi exists (Electron preload), which a
 * plain-browser harness cannot provide without faking the desktop bridge.
 *
 * Determinism: theme is forced via the persisted `theme-preference` key (and
 * emulated colorScheme); animations are disabled by the config and reduced
 * motion is requested; fonts are awaited; all cross-origin traffic is
 * aborted; hardware/quota-derived text is masked (the Hardware Capability
 * section is masked per value cell, not as a whole).
 *
 * Viewport note: each capture grows the viewport to the full content height, so
 * height-dependent layout (100vh regions, the pinned composer, the sidebar footer)
 * is rendered in that tall layout, not a real 900px one; the 1440x900 chat and
 * overlay captures cover the real-viewport case.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

// Waits below allow up to 60s; the 30s default test timeout would cut them short.
test.describe.configure({ timeout: 180_000 });

const WIDTHS = [1440, 1024, 768, 500] as const;
const THEMES = ['light', 'dark'] as const;
const HEIGHT = 900;

/**
 * Known sub-pixel anti-aliasing flake at the 64px-rail Settings gear: the
 * `training-empty` light 1024px capture differs from its baseline by ~2px around
 * the rail gear on some runs (figure from the PR #149 body; it reproduces on master too, so it is not
 * a regression from any one change). Tolerance is scoped to EXACTLY that
 * state/theme/width: every other capture keeps zero tolerance (no maxDiffPixels),
 * so a real layout change anywhere else still fails. Playwright applies the
 * stricter of maxDiffPixels and maxDiffPixelRatio, so 6 pixels is the ceiling.
 */
function railGearTolerance(stateId: string, theme: string, width: number): { maxDiffPixels?: number; maxDiffPixelRatio?: number } {
  return stateId === 'training-empty' && theme === 'light' && width === 1024
    ? { maxDiffPixels: 6, maxDiffPixelRatio: 0.0001 }
    : {};
}
/** Chromium caps screenshots well above this; stop growing here. */
const MAX_HEIGHT = 12_000;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

type StateDef = {
  id: string;
  nav?: string;
  seed?: boolean;
  act?: (page: Page) => Promise<void>;
};

const STATES: StateDef[] = [
  { id: 'chat-empty' },
  { id: 'chat-populated', seed: true },
  { id: 'documents-empty', nav: 'Documents' },
  { id: 'documents-populated', nav: 'Documents', seed: true },
  { id: 'training-empty', nav: 'Training' },
  { id: 'settings', nav: 'Settings' },
  {
    id: 'settings-external',
    nav: 'Settings',
    act: async (page) => {
      await page.getByRole('radio', { name: 'Local or network server' }).check({ force: true });
      await page.getByLabel('Base URL', { exact: true }).fill('http://localhost:1234');
      // Moving focus blurs the field, which saves it (the switch requires a saved URL + model).
      await page.getByLabel('Model', { exact: true }).focus();
      await page.getByLabel('Model', { exact: true }).fill('local-model');
      await page.getByRole('button', { name: 'Test connection' }).focus();
      await page.getByRole('switch', { name: 'Use external model' }).check({ force: true });
      await expect(page.getByRole('switch', { name: 'Use external model' })).toBeChecked();
      // No focus ring or caret in the capture.
      await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
    },
  },
];

/**
 * Lumen phase 3: at <= 768px the primary nav lives in the AppShell drawer, opened
 * from the top bar's menu button; choosing a destination closes it again. At wider
 * widths the menu button does not exist and the nav buttons are clicked directly.
 */
async function clickNav(page: Page, name: string): Promise<void> {
  const menu = page.getByRole('button', { name: 'Open navigation' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name, exact: true }).click({ force: true });
  // Park the pointer on the (non-interactive) brand corner so no hover state or
  // icon-rail tooltip from the clicked item enters the capture.
  await page.mouse.move(0, 0);
}

async function blockExternalNetwork(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    return route.abort();
  });
}

async function waitReady(page: Page): Promise<void> {
  // Boot overlay lifts once the lightweight indexes initialize.
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
    timeout: 60_000,
  });
  await page.evaluate(() => document.fonts.ready);
}

async function boot(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await blockExternalNetwork(page);
  await page.clock.setFixedTime(new Date(NOW + 24 * 3600 * 1000));
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('theme-preference', t);
    } catch {
      /* ignore */
    }
  }, theme);
  await page.goto('/');
  await waitReady(page);
}

/** Write one conversation and three documents straight into IndexedDB, then reload. */
async function seedPopulated(page: Page): Promise<void> {
  const prefix = await page.evaluate(() => localStorage.getItem('doc-qa-profile-id'));
  expect(prefix, 'profile id is minted at boot').toBeTruthy();
  await page.evaluate(
    async ({ prefix, now }) => {
      const open = (name: string) =>
        new Promise<IDBDatabase>((res, rej) => {
          const r = indexedDB.open(name);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      const put = (db: IDBDatabase, store: string, v: unknown) =>
        new Promise<void>((res, rej) => {
          const t = db.transaction(store, 'readwrite');
          t.objectStore(store).put(v);
          t.oncomplete = () => res();
          t.onerror = () => rej(t.error);
        });
      const docs = await open(`${prefix}-doc-qa-documents`);
      const doc = (id: string, fileName: string, status: string, extra: object = {}) => ({
        id,
        fileName,
        fileSize: 120_000,
        fileType: 'application/pdf',
        status,
        progress: 100,
        chunkCount: 12,
        uploadedAt: now - 86_400_000,
        ...extra,
      });
      await put(docs, 'documents', doc('d1', 'Employee-Handbook.pdf', 'ready'));
      await put(docs, 'documents', doc('d2', 'Safety-Procedures.docx', 'ready', { chunkCount: 40 }));
      await put(
        docs,
        'documents',
        doc('d3', 'Broken.pdf', 'error', { errorMessage: 'Could not extract text', progress: 0, chunkCount: 0 })
      );
      docs.close();
      const conv = await open('docqa_conversations');
      const msg = (id: string, role: string, content: string, extra: object = {}) => ({
        id,
        role,
        content,
        timestamp: now - 3_600_000,
        ...extra,
      });
      await put(conv, 'conversations', {
        id: 'c1',
        title: 'Onboarding questions',
        createdAt: now - 7_200_000,
        updatedAt: now - 3_600_000,
        mode: 'wllama',
        modelUsed: 'test',
        messages: [
          msg('m1', 'user', 'How many vacation days do new hires get?'),
          msg('m2', 'assistant', 'New hires receive **15 days** of paid vacation per year [1].\n\n- Accrued monthly\n- Carries over up to 5 days', {
            grounding: 'grounded',
            sources: ['Employee-Handbook.pdf'],
            citations: [
              { docId: 'd1', chunkIndex: 0, source: 'Employee-Handbook.pdf', page: 4, text: 'New hires receive 15 days.' },
            ],
          }),
          msg('m3', 'user', 'What about parental leave?'),
          msg('m4', 'assistant', 'I could not find anything about parental leave in your documents.', {
            abstain: true,
            abstainReason: 'insufficient_evidence',
            grounding: 'general',
          }),
        ],
      });
      conv.close();
    },
    { prefix, now: NOW }
  );
  await page.reload();
  await waitReady(page);
  // Let the persisted conversation load and the documents list render.
  await page.waitForTimeout(1500);
}

/** Hide the model-gate scrim (the alertdialog's parent) so the surface underneath renders. */
async function hideModelGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('[role="alertdialog"]').forEach((el) => {
      (el.parentElement ?? el).setAttribute('data-lumen-hidden', '1');
    });
  });
  await page.addStyleTag({ content: '[data-lumen-hidden="1"]{display:none !important}' });
}

/**
 * Grow the viewport until nothing scrolls vertically, so one screenshot holds
 * the whole surface (the scroller is <main>, so `fullPage` alone does not work).
 */
async function fitViewportToContent(page: Page, width: number): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const need = await page.evaluate(() => {
      let delta = 0;
      document.querySelectorAll('*').forEach((el) => {
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) {
          delta = Math.max(delta, el.scrollHeight - el.clientHeight);
        }
      });
      return delta;
    });
    if (need <= 0) return;
    const current = page.viewportSize()?.height ?? HEIGHT;
    await page.setViewportSize({ width, height: Math.min(current + need, MAX_HEIGHT) });
    await page.waitForTimeout(150);
  }
}

/**
 * Machine-derived VALUE cells of the Hardware Capability section only (suitability
 * meter, WebGPU / multi-threading badges, memory tier, recommended engine, reasons
 * sentence). The section card, its heading, description and row labels stay in the
 * baseline so a restyle of that section still shows a diff. Lumen phase 4: the rows
 * are a KeyValueList (dt label / dd value).
 */
function hardwareValueMasks(page: Page): Locator[] {
  // Lumen phase 4: Hardware capability is a sub-block (role=group) of Model & connection.
  const section = page.locator('[aria-labelledby="hardware-heading"]');
  return [
    section.getByRole('progressbar'),
    section.locator('span[role="status"]'),
    section.locator('xpath=.//dt[normalize-space(.)="Memory Tier" or normalize-space(.)="Recommended Engine"]/following-sibling::dd[1]'),
    section.locator('.settings-hardware__reasons'),
  ];
}

/**
 * The re-index notice banner's rounded bottom-left corner rasterizes in one of two
 * ways at dark @ 1024 (an anti-aliasing wobble at x 89-92, y 158-160). Measured against
 * an unmasked, freshly regenerated baseline the diff is 0-1px, so that one image allows
 * 6 differing pixels instead of masking the banner (a mask would hide a real banner
 * regression). Every other image keeps the config's zero tolerance. Playwright takes the
 * stricter of maxDiffPixels and maxDiffPixelRatio, and the config pins the ratio to 0, so
 * the ratio is relaxed here too (0.0001 of the image is well above 6px; maxDiffPixels binds).
 */
const bannerCornerTolerance = (state: string, theme: string, width: number): { maxDiffPixels: number; maxDiffPixelRatio: number } | Record<string, never> =>
  state === 'documents-populated' && theme === 'dark' && width === 1024 ? { maxDiffPixels: 6, maxDiffPixelRatio: 0.0001 } : {};

/** Dynamic, machine-derived regions that must not enter a baseline. */
function dynamicMasks(page: Page): Locator[] {
  return [
    page.getByText(/Recommended for this device/i),
    // The whole memory meter (label, percentage and fill are machine-derived).
    page.getByRole('progressbar', { name: /Memory Used/i }),
    ...hardwareValueMasks(page),
    page.locator('time'),
  ];
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} @ ${width}`, () => {
      test.use({
        viewport: { width, height: HEIGHT },
        colorScheme: theme,
        timezoneId: 'UTC',
        locale: 'en-US',
      });

      test('overlay-model-not-ready', async ({ page }) => {
        await boot(page, theme);
        const shown = (await page.getByRole('alertdialog').count()) > 0;
        if (!shown && process.env.LUMEN_ALLOW_NO_OVERLAY === '1') {
          test.skip(true, 'overlay opt-out (LUMEN_ALLOW_NO_OVERLAY=1)');
        }
        // Absent gate = regression or a staged-weights build: fail unless explicitly opted out.
        expect(shown, 'model-gate overlay must render; set LUMEN_ALLOW_NO_OVERLAY=1 only for builds with staged weights').toBe(true);
        await expect(page).toHaveScreenshot(`overlay-model-not-ready-${theme}-${width}.png`, {
          mask: dynamicMasks(page),
        });
      });

      for (const state of STATES) {
        test(state.id, async ({ page }) => {
          await boot(page, theme);
          if (state.seed) await seedPopulated(page);
          if ((await page.getByRole('alertdialog').count()) > 0) await hideModelGate(page);
          if (state.nav) {
            await clickNav(page, state.nav);
          }
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(500);
          if (state.act) await state.act(page);
          await fitViewportToContent(page, width);
          await expect(page).toHaveScreenshot(`${state.id}-${theme}-${width}.png`, {
            mask: dynamicMasks(page),
            ...railGearTolerance(state.id, theme, width),
            ...bannerCornerTolerance(state.id, theme, width),
          });
        });
      }
    });
  }
}
