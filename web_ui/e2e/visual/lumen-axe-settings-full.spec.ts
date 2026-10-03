/**
 * lumen-axe-settings-full.spec.ts — Lumen phase 4: full-page axe pass over Settings.
 *
 * lumen-axe.spec.ts scans each surface at a 900px-tall viewport. Settings is ~3200px
 * (1440) / ~3800px (500) tall and scrolls inside <main>, so axe reports colour contrast
 * for below-the-fold nodes as `incomplete` (offscreen), never as violations: the
 * per-surface gate is blind to most of the page (PR #144 review, PRR-105). This spec
 * grows the viewport until nothing scrolls, so EVERY Settings node is on screen, and
 * requires zero serious/critical violations with no baseline, in the default state and
 * with the External model section configured and switched on.
 *
 * Runs in CI with the a11y subset (`lumen-axe` matches this file; see README.md).
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const WIDTHS = [1440, 500] as const;
const THEMES = ['light', 'dark'] as const;
const STATES = ['default', 'external'] as const;
const MAX_HEIGHT = 12_000;

async function blockExternalNetwork(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    return route.abort();
  });
}

async function openSettings(page: Page, theme: string): Promise<void> {
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
  // Scan Settings itself, not the model-gate overlay stacked on it (as lumen-axe.spec.ts).
  await page.evaluate(() => {
    document.querySelectorAll('[role="alertdialog"]').forEach((el) => {
      (el.parentElement ?? el).setAttribute('data-lumen-hidden', '1');
    });
  });
  await page.addStyleTag({ content: '[data-lumen-hidden="1"]{display:none !important}' });
  const menu = page.getByRole('button', { name: 'Open navigation' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click({ force: true });
  await page.mouse.move(0, 0);
  await expect(page.getByRole('heading', { name: 'About' })).toBeAttached();
}

async function configureExternal(page: Page): Promise<void> {
  await page.getByLabel('Base URL', { exact: true }).fill('http://localhost:1234');
  await page.getByLabel('Model', { exact: true }).focus();
  await page.getByLabel('Model', { exact: true }).fill('local-model');
  await page.getByRole('button', { name: 'Test connection' }).focus();
  await page.getByRole('switch', { name: 'Use external model' }).check({ force: true });
  await expect(page.getByRole('switch', { name: 'Use external model' })).toBeChecked();
}

/** Grow the viewport until no element scrolls vertically (the scroller is <main>). */
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
    const current = page.viewportSize()?.height ?? 900;
    await page.setViewportSize({ width, height: Math.min(current + need, MAX_HEIGHT) });
    await page.waitForTimeout(150);
  }
}

for (const state of STATES) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test.describe(`settings full page ${state} ${theme} @ ${width}`, () => {
        test.use({ viewport: { width, height: 900 }, colorScheme: theme });

        test('no serious/critical axe violations anywhere on the page', async ({ page }) => {
          await openSettings(page, theme);
          if (state === 'external') await configureExternal(page);
          await page.waitForTimeout(500);
          await fitViewportToContent(page, width);
          // Non-vacuous: the last section is inside the (grown) viewport.
          const about = await page.getByRole('region', { name: 'About' }).boundingBox();
          const vh = page.viewportSize()?.height ?? 0;
          expect(about, 'About section must render').not.toBeNull();
          expect((about?.y ?? Infinity) + (about?.height ?? 0)).toBeLessThanOrEqual(vh);

          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
            .analyze();
          const blocking = results.violations
            .filter((v) => v.impact === 'serious' || v.impact === 'critical')
            .flatMap((v) => v.nodes.map((n) => `${v.id} | ${n.target.join(' ')}`));
          expect(blocking, `serious/critical axe nodes on full-page Settings (${state} ${theme} ${width})`).toEqual([]);
        });
      });
    }
  }
}
