/**
 * Settings-page layout guardrail (trace external-llm-provider-settings,
 * Phase 4.2 port of frozen checks C6/C7's DOM-metric assertions).
 *
 * Guards the two layout-defect classes the trace fixed:
 *   1. radio-card title/description text overlap (the negative-margin
 *      descriptionStyle class) — asserted via pairwise bounding-box checks;
 *   2. nested scrollers / header-content intersection — exactly ONE scroller
 *      may own the settings content and the H1 must never intersect a section.
 *
 * Runs the REAL Electron app against `vite preview` of the production
 * renderer (stub engine + hash embedder; no weights), same recipe as
 * renderer-smoke.spec.ts.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';

let storeDir: string;
let storePath: string;

test.beforeAll(() => {
  storeDir = mkdtempSync(path.join(os.tmpdir(), 'settings-layout-store-'));
  storePath = path.join(storeDir, 'profiles', 'default', 'store.sqlite');
  mkdirSync(path.dirname(storePath), { recursive: true });
});

test.afterAll(() => {
  try {
    rmSync(storeDir, { recursive: true, force: true });
  } catch {
    /* windows tmp cleanup race is fine in teardown */
  }
});

async function closeApp(app: ElectronApplication): Promise<void> {
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 8_000))]);
  try {
    if (app.process().exitCode === null) {
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  } catch {
    /* process already gone */
  }
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      ELECTRON_START_URL: 'http://127.0.0.1:4173',
      TRAININGAPP_DESKTOP_DEV_ORIGINS: 'http://127.0.0.1:4173',
      TRAININGAPP_DESKTOP_ENGINE: 'stub',
      TRAININGAPP_DESKTOP_EMBEDDER: 'hash',
      TRAININGAPP_DESKTOP_STORE_PATH: storePath,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2_000);
  return { app, page };
}

async function walkWizard(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const next = page.getByTestId('wizard-next');
    if ((await next.count()) && (await next.first().isVisible().catch(() => false))) {
      await next.first().click();
      await page.waitForTimeout(350);
      continue;
    }
    const activate = page.getByTestId('activate-packs-button');
    if ((await activate.count()) && (await activate.first().isVisible().catch(() => false))) {
      await activate.first().click();
      await page.waitForTimeout(1_200);
      continue;
    }
    const complete = page.getByTestId('wizard-complete');
    if ((await complete.count()) && (await complete.first().isVisible().catch(() => false))) {
      await complete.first().click();
      await page.waitForTimeout(700);
      continue;
    }
    const finish = page.getByTestId('wizard-finish');
    if ((await finish.count()) && (await finish.first().isVisible().catch(() => false))) {
      await finish.first().click();
      await page.waitForTimeout(700);
      return;
    }
    break;
  }
}

interface Overlap {
  a: string;
  b: string;
  x: number;
  y: number;
}

async function measure(page: Page): Promise<{ scrollers: number; overlaps: Overlap[] }> {
  return page.evaluate(() => {
    // Scroll census: visible overflow-y containers that actually overflow,
    // among the ancestors of the settings content.
    let contentHost: Element | null = null;
    for (const el of document.querySelectorAll('main section')) {
      contentHost = el;
      break;
    }
    let scrollers = 0;
    let node: Element | null = contentHost;
    while (node) {
      const s = getComputedStyle(node);
      if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 1) {
        scrollers += 1;
      }
      node = node.parentElement;
    }
    // H1 vs section intersections at the CURRENT scroll offsets.
    const overlaps: Overlap[] = [];
    const h1 = document.querySelector('main h1');
    if (h1) {
      const a = h1.getBoundingClientRect();
      for (const section of document.querySelectorAll('main section, main fieldset')) {
        const b = section.getBoundingClientRect();
        if (b.width < 10 || b.height < 10) continue;
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 4 && y > 4) {
          overlaps.push({
            a: 'h1',
            b: (section.textContent ?? '').trim().slice(0, 40),
            x: Math.round(x),
            y: Math.round(y),
          });
        }
      }
    }
    return { scrollers, overlaps };
  });
}

test.describe.serial('settings layout guardrail', () => {
  test('radio cards do not overlap and one scroller owns the page (1280x800)', async () => {
    const { app, page } = await launchApp();
    try {
      await walkWizard(page);
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Settings', exact: true })
        .click();
      // Sections mount after the settingsLoaded effect — await real content
      // before measuring, or the overlap/scroller assertions pass vacuously.
      await expect(page.getByRole('heading', { name: 'Response Quality' })).toBeVisible({
        timeout: 15_000,
      });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(400);

      // (1) No radio-card title/description intersection at any viewport.
      for (const width of [1280, 460]) {
        await page.setViewportSize({ width, height: width === 1280 ? 800 : 900 });
        await page.waitForTimeout(350);
        const cardOverlaps = await page.evaluate(() => {
          const out: string[] = [];
          let cards = 0;
          for (const card of document.querySelectorAll('label')) {
            const input = card.querySelector('input[type="radio"]');
            if (!input) continue;
            const span = card.querySelector('span');
            const desc = card.querySelector('p');
            if (!span || !desc) continue;
            cards += 1;
            const a = span.getBoundingClientRect();
            const b = desc.getBoundingClientRect();
            const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (x > 2 && y > 2) {
              out.push(
                `OVERLAP: ${span.textContent} <-> ${(desc.textContent ?? '').slice(0, 30)} {x: ${Math.round(x)}, y: ${Math.round(y)}}`
              );
            }
          }
          return { out, cards };
        });
        expect(
          cardOverlaps.cards,
          `radio cards must render at ${width}px (vacuous-guard)`
        ).toBeGreaterThan(0);
        expect(
          cardOverlaps.out,
          `radio-card overlaps at ${width}px: ${cardOverlaps.out.join('; ')}`
        ).toEqual([]);
      }

      // (2) One scroller owns the content; H1 never intersects sections at
      // multiple scroll offsets.
      const scrollTargets = await page.evaluate(() => {
        const hosts: HTMLElement[] = [];
        for (const el of document.querySelectorAll('main, div')) {
          const s = getComputedStyle(el);
          if (s.overflowY === 'auto' && el.scrollHeight > el.clientHeight + 1) hosts.push(el);
        }
        return hosts.length;
      });
      expect(scrollTargets).toBeGreaterThan(0);
      for (const offset of [0, 400, 1_000_000]) {
        await page.evaluate((off) => {
          const scroller = document.querySelector('main');
          if (scroller) scroller.scrollTop = Math.min(off, scroller.scrollHeight);
        }, offset);
        await page.waitForTimeout(200);
        const metrics = await measure(page);
        expect(
          metrics.overlaps,
          `H1/section overlaps at scroll offset ${offset}: ${JSON.stringify(metrics.overlaps)}`
        ).toEqual([]);
      }
      const finalMetrics = await measure(page);
      expect(
        finalMetrics.scrollers,
        'exactly one scroller may own the settings content'
      ).toBe(1);
    } finally {
      await closeApp(app);
    }
  });
});
