/**
 * lumen-doc-list-scroll.spec.ts: the REAL DocumentList, in the real app, keeps the
 * same row at the top of its scroller (and keyboard focus on that row control)
 * when the table crosses the 800px container-query breakpoint (stacked 112px rows
 * <-> wide 60px rows). Review B-1 / L-1.
 *
 * Why a real browser: switching to the 60px height shrinks the virtualization
 * placeholder, and the browser clamps scrollTop to the new maximum before any
 * layout effect can read it. jsdom cannot model that, and the static-markup
 * lumen-doc-row-reflow.spec.ts never runs the useItemHeight hook, so it cannot see
 * the inline row height disagree with the rendered one.
 *
 * Seeds 80 documents into the profile IndexedDB, opens Documents with the
 * sidebar collapsed (64px rail), and drives the viewport: 800px is stacked and
 * 1000px is wide.
 */
import { expect, test, type Page } from '@playwright/test';
import { ITEM_HEIGHT, STACKED_ITEM_HEIGHT, STACKED_MAX_WIDTH } from '../../src/components/documentRowLayout';

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const COUNT = 80;
// scrollTop is whole pixels and the row index is fractional (the 1px table border shifts it
// by a hair), so a switch may land up to a couple of px off the exact row boundary: a
// row with <= SLIVER px showing is not the top row, and the offset tolerance matches.
const SLIVER = 4;
const name = (i: number): string => `Doc-${String(i).padStart(3, '0')}.pdf`;

async function boot(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
  });
  await page.addInitScript(() => {
    localStorage.setItem('sidebarOpen', 'false');
  });
  await page.goto('/');
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, { timeout: 60_000 });
  const prefix = await page.evaluate(() => localStorage.getItem('doc-qa-profile-id'));
  await page.evaluate(
    async ({ prefix, now, count }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(`${prefix}-doc-qa-documents`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('documents', 'readwrite');
          tx.objectStore('documents').put({
            id: `d${i}`,
            fileName: `Doc-${String(i).padStart(3, '0')}.pdf`,
            fileSize: 120000,
            fileType: 'application/pdf',
            status: 'ready',
            progress: 100,
            chunkCount: 12,
            uploadedAt: now - i * 1000,
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
      db.close();
    },
    { prefix, now: NOW, count: COUNT }
  );
  await page.reload();
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, { timeout: 60_000 });
  // The model-blocked overlay (when present) is irrelevant here and covers the page.
  await page.evaluate(() =>
    document.querySelectorAll('[role="alertdialog"]').forEach((el) => {
      ((el.parentElement ?? el) as HTMLElement).style.display = 'none';
    })
  );
  await page.getByRole('button', { name: 'Documents', exact: true }).first().click({ force: true });
  await page.waitForSelector('.app-doc');
}

const settle = (page: Page): Promise<unknown> =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))))
  );

const resizeTo = async (page: Page, width: number): Promise<void> => {
  await page.setViewportSize({ width, height: 760 });
  await settle(page);
};

interface Snapshot {
  /** File name of the first row with more than a SLIVER of itself visible. */
  first: string | null | undefined;
  /** That row's top edge relative to the scroller's top edge (0 = flush). */
  firstOffset: number;
  itemHeight: number;
  renderedHeight: number;
  tableWidth: number;
  active: string | null | undefined;
}

const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate((sliver) => {
    const table = document.querySelector('.app-doc-table') as HTMLElement;
    const region = document.querySelector('.app-docs__list-region') as HTMLElement;
    const items = Array.from(document.querySelectorAll<HTMLElement>('.app-doc-list__item'));
    const regionTop = region.getBoundingClientRect().top;
    const first = items
      .filter((item) => item.getBoundingClientRect().bottom > regionTop + sliver)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    const style = getComputedStyle(table);
    const inset = [style.borderLeftWidth, style.borderRightWidth, style.paddingLeft, style.paddingRight].reduce(
      (sum, value) => sum + (parseFloat(value) || 0),
      0
    );
    const active = document.activeElement;
    return {
      first: first?.querySelector('.app-doc__name')?.textContent,
      firstOffset: first ? first.getBoundingClientRect().top - regionTop : Number.NaN,
      itemHeight: items[0] ? parseFloat(items[0].style.height) : -1,
      renderedHeight: items[0] ? (items[0].firstElementChild as HTMLElement).offsetHeight : -1,
      tableWidth: table.getBoundingClientRect().width - inset,
      active: active === document.body ? 'BODY' : active?.getAttribute('aria-label'),
    };
  }, SLIVER);

const scrollToRow = async (page: Page, row: number): Promise<void> => {
  await page.evaluate((top) => {
    (document.querySelector('.app-docs__list-region') as HTMLElement).scrollTop = top;
  }, row * STACKED_ITEM_HEIGHT);
  await settle(page);
};

for (const [row, label] of [[60, 'row 60'], [70, 'row 70 with focus on its Delete button']] as const) {
  test(`${label} of 80 stays at the top across the breakpoint`, async ({ page }) => {
    test.setTimeout(120_000);
    await resizeTo(page, 800);
    await boot(page);
    await resizeTo(page, 800);
    expect((await snapshot(page)).itemHeight).toBe(STACKED_ITEM_HEIGHT);

    // Deep enough that the wide layout (60px rows) has a smaller maximum scrollTop
    // than the stacked position: the browser clamps it the moment the row height
    // changes, so only a position captured before the switch survives.
    await scrollToRow(page, row);
    expect((await snapshot(page)).first).toBe(name(row));
    const control = `Delete ${name(row)}`;
    if (row === 70) {
      await page.getByRole('button', { name: control }).focus();
      expect((await snapshot(page)).active).toBe(control);
    }

    await resizeTo(page, 1000);
    const wide = await snapshot(page);
    expect(wide.itemHeight).toBe(ITEM_HEIGHT);
    expect(wide.first).toBe(name(row));
    expect(Math.abs(wide.firstOffset)).toBeLessThanOrEqual(SLIVER);
    if (row === 70) expect(wide.active).toBe(control);

    await resizeTo(page, 800);
    const back = await snapshot(page);
    expect(back.itemHeight).toBe(STACKED_ITEM_HEIGHT);
    expect(back.first).toBe(name(row));
    expect(Math.abs(back.firstOffset)).toBeLessThanOrEqual(SLIVER);
    if (row === 70) expect(back.active).toBe(control);
  });
}

test('the inline row height equals the rendered row height on both sides of the 800/801 boundary', async ({ page }) => {
  test.setTimeout(180_000);
  await resizeTo(page, 1000);
  await boot(page);
  const seen = new Set<string>();
  // Table content width is the viewport minus the rail, page padding, borders and
  // any classic scrollbar, so sweep a band around 800 + that chrome.
  for (let width = 880; width <= 960; width += 2) {
    await resizeTo(page, width);
    const s = await snapshot(page);
    const stackedLayout = s.tableWidth <= STACKED_MAX_WIDTH;
    const where = `viewport ${width}, table ${s.tableWidth}px`;
    expect(s.itemHeight, where).toBe(stackedLayout ? STACKED_ITEM_HEIGHT : ITEM_HEIGHT);
    expect(s.renderedHeight, where).toBe(s.itemHeight);
    seen.add(stackedLayout ? 'stacked' : 'wide');
  }
  // The sweep must actually straddle the boundary or it proves nothing.
  expect([...seen].sort()).toEqual(['stacked', 'wide']);
});
