/**
 * lumen-axe-settings-full.spec.ts — Lumen phase 4: full-page axe pass over Settings.
 *
 * lumen-axe.spec.ts scans each surface at a 900px-tall viewport. Settings is ~3200px
 * (1440) / ~3800px (500) tall and scrolls inside <main>, so axe reports colour contrast
 * for below-the-fold nodes as `incomplete` (offscreen), never as violations: the
 * per-surface gate is blind to most of the page (PR #144 review, PRR-105). This spec
 * grows the viewport until nothing scrolls, so EVERY Settings node is on screen, and
 * requires zero serious/critical violations with no baseline, in the default state and
 * with Model & connection on a server source, configured and switched on (the section
 * nav included: side list at 1440, wrapped row at 1024, "Jump to section" select at 500).
 *
 * Runs in CI with the a11y subset (`lumen-axe` matches this file; see README.md).
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// 1440: side nav; 1024: wrapped-row nav; 500: "Jump to section" select.
const WIDTHS = [1440, 1024, 500] as const;
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
  await page.getByRole('radio', { name: 'Local or network server' }).check({ force: true });
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

/**
 * WCAG 3.2.2 (review M1): on Windows (and Linux) Chromium, arrow keys on a closed
 * <select> change its value and fire `change` on every key. The "Jump to section"
 * select must then only SCROLL; focus stays on the select until Enter (or "Go").
 */
test.describe('settings jump select keyboard (WCAG 3.2.2)', () => {
  test.use({ viewport: { width: 500, height: 900 }, colorScheme: 'light' });

  test('ArrowDown twice keeps focus on the select and scrolls; Enter moves focus to the section heading', async ({ page }) => {
    await openSettings(page, 'light');
    const select = page.getByLabel('Jump to section');
    await select.focus();
    await expect(select).toHaveValue('model-connection');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(select).toHaveValue('appearance');
    await expect(select).toBeFocused();
    expect(await page.evaluate(() => document.querySelector('main')?.scrollTop ?? 0)).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Appearance' })).toBeFocused();
  });
});

/**
 * Review N1: after a jump the nav keeps the section the user chose, even near the end
 * of the page where a short section can never reach the top (the settle re-sync used
 * to flip the select / aria-current to the last section ~650 ms later).
 */
test.describe('settings nav keeps the jumped-to section (N1) @ 500', () => {
  test.use({ viewport: { width: 500, height: 900 }, colorScheme: 'light' });

  test('select Updates: the value stays "updates" after the jump settles, and Go focuses the Updates heading', async ({ page }) => {
    await openSettings(page, 'light');
    const select = page.getByLabel('Jump to section');
    await select.selectOption('updates');
    await page.waitForTimeout(1000);
    await expect(select).toHaveValue('updates');
    await page.getByRole('button', { name: 'Go to section' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Updates' })).toBeFocused();
    await page.waitForTimeout(1000);
    await expect(select).toHaveValue('updates');
  });
});

test.describe('settings nav keeps the jumped-to section (N1) @ 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });

  test('click Updates: aria-current stays on Updates after the jump settles', async ({ page }) => {
    await openSettings(page, 'light');
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await nav.getByRole('link', { name: 'Updates' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Updates' })).toBeFocused();
    await page.waitForTimeout(1000);
    await expect(nav.getByRole('link', { name: 'Updates' })).toHaveAttribute('aria-current', 'true');
    await expect(nav.getByRole('link', { name: 'About' })).not.toHaveAttribute('aria-current', 'true');
  });
});
