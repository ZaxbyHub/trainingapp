/**
 * axe-full-page.ts — whole-page scan geometry for the Lumen axe gates
 * (issue #146: the gate scanned only the first 900px viewport, and axe-core
 * reports offscreen nodes — below-fold contrast et al. — as `incomplete`,
 * never as violations, so below-fold failures passed CI).
 *
 * fitViewportToContent grows the viewport (height only, width pinned) until no
 * element scrolls vertically, capped at MAX_SCAN_HEIGHT — the loop proven by
 * lumen-axe-settings-full.spec.ts, now shared by every axe surface scan. Every
 * node is then on screen, so axe judges it instead of deferring it.
 *
 * axeSeriousCriticalNodes runs axe once against the fitted page and returns the
 * serious/critical nodes as `ruleId | target selector` strings (sorted), the
 * node shape the gates have always asserted on.
 *
 * The KNOWN_BASELINE map itself stays in lumen-axe.spec.ts (positional keys,
 * and it must remain empty there — fix nodes, never baseline them).
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { settleFontsAndFrames } from '../model-gate';

/** Height cap for the grow loop (settings-full precedent; tallest surface is ~4k). */
export const MAX_SCAN_HEIGHT = 12_000;

/**
 * Grow the viewport until no element scrolls vertically (the app's scroller is
 * .ui-shell__main). Offscreen nodes never become violations, so the scan is
 * only whole-page once nothing scrolls.
 */
export async function fitViewportToContent(page: Page, width: number): Promise<void> {
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
    await page.setViewportSize({ width, height: Math.min(current + need, MAX_SCAN_HEIGHT) });
    await page.waitForTimeout(150);
  }
}

/** Serious/critical axe nodes on the page as `ruleId | target` strings, sorted. */
export async function axeSeriousCriticalNodes(page: Page, excludeSelector?: string): Promise<string[]> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']);
  if (excludeSelector !== undefined) builder = builder.exclude(excludeSelector);
  const results = await builder.analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} | ${n.target.join(' ')}`))
    .sort();
}

export interface WholePageAxeGateOptions {
  /** Baseline key for the failure message (never a baseline entry — see below). */
  key: string;
  /** Passed in from the gate's own spec: it must stay an EMPTY map there. */
  knownBaseline: Record<string, unknown>;
  excludeSelector?: string;
}

/**
 * The axe gate contract end-to-end (#146): settle fonts/frames, GROW the
 * viewport until nothing scrolls, then scan and fail loud on any
 * serious/critical node or any baseline entry. The grow call is load-bearing
 * wiring — a viewport-only pass defers below-fold nodes as `incomplete` and
 * the gate goes vacuously green — so this function is where the gate's scan
 * semantics live, and lumen-axe-below-fold.spec.ts pins both the behavior
 * (planted below-fold violation must reject) and the call-site delegation.
 */
export async function wholePageAxeExpectClean(page: Page, opts: WholePageAxeGateOptions): Promise<void> {
  await page.waitForTimeout(500);
  await settleFontsAndFrames(page);
  await fitViewportToContent(page, page.viewportSize()?.width ?? 1440);
  const found = await axeSeriousCriticalNodes(page, opts.excludeSelector);
  if (process.env.LUMEN_AXE_INVENTORY) {
    console.info(`AXE ${opts.key} ${JSON.stringify(found)}`);
  }
  expect(opts.knownBaseline[opts.key], `${opts.key} must never be baselined`).toBeUndefined();
  expect(found, `serious/critical axe nodes on ${opts.key}`).toEqual([]);
}
