/**
 * lumen-doc-row-reflow.spec.ts: a document row must reflow, never clip, at every
 * width its table can have (design-language.md section 3.5 "reflow without
 * horizontal scroll at 320 CSS px", WCAG 1.4.10).
 *
 * The layout switch is an `@container` query on the TABLE (pages/documents.css), so
 * the room a row has is the viewport minus the sidebar (64px rail or 260px
 * expanded) minus the page padding, not the viewport. Regression guards:
 *   - phase-6 fixed-track grid: a processing row was 592px wide at 320 and 500 and
 *     Cancel / Delete were clipped away by .app-doc-table { overflow: hidden };
 *   - viewport breakpoint (critic B1-residual): between 761 and ~925px with the
 *     260px sidebar the wide grid overflowed the narrower table and clipped
 *     Cancel / Delete / Confirm, and a long file name pushed Confirm out.
 *
 * Like lumen-tooltip-overflow.spec.ts this renders the REAL stylesheets
 * (lumen-tokens.css, ui.css, documents.css read from disk) against static markup
 * that mirrors DocumentList's DocumentItem. The breakpoint and row heights are
 * imported from components/documentRowLayout.ts (the constants DocumentList
 * virtualizes with) and checked against the real CSS rule, so the CSS, the
 * virtualization and this spec cannot drift apart. Markup class names are
 * drift-checked against the component source with comments stripped.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ITEM_HEIGHT, STACKED_ITEM_HEIGHT, STACKED_MAX_WIDTH } from '../../src/components/documentRowLayout';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DOCUMENTS_CSS = stripComments(read('../../src/pages/documents.css'));
const CSS = [
  stripComments(read('../../src/styles/lumen-tokens.css')),
  stripComments(read('../../src/ui/ui.css')),
  DOCUMENTS_CSS,
].join('\n');
const SOURCE = stripComments(read('../../src/components/DocumentList.tsx'));

const LONG_NAME = 'Employee-Handbook-2026-final-v2-with-a-very-long-name.pdf'; // 56 characters
const PILL = (text: string, tone: string): string =>
  `<span class="ui-visually-hidden">Status: </span><span class="ui-badge ui-badge--${tone} ui-status-pill">${text}</span>`;
const PROGRESS = '<div class="ui-progress app-doc__progress"><div class="ui-progress__fill" style="width:40%"></div></div>';
const BTN = (id: string, variant: string, label: string): string =>
  `<button type="button" class="ui-button ui-button--${variant} ui-button--sm" id="${id}">${label}</button>`;
const DELETE =
  '<div class="app-doc__actions"><button type="button" class="ui-button ui-icon-button ui-button--sm app-doc__delete" id="del">x</button></div>';
const confirmBlock = (name: string): string =>
  `<div role="alert" class="app-doc__confirm"><span class="app-doc__confirm-text">Delete ${name}?</span>${BTN('confirm', 'danger', 'Confirm')}${BTN('cancel', 'secondary', 'Cancel')}</div>`;

/** Controls that must stay inside the table, per state. */
const STATES: Record<string, { cells: string; controls: string[] }> = {
  ready: { cells: `<div class="app-doc__status">${PILL('Ready', 'success')}</div>${DELETE}`, controls: ['del'] },
  processing: {
    cells: `<div class="app-doc__status">${PILL('Processing...', 'info')}${PROGRESS}${BTN('cancel', 'secondary', 'Cancel')}</div>${DELETE}`,
    controls: ['cancel', 'del'],
  },
  uploading: {
    cells: `<div class="app-doc__status">${PILL('Uploading...', 'info')}${PROGRESS}</div>${DELETE}`,
    controls: ['del'],
  },
  error: {
    cells: `<div class="app-doc__status">${PILL('Error', 'danger')}<span class="app-doc__error">Failed to extract text: the PDF is encrypted or corrupt and could not be parsed by the indexer at all</span></div>${DELETE}`,
    controls: ['del'],
  },
  'confirm (short name)': { cells: confirmBlock('a.pdf'), controls: ['confirm', 'cancel'] },
  'confirm (56-char name)': { cells: confirmBlock(LONG_NAME), controls: ['confirm', 'cancel'] },
};

/** `main` is the area right of the sidebar, like the app shell's content column. */
const html = (cells: string, sidebar: number, itemHeight: number): string => `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<style>${CSS}\nbody{margin:0;font-family:sans-serif}</style></head><body>
<div style="display:flex;width:100%"><div style="flex:none;width:${sidebar}px"></div><main style="flex:1;min-width:0">
<div class="app-docs"><div class="app-doc-table"><div class="app-doc-list"><div class="app-doc-list__item" id="item" style="position:relative;height:${itemHeight}px">
<div class="app-doc" id="row">
  <div class="app-doc__icon"><svg class="ui-icon" width="20" height="20"></svg></div>
  <p class="app-doc__name">${LONG_NAME}</p>
  <span class="app-doc__meta"><span class="app-doc__date">Sep 30, 2026, 11:44 PM</span><span class="app-doc__size">117.2 KB</span><span class="app-doc__chunks">1234 chunks</span></span>
  ${cells}
</div></div></div></div></div></main></div></body></html>`;

