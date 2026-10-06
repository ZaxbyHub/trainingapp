/**
 * lumen-axe.spec.ts — Lumen phase 0 accessibility pass: axe-core (WCAG 2.0/2.1/2.2
 * A + AA tags) over every browser-mode surface, light + dark, at 1440 and 500, plus the
 * populated Training surfaces (Training packs tab, library, player page) with a course installed.
 * Run through playwright.visual.config.ts; CI runs it in the required web-ui e2e
 * job via `npm run test:visual:a11y:ci` (see e2e/visual/README.md).
 *
 * Fails on ANY serious/critical violation node (rule id + selector) on any scanned
 * surface: zero nodes allowed, no baseline. KNOWN_BASELINE (below) once held
 * pre-existing master violations; phase 7 emptied it, and every scan now also fails
 * if an entry is added for its key (PR #151 review PRR-151-065: the old
 * stale-entry check could no longer fire on an empty map, so it was removed rather
 * than kept as dead code).
 *
 * Every scan first waits for web fonts and two animation frames
 * (settleFontsAndFrames), so axe sees settled, font-swapped layout (PRR-151-073).
 * Surfaces other than 'overlay' and 'drawer' are scanned with the model gate hidden
 * and the chat inert lifted for the rest of the page (e2e/model-gate.ts
 * hideModelGate); its post-condition is re-checked right before each such scan
 * (PRR-151-003/-025/-063).
 */

import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import {
  assertOverlayOptOutAllowed,
  expectModelGateHidden,
  hideModelGate,
  requireModelGate,
  settleFontsAndFrames,
} from '../model-gate';

// PRR-151-054: the LUMEN_ALLOW_NO_OVERLAY opt-out is refused under CI.
assertOverlayOptOutAllowed();

// Waits below allow up to 60s; the 30s default test timeout would cut them short.
test.describe.configure({ timeout: 180_000 });

const WIDTHS = [1440, 500] as const;
const THEMES = ['light', 'dark'] as const;
const HEIGHT = 900;
const SURFACES = ['overlay', 'chat', 'documents', 'training', 'settings'] as const;
type Surface = (typeof SURFACES)[number];
const NAV: Record<Exclude<Surface, 'overlay' | 'chat'>, string> = {
  documents: 'Documents',
  training: 'Training',
  settings: 'Settings',
};

/**
 * Pre-existing violations on unchanged master, keyed `${surface}:${theme}:${width}`,
 * each `ruleId | node selector`. Regenerate with LUMEN_AXE_INVENTORY=1.
 *
 * Phase 3 (shell) removed the old sidebar's "No conversations yet" node
 * (legacy --color-text-muted on --color-surface, 4.18:1) from every light 1440 key,
 * which also emptied 'training:light:1440'. Phase 4 (Settings on Lumen tokens) emptied
 * every settings key. Every remaining entry is page-body debt.
 * Phase 5 (chat) restyled the welcome hero on Lumen tokens, which emptied both
 * 'chat:light:*' keys, and fixed 'overlay:light:1440' `ul:nth-child(3) > li` at the
 * root: ModelBlockedOverlay's recommendation list moved from legacy --color-text-muted
 * (4.18:1 on the #f0f0f5 card) to --text-secondary (6.48:1 light, 9.27:1 dark), and its
 * failures list from --color-danger to --danger (5.70:1 / 5.48:1), verified with the
 * page behind the card hidden so axe could not report them as merely `incomplete`.
 * Phase 6 (Documents & Training) fixed and removed both 'documents:light:*' entries.
 * Phase 7 (overlays) rebuilt the model gate on ui/Dialog + Banner + Button (its
 * outlined "Open Settings" button was the last 'overlay:light:*' node) and emptied
 * the baseline: every key is now zero-node, and expectAxeClean fails if an entry is
 * added for the key it scans. Do not add entries: fix the violation instead.
 */
const KNOWN_BASELINE: Record<string, readonly string[]> = {};

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

