/**
 * lumen-axe.spec.ts — Lumen phase 0 accessibility pass: axe-core (WCAG 2.0/2.1/2.2
 * A + AA tags) over every browser-mode surface, light + dark, at 1440 and 500.
 * Run through playwright.visual.config.ts; CI runs it in the required web-ui e2e
 * job via `npm run test:visual:a11y:ci` (see e2e/visual/README.md).
 *
 * Fails on any serious/critical violation NODE (rule id + selector) that is not
 * a named known-baseline entry. KNOWN_BASELINE records PRE-EXISTING master
 * violations (measured on the unchanged UI) per surface; later phases must
 * delete entries as they fix them, and any new node or rule on a surface fails. A baseline entry
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
 * Pre-existing violations on unchanged master, keyed `${surface}:${theme}:${width}`,
 * each `ruleId | node selector`. Regenerate with LUMEN_AXE_INVENTORY=1.
 */
const KNOWN_BASELINE: Record<string, readonly string[]> = {
  'overlay:light:1440': [
    "color-contrast | div[role=\"alertdialog\"] > div > button:nth-child(2)",
    "color-contrast | nav > div:nth-child(3) > div",
    "color-contrast | ul:nth-child(3) > li",
  ],
  'chat:light:1440': [
    "color-contrast | div[role=\"region\"] > div:nth-child(1) > p",
    "color-contrast | div[role=\"region\"] > div:nth-child(3)",
    "color-contrast | nav > div:nth-child(3) > div",
  ],
  'documents:light:1440': [
    "color-contrast | div:nth-child(3) > div > p",
    "color-contrast | nav > div:nth-child(3) > div",
    "color-contrast | p:nth-child(4)",
  ],
  'training:light:1440': [
    "color-contrast | div:nth-child(3) > div",
    "color-contrast | main > div",
  ],
  'settings:light:1440': [
    "color-contrast | #browser-local-desc",
    "color-contrast | div[role=\"status\"][aria-live=\"polite\"] > p",
    "color-contrast | nav > div:nth-child(3) > div",
    "color-contrast | span > span[role=\"status\"][aria-live=\"polite\"]",
  ],
  'overlay:light:500': [
    "color-contrast | div[role=\"alertdialog\"] > div > button:nth-child(2)",
  ],
  'chat:light:500': [
    "color-contrast | div[role=\"region\"] > div:nth-child(1) > p",
    "color-contrast | div[role=\"region\"] > div:nth-child(3)",
  ],
  'documents:light:500': [
    "color-contrast | div:nth-child(3) > div > p",
    "color-contrast | p:nth-child(4)",
  ],
  'training:light:500': [
    "color-contrast | main > div",
  ],
  'settings:light:500': [
    "color-contrast | #browser-local-desc",
  ],
};

/**
 * Settings status messages that are timing- and cache-state-dependent: on ubuntu CI they
 * reproduced at 1440, appeared unexpectedly at 500 on master, and were absent at 500 on
 * 39bf1d2. Excluded from BOTH the unexpected and the stale check on the settings light
 * keys. Pre-existing #140/#141 debt: fix by darkening --color-text-muted, then drop this set.
 */
const MAY_APPEAR: readonly string[] = [
  'color-contrast | div[role="status"][aria-live="polite"] > p',
  'color-contrast | span > span[role="status"][aria-live="polite"]',
];

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
            const shown = (await page.getByRole('alertdialog').count()) > 0;
            if (!shown && process.env.LUMEN_ALLOW_NO_OVERLAY === '1') test.skip(true, 'overlay opt-out (LUMEN_ALLOW_NO_OVERLAY=1)');
            expect(shown, 'model-gate overlay must render; set LUMEN_ALLOW_NO_OVERLAY=1 only for builds with staged weights').toBe(true);
          } else {
            if (surface !== 'chat') {
              await page.getByRole('button', { name: NAV[surface], exact: true }).click({ force: true });
            }
            // Scan the surface itself, not the model-gate overlay stacked on it. Hide the
            // alertdialog's PARENT (the full-screen scrim), as lumen-baseline.spec.ts does;
            // hiding only the dialog leaves the 70% scrim masking real contrast results.
            await page.evaluate(() => {
              document.querySelectorAll('[role="alertdialog"]').forEach((el) => {
                (el.parentElement ?? el).setAttribute('data-lumen-hidden', '1');
              });
            });
            await page.addStyleTag({ content: '[data-lumen-hidden="1"]{display:none !important}' });
          }
          await page.waitForTimeout(500);

          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
            .analyze();
          const blocking = results.violations.filter(
            (v) => v.impact === 'serious' || v.impact === 'critical'
          );
          // A finding is (rule id, node selector): a new low-contrast node on an already
          // baselined surface must fail, not hide behind the rule id.
          const found = blocking
            .flatMap((v) => v.nodes.map((n) => `${v.id} | ${n.target.join(' ')}`))
            .sort();
          const key = `${surface}:${theme}:${width}`;
          const known = [...(KNOWN_BASELINE[key] ?? [])].sort();

          if (process.env.LUMEN_AXE_INVENTORY) {
            console.info(`AXE ${key} ${JSON.stringify(found)}`);
          }
          const flaky = surface === 'settings' && theme === 'light' ? MAY_APPEAR : [];
          const observed = found.filter((f) => !flaky.includes(f));
          const expected = known.filter((f) => !flaky.includes(f));
          const unexpected = observed.filter((f) => !expected.includes(f));
          expect(unexpected, `new serious/critical axe nodes on ${key}`).toEqual([]);
          const stale = expected.filter((f) => !observed.includes(f));
          expect(stale, `stale baseline entries on ${key} (fixed? remove them)`).toEqual([]);
        });
      }
    });
  }
}
