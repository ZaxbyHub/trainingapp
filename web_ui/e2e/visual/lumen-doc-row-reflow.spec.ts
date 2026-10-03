/**
 * lumen-doc-row-reflow.spec.ts: a document row must reflow, never clip, at narrow
 * widths (design-language.md section 3.5 "reflow without horizontal scroll at 320
 * CSS px", WCAG 1.4.10). Regression guard for the phase-6 fixed-track grid, where a
 * processing row was 592px wide at 320 and 500 and its Cancel and Delete controls
 * were clipped away by .app-doc-table { overflow: hidden }.
 *
 * Like lumen-tooltip-overflow.spec.ts this renders the REAL stylesheets
 * (lumen-tokens.css, ui.css, documents.css read from disk) against static markup
 * that mirrors DocumentList's DocumentItem (class names are drift-checked against
 * the component source below). The row sits in the same fixed-height list item the
 * virtualized list uses (STACKED_ITEM_HEIGHT), so vertical clipping is caught too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const CSS = ['../../src/styles/lumen-tokens.css', '../../src/ui/ui.css', '../../src/pages/documents.css']
  .map(read)
  .join('\n');
const SOURCE = read('../../src/components/DocumentList.tsx');

const STATUS = {
  ready: '<span class="ui-badge ui-badge--success ui-status-pill">Ready</span>',
  processing:
    '<span class="ui-badge ui-badge--info ui-status-pill">Processing...</span>' +
    '<div class="ui-progress app-doc__progress"><div class="ui-progress__fill" style="width:40%"></div></div>' +
    '<button type="button" class="ui-button ui-button--secondary ui-button--sm" id="cancel">Cancel</button>',
} as const;

const html = (state: keyof typeof STATUS, itemHeight: number): string => `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<style>${CSS}\nbody{margin:0;font-family:sans-serif}</style></head><body>
<div class="app-docs"><div class="app-doc-table"><div class="app-doc-list"><div class="app-doc-list__item" id="item" style="height:${itemHeight}px">
<div class="app-doc" id="row">
  <div class="app-doc__icon"><svg class="ui-icon" width="20" height="20"></svg></div>
  <p class="app-doc__name">Employee-Handbook-2026-final-v2.pdf</p>
  <span class="app-doc__meta"><span class="app-doc__date">Oct 3, 2026, 01:44 PM</span><span class="app-doc__size">117.2 KB</span><span class="app-doc__chunks">12 chunks</span></span>
  <div class="app-doc__status">${STATUS[state]}</div>
  <div class="app-doc__actions"><button type="button" class="ui-button ui-icon-button ui-button--sm" id="del">x</button></div>
</div></div></div></div></div></body></html>`;

test('markup mirrors DocumentList (drift check)', () => {
  for (const cls of ['app-doc__meta', 'app-doc__date', 'app-doc__size', 'app-doc__chunks', 'app-doc__status', 'app-doc__actions']) {
    expect(SOURCE, cls).toContain(cls);
  }
  const height = /STACKED_ITEM_HEIGHT = (\d+)/.exec(SOURCE)?.[1];
  expect(height).toBeDefined();
  expect(read('../../src/pages/documents.css')).toContain(`height: ${height}px`);
});

for (const state of ['ready', 'processing'] as const) {
  for (const width of [320, 500, 640]) {
    test(`${state} row at ${width}px keeps every control inside the table`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.setContent(html(state, 112));
      const m = await page.evaluate(() => {
        const box = (id: string) => document.getElementById(id)?.getBoundingClientRect() ?? null;
        const table = document.querySelector('.app-doc-table')!.getBoundingClientRect();
        const item = document.getElementById('item')!.getBoundingClientRect();
        const row = document.getElementById('row')!;
        return {
          table: { left: table.left, right: table.right },
          itemBottom: item.bottom,
          rowOverflowX: row.scrollWidth - row.clientWidth,
          rowOverflowY: row.scrollHeight - row.clientHeight,
          pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          del: box('del'),
          cancel: box('cancel'),
        };
      });
      expect(m.rowOverflowX, 'row content wider than the row').toBeLessThanOrEqual(0);
      expect(m.rowOverflowY, 'row content taller than the fixed row height').toBeLessThanOrEqual(0);
      expect(m.pageOverflowX, 'page scrolls horizontally').toBeLessThanOrEqual(0);
      const controls = state === 'processing' ? [m.del, m.cancel] : [m.del];
      for (const c of controls) {
        expect(c).not.toBeNull();
        expect(c!.left).toBeGreaterThanOrEqual(m.table.left - 0.5);
        expect(c!.right).toBeLessThanOrEqual(m.table.right + 0.5);
        expect(c!.bottom).toBeLessThanOrEqual(m.itemBottom + 0.5);
      }
    });
  }
}