// PRR-219 (PR 150 review): the populated Training surfaces need an installed course, which the
// empty 'training' pass above never has. One minimal training pack (the same shape
// e2e/packs-browser.spec.ts installs) is installed through the real Packs panel, then the
// Documents "Training packs" tab, the Training library and the course player page are scanned.
// The player's <iframe> (the course content) is excluded: only the host chrome is ours.
const AXE_COURSE_ID = 'axe-fixture-course';
const AXE_COURSE_NAME = 'Axe Fixture Course';
const AXE_SLIDE_PATH = 'docs/slide-001-5rN4PvXJM5d.json';
const AXE_SLIDE_DOC = Buffer.from(
  JSON.stringify({ slide_id: '5rN4PvXJM5d', slide_title: 'Welcome', section_title: 'Launch Menu', on_screen_text: 'Start the course' }),
  'utf8'
);

async function axeCourseZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'pack.json',
    JSON.stringify({
      id: AXE_COURSE_ID,
      name: AXE_COURSE_NAME,
      version: '1.0.0',
      published_at: '2026-10-01T00:00:00Z',
      source_class: 'training',
      embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
      chunking: { strategy: 'slide-aware', size: 256, overlap: 0 },
      docs: [
        {
          path: AXE_SLIDE_PATH,
          sha256: createHash('sha256').update(AXE_SLIDE_DOC).digest('hex'),
          title: 'Welcome',
          mime: 'application/json',
        },
      ],
    })
  );
  zip.file(AXE_SLIDE_PATH, AXE_SLIDE_DOC);
  zip.file('assets/player/story.html', '<!doctype html><html lang="en"><head><title>course</title></head><body>AXE-FIXTURE</body></html>');
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

/** Boot the app, hide the model-gate scrim, and install the fixture course via the Packs panel. */
async function bootWithInstalledCourse(page: Page, theme: string): Promise<void> {
  await blockExternalNetwork(page);
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('theme-preference', t);
    } catch {
      /* ignore */
    }
  }, theme);
  await page.goto('/');
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await hideModelGate(page, { expectGate: true });
  await clickNav(page, 'Documents');
  await expect(page.getByTestId('packs-panel')).toBeVisible({ timeout: 45_000 });
  await page
    .getByTestId('pack-install-input')
    .setInputFiles({ name: `${AXE_COURSE_ID}-1.0.0.zip`, mimeType: 'application/zip', buffer: await axeCourseZip() });
  await expect(page.getByTestId(`pack-row-${AXE_COURSE_ID}-1.0.0`)).toBeVisible({ timeout: 60_000 });
}

/**
 * Zero serious/critical nodes allowed: no key is baselined. Waits for fonts and two
 * frames first (PRR-151-073). Callers scanning a surface UNDER a hidden gate call
 * expectModelGateHidden right before this.
 */
