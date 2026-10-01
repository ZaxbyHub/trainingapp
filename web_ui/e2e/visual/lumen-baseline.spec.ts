/**
 * lumen-baseline.spec.ts — Lumen design-language (docs/design/design-language.md) phase 0 (section 6): visual
 * regression baselines of every top-level browser-mode surface, light + dark,
 * at widths 1440 / 1024 / 768 / 500, so every later phase shows its visual
 * diff explicitly.
 *
 * Run through playwright.visual.config.ts (opt-in; see its header).
 *
 * Surfaces: Chat, Documents, Training, Settings, and the "Model not ready"
 * alertdialog that browser builds without staged weights show over the app.
 * NOT covered (deferred, reported): FirstRunWizard and
 * DesktopModelBlockedOverlay render only when window.desktopApi exists
 * (Electron preload), which a plain-browser harness cannot provide without
 * faking the desktop bridge.
 *
 * Determinism: theme is forced via the persisted `theme-preference` key (and
 * emulated colorScheme); animations are disabled by the config and reduced
 * motion is requested; fonts are awaited; all cross-origin traffic is
 * aborted; hardware/quota-derived text is masked.
 */

import { expect, test, type Page } from '@playwright/test';

const WIDTHS = [1440, 1024, 768, 500] as const;
const THEMES = ['light', 'dark'] as const;
const HEIGHT = 900;

type Surface = 'chat' | 'documents' | 'training' | 'settings';
const SURFACES: Array<{ id: Surface; nav: string }> = [
  { id: 'chat', nav: 'Chat' },
  { id: 'documents', nav: 'Documents' },
  { id: 'training', nav: 'Training' },
  { id: 'settings', nav: 'Settings' },
];

async function blockExternalNetwork(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    return route.abort();
  });
}

async function boot(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await blockExternalNetwork(page);
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('theme-preference', t);
    } catch {
      /* ignore */
    }
  }, theme);
  await page.goto('/');
  // Boot overlay lifts once the lightweight indexes initialize.
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
    timeout: 60_000,
  });
  await page.evaluate(() => document.fonts.ready);
}

/** Dynamic, machine-derived regions that must not enter a baseline. */
function dynamicMasks(page: Page) {
  return [page.getByText(/Recommended for this device/i), page.locator('time')];
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} @ ${width}`, () => {
      test.use({ viewport: { width, height: HEIGHT }, colorScheme: theme });

      test('model-not-ready overlay', async ({ page }) => {
        await boot(page, theme);
        const dialog = page.getByRole('alertdialog');
        const shown = (await dialog.count()) > 0;
        if (!shown && process.env.LUMEN_ALLOW_NO_OVERLAY === '1') {
          test.skip(true, 'overlay opt-out (LUMEN_ALLOW_NO_OVERLAY=1)');
        }
        // Absent gate = regression or a staged-weights build: fail unless explicitly opted out.
        expect(shown, 'model-gate overlay must render; set LUMEN_ALLOW_NO_OVERLAY=1 only for builds with staged weights').toBe(true);
        await expect(page).toHaveScreenshot(`overlay-model-not-ready-${theme}-${width}.png`, {
          mask: dynamicMasks(page),
        });
      });

      for (const surface of SURFACES) {
        test(`${surface.id}`, async ({ page }) => {
          await boot(page, theme);
          // Dismiss the model gate if present so the real surface renders.
          const dialog = page.getByRole('alertdialog');
          if ((await dialog.count()) > 0) {
            await page.evaluate(() => {
              document.querySelectorAll('[role="alertdialog"]').forEach((el) => {
                (el.parentElement ?? el).setAttribute('data-lumen-hidden', '1');
              });
            });
            await page.addStyleTag({
              content: '[data-lumen-hidden="1"]{display:none !important}',
            });
          }
          if (surface.id !== 'chat') {
            await page
              .getByRole('button', { name: surface.nav, exact: true })
              .click({ force: true });
          }
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(500);
          await expect(page).toHaveScreenshot(`${surface.id}-${theme}-${width}.png`, {
            mask: dynamicMasks(page),
          });
        });
      }
    });
  }
}
