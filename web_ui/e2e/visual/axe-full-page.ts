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
 * After the grow snapshot the gate RE-MEASURES in bounded rounds on EVERY
 * path (production surfaces included - content may arrive after the
 * snapshot, so a first fit that converged is not proof that the page
 * settled). The re-measure is what re-grows the viewport when late content
 * lands below the fold.
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
  /** Selector of the scroller with the largest overflow (operator diagnostics). */
  worstSelector: string | null;
  /** Which budget stopped the grow loop (null while the page still fits). */
  budget: 'iteration-cap' | 'max-scan-height' | null;
}

/** One overflow measurement: the worst scroller's overflow and its selector. */
interface OverflowMeasurement {
  px: number;
  selector: string | null;
}

/** Max scrollable overflow (px) across scrollers on the page (0 = nothing to grow for). */
async function measureScrollOverflow(page: Page): Promise<OverflowMeasurement> {
  return page.evaluate(() => {
    let delta = 0;
    let worst: string | null = null;
    document.querySelectorAll('*').forEach((el) => {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) {
        const over = el.scrollHeight - el.clientHeight;
        if (over > delta) {
          delta = over;
          // A stable, human-readable handle for the failing pane: id first,
          // then the first two classes, then the tag name.
          const id = el.getAttribute('id');
          const cls = (el.getAttribute('class') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .join('.');
          worst = id !== null && id !== '' ? `#${id}` : cls !== '' ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
        }
      }
    });
    return { px: delta, selector: worst };
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
  let measured = await measureScrollOverflow(page);
  let budget: FitResult['budget'] = null;
  for (let i = 0; i < 6 && measured.px > 0; i++) {
    const current = page.viewportSize()?.height ?? 900;
    const grown = Math.min(current + measured.px, MAX_SCAN_HEIGHT);
    if (grown === current) {
      budget = 'max-scan-height';
      break; // already at the cap: growing cannot help
    }
    await page.setViewportSize({ width, height: grown });
    await page.waitForTimeout(150);
    measured = await measureScrollOverflow(page);
  }
  if (measured.px > 0 && budget === null) budget = 'iteration-cap';
  return {
    converged: measured.px <= 0,
    remainingScrollPx: measured.px,
    worstSelector: measured.selector,
    budget,
  };
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
   * The seam ONLY appends content: re-measuring and re-growing it is the
   * stabilization loop's job, so the loop stays load-bearing for every
   * caller. Optional: the production call sites never pass it.
   */
  onAfterGrow?: (page: Page) => Promise<void>;
  /** Passed in from the gate's own spec: it must stay an EMPTY map there. */
  knownBaseline: Record<string, unknown>;
  excludeSelector?: string;
}

/** What the gate did, for the rows that pin the gate's own behaviour. */
export interface WholePageAxeGateResult {
  /**
   * How many post-snapshot re-measure rounds the gate ran. ALWAYS >= 1: the
   * gate re-measures after the grow snapshot on EVERY path (production
   * surfaces included), because content may arrive after the snapshot.
   */
  stabilizationRounds: number;
  converged: boolean;
  remainingScrollPx: number;
}

/**
 * The axe gate contract end-to-end (#146 + #207): settle fonts/frames, GROW
 * the viewport until nothing scrolls, RE-MEASURE (bounded rounds - content
 * may arrive after the grow snapshot, the async-trickle race the below-fold
 * spec's own comment documents), then scan and fail loud on any
 * serious/critical node or any baseline entry. #207 AC1: a surface that
 * cannot converge within the grow budget makes the gate THROW naming the
 * surface — the scan never runs on a still-scrolling page (silently scanning
 * it degraded to the vacuous viewport-only pass #146 removed). The grow call
 * is load-bearing wiring — a viewport-only pass defers below-fold nodes as
 * `incomplete` and the gate goes vacuously green — so this function is where
 * the gate's scan semantics live, and lumen-axe-below-fold.spec.ts pins both
 * the behavior (planted below-fold violation must reject), the call-site
 * delegation, the convergence post-condition, the stabilization re-fit and
 * the fact that a NO-SEAM call still re-measures.
 *
 * The stabilization rounds are UNCONDITIONAL: a fit that already converged
 * still gets re-measured, because late content is exactly the case where the
 * first fit converged and the page starts scrolling again afterwards.
 */
export async function wholePageAxeExpectClean(page: Page, opts: WholePageAxeGateOptions): Promise<WholePageAxeGateResult> {
  await page.waitForTimeout(500);
  await settleFontsAndFrames(page);
  const width = page.viewportSize()?.width ?? 1440;
  let fit = await fitViewportToContent(page, width);
  if (opts.onAfterGrow !== undefined) {
    // The seam only APPENDS late content; the stabilization rounds below are
    // the single re-measure mechanism, so the loop - not a second fit here -
    // is what re-fits the late content.
    await opts.onAfterGrow(page);
  }
  let stabilizationRounds = 0;
  let lastHeight = page.viewportSize()?.height ?? 0;
  for (let round = 0; round < STABILIZATION_ROUNDS; round++) {
    // Content may arrive AFTER the grow snapshot (async sections trickling
    // in), re-covering the page below the fold. Re-measure, re-grow, bounded.
    await page.waitForTimeout(150);
    fit = await fitViewportToContent(page, width);
    stabilizationRounds += 1;
    const height = page.viewportSize()?.height ?? 0;
    const grew = height !== lastHeight;
    lastHeight = height;
    // Settled: nothing moved and nothing scrolls - further rounds would only
    // re-measure the same settled page.
    if (!grew && fit.converged) break;
  }
  if (!fit.converged) {
    throw new Error(
      `axe whole-page gate ${opts.key} did not converge: ${fit.remainingScrollPx}px of ` +
        `scrollable content remains after the grow budget (${fit.budget ?? 'unknown budget'}` +
        (fit.worstSelector !== null ? `, worst scroller ${fit.worstSelector}` : '') +
        ')',
    );
  }
  const found = await axeSeriousCriticalNodes(page, opts.excludeSelector);
  if (process.env.LUMEN_AXE_INVENTORY) {
    console.info(`AXE ${opts.key} ${JSON.stringify(found)}`);
  }
  expect(opts.knownBaseline[opts.key], `${opts.key} must never be baselined`).toBeUndefined();
  expect(found, `serious/critical axe nodes on ${opts.key}`).toEqual([]);
  return {
    stabilizationRounds,
    converged: fit.converged,
    remainingScrollPx: fit.remainingScrollPx,
  };
}