test('CSS breakpoint and row heights match the constants DocumentList virtualizes with', () => {
  const rules = [...DOCUMENTS_CSS.matchAll(/@container\s*\(\s*max-width:\s*(\d+)px\s*\)\s*\{([\s\S]*?)\n\}/g)];
  expect(rules, 'exactly one @container rule').toHaveLength(1);
  expect(Number(rules[0][1])).toBe(STACKED_MAX_WIDTH);
  expect(new RegExp(`\\.app-doc\\s*\\{[^}]*\\bheight:\\s*${STACKED_ITEM_HEIGHT}px`).test(rules[0][2])).toBe(true);
  expect(
    new RegExp(`\\.app-doc\\s*\\{[^}]*\\bheight:\\s*${ITEM_HEIGHT}px`).test(DOCUMENTS_CSS.replace(rules[0][0], ''))
  ).toBe(true);
  expect(/\.app-doc-table\s*\{[^}]*container-type:\s*inline-size/.test(DOCUMENTS_CSS)).toBe(true);
});

test('markup mirrors DocumentList (drift check, comments stripped)', () => {
  for (const cls of [
    'app-doc__icon',
    'app-doc__name',
    'app-doc__meta',
    'app-doc__date',
    'app-doc__size',
    'app-doc__chunks',
    'app-doc__status',
    'app-doc__progress',
    'app-doc__error',
    'app-doc__actions',
    'app-doc__confirm',
    'app-doc__confirm-text',
  ]) {
    expect(SOURCE, cls).toContain(cls);
  }
});

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}
interface Measure {
  tableContentWidth: number;
  rowHeight: number;
  rowOverflowX: number;
  rowOverflowY: number;
  pageOverflowX: number;
  contentTop: number;
  contentBottom: number;
  contentRight: number;
  tableLeft: number;
  tableRight: number;
  itemTop: number;
  itemBottom: number;
  controls: Record<string, Box | null>;
}

/** The critic's clipping band is 761 / 800 / 850 / 901 with the 260px sidebar; 64 is the rail. */
const SIDEBARS = [64, 260];
const DRAWER_MAX_WIDTH = 768; // AppShell DRAWER_MEDIA_QUERY
const VIEWPORTS = [320, 360, 500, 640, 760, 761, 768, 800, 850, 901, 925, 1024, 1100, 1280, 1440];

