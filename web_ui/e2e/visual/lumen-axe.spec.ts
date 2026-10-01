/**
 * lumen-axe.spec.ts — Lumen phase 0 accessibility pass: axe-core (WCAG 2.0/2.1
 * A + AA tags) over every browser-mode surface, light + dark, at 1440 and 500.
 * Run through playwright.visual.config.ts (opt-in).
 *
 * Fails on any serious/critical violation that is not a named known-baseline
 * entry. KNOWN_BASELINE records PRE-EXISTING master violations (measured on
 * the unchanged UI) per surface and rule id; later phases must delete entries
 * as they fix them, and any new rule on a surface fails. A baseline entry
 * that no longer reproduces ALSO fails, so the list cannot rot.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

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
 * Pre-existing violations on unchanged master, keyed `${surface}:${theme}:${width}`.
 * Populated from the measured inventory (see report); rule ids only, so any
 * additional rule fails.
 */
const KNOWN_BASELINE: Record<string, readonly string[]> = {
  'overlay:light:1440': ['color-contrast'],
  'overlay:light:500': ['color-contrast'],
  'chat:light:1440': ['color-contrast'],
  'documents:light:1440': ['color-contrast'],
  'documents:light:500': ['color-contrast'],
  'training:light:1440': ['color-contrast'],
  'training:light:500': ['color-contrast'],
  'settings:light:1440': ['color-contrast'],
  'settings:light:500': ['color-contrast'],
};

async function blockExternalNetwork(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    return route.abort();
  });
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
            test.skip((await page.getByRole('alertdialog').count()) === 0, 'overlay not shown in this build');
          } else {
            if (surface !== 'chat') {
              await page.getByRole('button', { name: NAV[surface], exact: true }).click({ force: true });
            }
            // Scan the surface itself, not the model-gate overlay stacked on it.
            await page.addStyleTag({ content: '[role="alertdialog"]{display:none !important}' });
          }
          await page.waitForTimeout(500);

          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          const blocking = results.violations.filter(
            (v) => v.impact === 'serious' || v.impact === 'critical'
          );
          const found = [...new Set(blocking.map((v) => v.id))].sort();
          const key = `${surface}:${theme}:${width}`;
          const known = [...(KNOWN_BASELINE[key] ?? [])].sort();

          if (process.env.LUMEN_AXE_INVENTORY) {
            console.info(
              `AXE ${key} ` +
                JSON.stringify(blocking.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.map((n) => n.target.join(' ')).slice(0, 12) })))
            );
          }
          const unexpected = found.filter((id) => !known.includes(id));
          expect(unexpected, `new serious/critical axe rules on ${key}`).toEqual([]);
          const stale = known.filter((id) => !found.includes(id));
          expect(stale, `stale baseline entries on ${key} (fixed? remove them)`).toEqual([]);
        });
      }
    });
  }
}
