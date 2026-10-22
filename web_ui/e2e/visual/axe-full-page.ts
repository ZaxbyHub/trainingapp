/**
 * axe-full-page.ts — whole-page scan geometry for the Lumen axe gates
 * (issue #146: the gate scanned only the first 900px viewport, and axe-core
 * reports offscreen nodes — below-fold contrast et al. — as `incomplete`,
 * never as violations, so below-fold failures passed CI).
 *
 * fitViewportToContent grows the viewport (height only, width pinned) until no
 * element scrolls vertically, capped at MAX_SCAN_HEIGHT — the loop proven by
 * lumen-axe-settings-full.spec.ts, now shared by every axe surface scan. Every
 * node is then on screen, so axe judges it instead of deferring it. Since
 * issue #207 the helper REPORTS convergence: a chasey/tall surface that
 * exhausts the grow budget must make the gate fail loud, never silently scan a
 * still-scrolling page (the vacuous viewport-only pass #146 removed).
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

/** Max extra grow rounds after the first fit, waiting on async trickle (#207 AC2). */
const STABILIZATION_ROUNDS = 3;

/** Outcome of the grow loop: did the page settle, and how much scroll remains. */
export interface FitResult {
  converged: boolean;
  remainingScrollPx: number;
}

/** Max scrollable overflow (px) across scrollers on the page (0 = nothing to grow for). */
async function measureScrollOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    let delta = 0;
    document.querySelectorAll('*').forEach((el) => {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) {
        delta = Math.max(delta, el.scrollHeight - el.clientHeight);
      }
    });
    return delta;
  });
}

/**
 * Grow the viewport until no element scrolls vertically (the app's scroller is
 * .ui-shell__main). Offscreen nodes never become violations, so the scan is
 * only whole-page once nothing scrolls. #207 AC1: instead of falling out of
 * the loop silently after the iteration/cap budget, the helper reports
 * non-convergence so the shared gate can fail loud.
 */
export async function fitViewportToContent(page: Page, width: number): Promise<FitResult> {
  let need = await measureScrollOverflow(page);
  for (let i = 0; i < 6 && need > 0; i++) {
    const current = page.viewportSize()?.height ?? 900;
    const grown = Math.min(current + need, MAX_SCAN_HEIGHT);
    if (grown === current) break; // already at the cap: growing cannot help
    await page.setViewportSize({ width, height: grown });
    await page.waitForTimeout(150);
    need = await measureScrollOverflow(page);
  }
  return { converged: need <= 0, remainingScrollPx: need };
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
  /**
   * Test-only seam invoked ONCE after the initial grow loop and before the
   * stabilization re-measures. The #207 stabilization row uses it to append
   * late content at a row-controlled phase boundary (a wall-clock timer
   * could race the grow snapshot and make the row nondeterministic).
   * Optional: the production call sites never pass it.
   */
  onAfterGrow?: (page: Page) => Promise<void>;
  /** Passed in from the gate's own spec: it must stay an EMPTY map there. */
  knownBaseline: Record<string, unknown>;
  excludeSelector?: string;
}

/**
 * The axe gate contract end-to-end (#146 + #207): settle fonts/frames, GROW
 * the viewport until nothing scrolls, STABILIZE (re-fit while content keeps
 * arriving after the initial grow snapshot — the async-trickle race the
 * below-fold spec's own comment documents), then scan and fail loud on any
 * serious/critical node or any baseline entry. #207 AC1: a surface that
 * cannot converge within the grow budget makes the gate THROW naming the
 * surface — the scan never runs on a still-scrolling page (silently scanning
 * it degraded to the vacuous viewport-only pass #146 removed). The grow call
 * is load-bearing wiring — a viewport-only pass defers below-fold nodes as
 * `incomplete` and the gate goes vacuously green — so this function is where
 * the gate's scan semantics live, and lumen-axe-below-fold.spec.ts pins both
 * the behavior (planted below-fold violation must reject), the call-site
 * delegation, the convergence post-condition and the stabilization re-fit.
 */
export async function wholePageAxeExpectClean(page: Page, opts: WholePageAxeGateOptions): Promise<void> {
  await page.waitForTimeout(500);
  await settleFontsAndFrames(page);
  let fit = await fitViewportToContent(page, page.viewportSize()?.width ?? 1440);
  if (opts.onAfterGrow !== undefined) {
    await opts.onAfterGrow(page);
    // Late content deliberately models the async-trickle race: re-run the
    // grow so the stabilization contract holds even when the first fit had
    // already converged before the seam fired.
    fit = await fitViewportToContent(page, page.viewportSize()?.width ?? 1440);
  }
  for (let round = 0; round < STABILIZATION_ROUNDS && !fit.converged; round++) {
    // Content may arrive AFTER the grow snapshot (async sections trickling
    // in), re-covering the page below the fold. Re-measure, re-grow, bounded.
    await page.waitForTimeout(150);
    fit = await fitViewportToContent(page, page.viewportSize()?.width ?? 1440);
  }
  if (!fit.converged) {
    throw new Error(
      `axe whole-page gate ${opts.key} did not converge: ${fit.remainingScrollPx}px of ` +
        'scrollable content remains after the grow budget (iteration cap / MAX_SCAN_HEIGHT)',
    );
  }
  const found = await axeSeriousCriticalNodes(page, opts.excludeSelector);
  if (process.env.LUMEN_AXE_INVENTORY) {
    console.info(`AXE ${opts.key} ${JSON.stringify(found)}`);
  }
  expect(opts.knownBaseline[opts.key], `${opts.key} must never be baselined`).toBeUndefined();
  expect(found, `serious/critical axe nodes on ${opts.key}`).toEqual([]);
}