for (const [state, spec] of Object.entries(STATES)) {
  test(`${state} row keeps every control inside the table (drawer, rail 64, sidebar 260)`, async ({ page }) => {
    const failures: string[] = [];
    let wide = 0;
    let stacked = 0;
    for (const width of VIEWPORTS) {
      // AppShell: at <= 768px the sidebar is an overlay drawer (no column); above it, 64px rail or 260px sidebar.
      for (const sidebar of width <= DRAWER_MAX_WIDTH ? [0] : SIDEBARS) {
        await page.setViewportSize({ width, height: 700 });
        // Pass 1: measure the container (table content box); pass 2: give the list item the row
        // height the virtualization derives from the SAME threshold.
        await page.setContent(html(spec.cells, sidebar, ITEM_HEIGHT));
        const tableContentWidth = await page.evaluate(() => {
          const table = document.querySelector('.app-doc-table') as HTMLElement;
          const style = getComputedStyle(table);
          return (
            table.getBoundingClientRect().width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
          );
        });
        const isStacked = tableContentWidth <= STACKED_MAX_WIDTH;
        if (isStacked) stacked += 1;
        else wide += 1;
        const itemHeight = isStacked ? STACKED_ITEM_HEIGHT : ITEM_HEIGHT;
        await page.setContent(html(spec.cells, sidebar, itemHeight));
        const m: Measure = await page.evaluate((ids) => {
          const table = document.querySelector('.app-doc-table') as HTMLElement;
          const tableRect = table.getBoundingClientRect();
          const tableStyle = getComputedStyle(table);
          const item = document.getElementById('item')!.getBoundingClientRect();
          const row = document.getElementById('row')!;
          let top = Infinity;
          let bottom = 0;
          let right = 0;
          for (const el of Array.from(row.querySelectorAll('*'))) {
            if (el.classList.contains('ui-visually-hidden')) continue;
            const box = el.getBoundingClientRect();
            if (box.width === 0 && box.height === 0) continue;
            top = Math.min(top, box.top);
            bottom = Math.max(bottom, box.bottom);
            right = Math.max(right, box.right);
          }
          const controls: Record<string, Box | null> = {};
          for (const id of ids) {
            const box = document.getElementById(id)?.getBoundingClientRect();
            controls[id] = box
              ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }
              : null;
          }
          return {
            tableContentWidth:
              tableRect.width - parseFloat(tableStyle.borderLeftWidth) - parseFloat(tableStyle.borderRightWidth),
            rowHeight: row.getBoundingClientRect().height,
            rowOverflowX: row.scrollWidth - row.clientWidth,
            rowOverflowY: row.scrollHeight - row.clientHeight,
            pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            contentTop: top,
            contentBottom: bottom,
            contentRight: right,
            tableLeft: tableRect.left,
            tableRight: tableRect.right,
            itemTop: item.top,
            itemBottom: item.bottom,
            controls,
          };
        }, spec.controls);
        const at = `sidebar ${sidebar} viewport ${width} (container ${Math.round(m.tableContentWidth)}px, ${isStacked ? 'stacked' : 'wide'})`;
        const fail = (why: string): number => failures.push(`${at}: ${why}`);
        // The CSS must have switched layout exactly where the virtualization height says it did.
        if (Math.abs(m.rowHeight - itemHeight) > 0.5) fail(`row is ${m.rowHeight}px, virtualization assumes ${itemHeight}px`);
        if (m.rowOverflowX > 0) fail(`row content wider than the row by ${m.rowOverflowX}px`);
        if (m.rowOverflowY > 0) fail(`row content taller than the row by ${m.rowOverflowY}px`);
        if (m.pageOverflowX > 0) fail(`page scrolls horizontally by ${m.pageOverflowX}px`);
        if (m.contentRight > m.tableRight + 0.5) fail(`content ${m.contentRight - m.tableRight}px past the table edge`);
        if (m.contentBottom > m.itemBottom + 0.5 || m.contentTop < m.itemTop - 0.5) fail('content leaves the row vertically');
        for (const id of spec.controls) {
          const c = m.controls[id];
          if (c === null || c === undefined) {
            fail(`${id} missing`);
            continue;
          }
          if (c.right > m.tableRight + 0.5 || c.left < m.tableLeft - 0.5) fail(`${id} outside the table horizontally`);
          if (c.bottom > m.itemBottom + 0.5 || c.top < m.itemTop - 0.5) fail(`${id} outside the row vertically`);
          if (c.width < 8) fail(`${id} squeezed to ${c.width}px`);
        }
      }
    }
    expect(failures).toEqual([]);
    // Non-vacuous: the sweep covered both layouts.
    expect(wide).toBeGreaterThan(0);
    expect(stacked).toBeGreaterThan(0);
  });
}

// The breakpoint itself, exactly: the container is STACKED_MAX_WIDTH wide (stacked) or one
// px wider (wide). Page padding is 24px a side above 500px viewports, the table border 1px.
for (const [label, extra, expectHeight] of [
  ['at the breakpoint (stacked)', 0, STACKED_ITEM_HEIGHT],
  ['one px above the breakpoint (wide)', 1, ITEM_HEIGHT],
] as const) {
  test(`processing and 56-char confirm rows fit ${label}`, async ({ page }) => {
    await page.setViewportSize({ width: STACKED_MAX_WIDTH + extra + 2 + 48, height: 700 }); // sidebar 0
    for (const state of ['processing', 'confirm (56-char name)']) {
      await page.setContent(html(STATES[state].cells, 0, expectHeight));
      const m = await page.evaluate(() => {
        const row = document.getElementById('row')!;
        const table = document.querySelector('.app-doc-table') as HTMLElement;
        const style = getComputedStyle(table);
        const tableRight = table.getBoundingClientRect().right;
        const rights = ['confirm', 'cancel', 'del']
          .map((id) => document.getElementById(id)?.getBoundingClientRect().right)
          .filter((right): right is number => right !== undefined);
        return {
          content:
            table.getBoundingClientRect().width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
          rowHeight: row.getBoundingClientRect().height,
          overflowX: row.scrollWidth - row.clientWidth,
          overflowY: row.scrollHeight - row.clientHeight,
          clipped: rights.filter((right) => right > tableRight + 0.5).length,
        };
      });
      expect(m.content, `${state} container width`).toBe(STACKED_MAX_WIDTH + extra);
      expect(m.rowHeight, `${state} row height`).toBe(expectHeight);
      expect(m.overflowX, `${state} overflow x`).toBeLessThanOrEqual(0);
      expect(m.overflowY, `${state} overflow y`).toBeLessThanOrEqual(0);
      expect(m.clipped, `${state} clipped controls`).toBe(0);
    }
  });
}