async function expectAxeClean(page: Page, key: string, excludeSelector?: string): Promise<void> {
  await page.waitForTimeout(500);
  await settleFontsAndFrames(page);
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']);
  if (excludeSelector !== undefined) builder = builder.exclude(excludeSelector);
  const results = await builder.analyze();
  const found = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} | ${n.target.join(' ')}`))
    .sort();
  if (process.env.LUMEN_AXE_INVENTORY) {
    console.info(`AXE ${key} ${JSON.stringify(found)}`);
  }
  expect(KNOWN_BASELINE[key], `${key} must never be baselined`).toBeUndefined();
  expect(found, `serious/critical axe nodes on ${key}`).toEqual([]);
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`axe ${theme} @ ${width}`, () => {
      test.use({ viewport: { width, height: HEIGHT }, colorScheme: theme });

      for (const surface of SURFACES) {
        test(surface, async ({ page }) => {
          await blockExternalNetwork(page);
          await page.addInitScript((t) => {
            try {
              localStorage.setItem('theme-preference', t);
            } catch {
              /* ignore */
            }
          }, theme);
          await page.goto('/');
          await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
            timeout: 60_000,
          });
          await page.evaluate(() => document.fonts.ready);

          if (surface === 'overlay') {
            // The gate itself is what this pass scans (with the covered content inert).
            await requireModelGate(page);
          } else {
            if (surface !== 'chat') {
              await clickNav(page, NAV[surface]);
            }
            // Scan the surface itself, not the model-gate overlay stacked on it. Hide the
            // Dialog backdrop (stable test id), as lumen-baseline.spec.ts does; hiding only the
            // dialog leaves the 70% scrim masking real contrast results. On 'chat' the gate
            // must be up first; elsewhere the chat page (and its gate) are already unmounted.
            await hideModelGate(page, { expectGate: surface === 'chat' });
            await page.waitForTimeout(500);
            // Re-checked right before the scan: a gate mounting late would re-add inert.
            await expectModelGateHidden(page);
          }
          await expectAxeClean(page, `${surface}:${theme}:${width}`);
        });
      }

      test('training-packs (Documents > Training packs tab, course installed)', async ({ page }) => {
        await bootWithInstalledCourse(page, theme);
        const tab = page.getByRole('tab', { name: 'Training packs' });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByTestId(`pack-row-${AXE_COURSE_ID}-1.0.0`)).toBeVisible();
        await page.mouse.move(0, 0);
        await expectModelGateHidden(page);
        await expectAxeClean(page, `training-packs:${theme}:${width}`);
      });

      test('training-library and training-player (course installed; the course iframe is excluded)', async ({ page }) => {
        await bootWithInstalledCourse(page, theme);
        await clickNav(page, 'Training');
        // A sole installed course opens straight into its player page.
        const frame = page.locator('iframe[data-testid="training-player-frame"]');
        await expect(frame).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('button', { name: 'All courses' })).toBeVisible();
        await expectModelGateHidden(page);
        await expectAxeClean(page, `training-player:${theme}:${width}`, 'iframe[data-testid="training-player-frame"]');

        await page.getByRole('button', { name: 'All courses' }).click();
        await expect(page.getByTestId(`training-course-${AXE_COURSE_ID}`)).toBeVisible();
        await page.mouse.move(0, 0);
        await expectModelGateHidden(page);
        await expectAxeClean(page, `training-library:${theme}:${width}`);
      });

      // Lumen phase 3 (review F6): the AppShell nav drawer, open, at the drawer width,
      // opened on Chat with the model gate up (asserted below). What this scans: the
      // drawer (a modal dialog) and the shell around it. While the drawer is open the
      // top bar and <main> are inert, so axe excludes them, and with them the model
      // gate inside <main>; the gate itself is scanned by the 'overlay' pass above.
      // (PR #147 PRR-004: the earlier wording implied the gate was scanned here.)
      // No KNOWN_BASELINE entry exists or may be added for this key: zero nodes allowed.
      if (width === 500) {
        test('drawer', async ({ page }) => {
          await blockExternalNetwork(page);
          await page.addInitScript((t) => {
            try {
              localStorage.setItem('theme-preference', t);
            } catch {
              /* ignore */
            }
          }, theme);
          await page.goto('/');
          await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
            timeout: 60_000,
          });
          await page.evaluate(() => document.fonts.ready);
          // The scenario is "drawer over the model gate": require the gate (same opt-out
          // as the overlay pass for builds with staged weights).
          await requireModelGate(page);
          await page.getByRole('button', { name: 'Open navigation' }).click();
          const drawer = page.getByRole('dialog', { name: 'Navigation' });
          await expect(drawer).toBeVisible();
          await expect(drawer.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
          // Document what axe can and cannot see: everything behind the drawer is inert.
          await expect(page.locator('main')).toHaveAttribute('inert', '');
          await expect(page.locator('.ui-shell__topbar')).toHaveAttribute('inert', '');
          await expectAxeClean(page, `drawer:${theme}:${width}`);
        });
      }
    });
  }
}
