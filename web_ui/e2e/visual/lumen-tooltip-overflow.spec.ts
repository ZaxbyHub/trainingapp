/**
 * lumen-tooltip-overflow.spec.ts — a shown Tooltip must never create horizontal
 * overflow (design-language.md section 3.5, reflow without horizontal scroll).
 *
 * The production build contains no Tooltip consumer (the gallery is dev-only),
 * so this renders the primitive's REAL markup + REAL stylesheets (lumen-tokens.css,
 * ui.css read from disk) at 500px and applies the REAL clamp function
 * (src/ui/tooltip-position.ts) exactly as Tooltip's layout effect does. The
 * React wiring of that effect is covered by overlays.test.tsx. Control case first:
 * WITHOUT the shift the same markup does overflow, so the assertion is not vacuous.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { computeTooltipShift } from '../../src/ui/tooltip-position';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const TOKENS = read('../../src/styles/lumen-tokens.css');
const UI = read('../../src/ui/ui.css');

const HTML = `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<style>${TOKENS}\n${UI}\nbody{margin:0;font-family:sans-serif}</style></head><body>
<div style="padding:24px"><span class="ui-password">
  <input class="ui-input ui-password__input" aria-label="API key" type="password">
  <span class="ui-tooltip-wrap"><button type="button" class="ui-button ui-button--ghost ui-button--sm ui-icon-button" aria-label="Show password">i</button>
  <span id="tip" role="tooltip" class="ui-tooltip">Show password</span></span>
</span></div></body></html>`;

test.use({ viewport: { width: 500, height: 900 } });

test('password-toggle tooltip at 500px: overflows unshifted, does not once clamped', async ({ page }) => {
  await page.setContent(HTML);
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  const unshifted = await overflow();
  expect(unshifted, 'control: the unclamped tooltip overflows the 500px viewport').toBeGreaterThan(0);

  const rect = await page.evaluate(() => {
    const r = document.getElementById('tip')!.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  const shift = computeTooltipShift(rect, 500);
  expect(shift).toBeLessThan(0);
  await page.evaluate((s) => document.getElementById('tip')!.style.setProperty('--ui-tooltip-shift', `${s}px`), shift);

  expect(await overflow()).toBe(0);
  const after = await page.evaluate(() => document.getElementById('tip')!.getBoundingClientRect().right);
  expect(after).toBeLessThanOrEqual(500 - 8 + 0.5);
});
