/**
 * lumen-axe-below-fold.spec.ts — the tripwire for the whole-page scan geometry
 * of the Lumen axe gates (issue #146).
 *
 * lumen-axe.spec.ts historically scanned each surface from a 900px-tall viewport, and
 * axe-core reports offscreen nodes as `incomplete`, never as violations: any
 * contrast failure below the first fold passed CI. The surface scans now grow
 * the viewport until nothing scrolls before axe runs (e2e/visual/
 * axe-full-page.ts fitViewportToContent). This spec pins that geometry: on the
 * Settings surface (the app's tall, scroll-settling page — the chat hero's
 * min-height follows the viewport, so a planted node there would chase it) it
 * plants a deliberate serious color-contrast violation ~3000px below the last
 * section and requires the shared full-page scan to REPORT it. With the
 * geometry reverted to a single 900px pass the row goes red (the node stays
 * offscreen and axe defers it) — never by baselining or exempting it.
 *
 * Runs in CI with the a11y subset (`lumen-axe` matches this file by name; see
 * README.md), and the title carries the `axe` token so the frozen C4 command
 * (`lumen-axe -g "axe"`) runs it too.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { axeSeriousCriticalNodes, fitViewportToContent, wholePageAxeExpectClean } from './axe-full-page';
import { assertOverlayOptOutAllowed, hideModelGate, settleFontsAndFrames } from '../model-gate';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

// PRR-151-054: the LUMEN_ALLOW_NO_OVERLAY opt-out is refused under CI.
assertOverlayOptOutAllowed();

test.describe.configure({ timeout: 180_000 });

async function openSettings(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    return route.abort();
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('theme-preference', 'light');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
    timeout: 60_000,
  });
  await page.evaluate(() => document.fonts.ready);
  // Scan Settings itself, not the model-gate overlay stacked on it (tolerant:
  // after navigating away the chat page and its gate are unmounted).
  await hideModelGate(page, { expectGate: false });
  await page.getByRole('button', { name: 'Settings', exact: true }).click({ force: true });
  await page.mouse.move(0, 0);
  await expect(page.getByRole('heading', { name: 'About' })).toBeAttached();
}

test.describe('axe below-fold geometry', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });

  test('the full-page axe scan reports a below-fold color-contrast violation', async ({ page }) => {
    await openSettings(page);

    // Plant the violation ~3000px below the last Settings section, inside the
    // app's scroller (.ui-shell__main, overflow auto): light gray text on a
    // white background is ~1.9:1, a serious color-contrast failure wherever
    // it sits. Settings' sections are natural-height, so the grown viewport
    // settles instead of chasing the content.
    const planted = await page.evaluate(() => {
      const scroller = document.querySelector('.ui-shell__main') ?? document.body;
      const spacer = document.createElement('div');
      spacer.style.height = '3000px';
      const node = document.createElement('p');
      node.id = 'below-fold-violation';
      node.textContent = 'deliberate below-fold contrast violation planted for the axe gate geometry check';
      node.style.color = '#cfcfcf';
      node.style.background = '#ffffff';
      scroller.append(spacer, node);
      return { scroller: scroller.tagName, top: node.getBoundingClientRect().top };
    });
    // Non-vacuous geometry: the node starts below the initial 900px fold, so a
    // single fixed-viewport pass could never see it.
    expect(planted.scroller, 'the app scroller exists (.ui-shell__main)').toBe('MAIN');
    expect(planted.top, 'the planted node starts below the initial fold').toBeGreaterThan(900);

    await page.waitForTimeout(500);
    await settleFontsAndFrames(page);
    await fitViewportToContent(page, 1440);
    // Settings content still trickles in asynchronously (the Updates note and
    // friends) and can push the planted node back below the fold AFTER the
    // grow loop settled; re-fit, bounded, until the node is really on screen.
    for (let i = 0; i < 6; i++) {
      const b = await page.locator('#below-fold-violation').boundingBox();
      const vhNow = page.viewportSize()?.height ?? 0;
      if (b !== null && b.y + b.height <= vhNow) break;
      await page.waitForTimeout(250);
      await fitViewportToContent(page, 1440);
    }
    // Non-vacuous geometry: after the grow loop the node is on screen.
    const vh = page.viewportSize()?.height ?? 0;
    const box = await page.locator('#below-fold-violation').boundingBox();
    expect(box, 'the planted node has a box after the viewport grew').not.toBeNull();
    expect((box?.y ?? Infinity) + (box?.height ?? 0), 'the planted node is inside the grown viewport').toBeLessThanOrEqual(vh);

    // The tripwire: the shared full-page scan reports the planted node as a
    // serious violation instead of deferring it as offscreen.
    await settleFontsAndFrames(page);
    const found = await axeSeriousCriticalNodes(page);
    expect(found, 'the below-fold violation is reported by the whole-page scan').toContain('color-contrast | #below-fold-violation');
  });
});

test.describe('axe gate wiring (issue #146: the gate itself must grow)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });

  test('gate wiring: the shared whole-page gate rejects a planted below-fold violation', async ({ page }) => {
    await openSettings(page);

    // Absolute-positioned plant (containing block = the scroller after
    // position:relative): later async Settings content cannot push it down,
    // and the row itself NEVER calls fitViewportToContent — a row-side grow
    // would mask the exact wiring under test. With the gate's own grow call
    // removed or neutralized the viewport stays 900px, axe defers the plant
    // as offscreen `incomplete`, and the gate goes vacuously green — which is
    // what makes this row the named killer for that mutant.
    const planted = await page.evaluate(() => {
      const scroller = document.querySelector('.ui-shell__main') ?? document.body;
      scroller.setAttribute('style', `${scroller.getAttribute('style') ?? ''};position:relative`);
      const node = document.createElement('p');
      node.id = 'below-fold-violation';
      node.textContent = 'deliberate below-fold contrast violation planted for the axe gate wiring check';
      node.style.position = 'absolute';
      node.style.top = '2500px';
      node.style.color = '#cfcfcf';
      node.style.background = '#ffffff';
      scroller.append(node);
      return { scroller: scroller.tagName, top: node.getBoundingClientRect().top };
    });
    expect(planted.scroller, 'the app scroller exists (.ui-shell__main)').toBe('MAIN');
    expect(planted.top, 'the planted node starts below the initial fold').toBeGreaterThan(900);

    await expect(
      wholePageAxeExpectClean(page, { key: 'below-fold-wiring', knownBaseline: {} }),
    ).rejects.toThrow(/below-fold-violation/);
  });

  test('gate wiring: lumen-axe expectAxeClean delegates to the shared whole-page gate', () => {
    // Source pin for the call-site twin: the behavioral row above covers the
    // gate's internals, this covers the delegation every surface scan rides
    // on. Named mutant: revert expectAxeClean to the old viewport-only body
    // (drop the delegation call) — every C4 surface row then scans 900px only
    // and stays green, so only this row can see that revert.
    const source = fs.readFileSync(path.join(THIS_DIR, 'lumen-axe.spec.ts'), 'utf8');
    // Line-anchored code shape (leading indent + await, no comment marker):
    // a comment-only mention cannot satisfy it.
    expect(source, 'lumen-axe.spec.ts must route expectAxeClean through wholePageAxeExpectClean').toMatch(
      /^ {2}await wholePageAxeExpectClean\(page, \{ key, knownBaseline: KNOWN_BASELINE/m,
    );
  });
});
