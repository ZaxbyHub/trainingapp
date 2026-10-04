/**
 * chat-reflow-browser.spec.ts — Lumen phase 5 (design-language.md sections 3.5, 5)
 * CSS-driven Chat behaviour that unit tests (jsdom: no media queries, no layout)
 * cannot prove:
 *   - at <= 500px the citation chips are collapsed behind an "N sources" count chip
 *     and become visible only after it is pressed; above 500px the chips show and
 *     the count chip does not;
 *   - the composer card's status row collapses (:empty -> display:none) when idle,
 *     shows the streaming indicator while a turn is generating, and collapses again
 *     after Stop.
 *
 * A same-origin "external endpoint" that never answers keeps the turn generating
 * without model weights (and lifts the local-model gate), so the run needs no
 * staged weights and no network. Run under web_ui/playwright.config.ts.
 */
import { expect, test, type Page } from '@playwright/test';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

async function boot(page: Page, baseURL: string): Promise<void> {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
  });
  // Registered last, so it wins: the generation request is held open forever.
  await page.route('**/probe/v1/**', () => {
    /* never fulfilled */
  });
  await page.addInitScript((base) => {
    try {
      localStorage.setItem(
        'external-provider-config',
        JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: `${base}/probe/v1`, model: 'probe-model', grounded: false, rememberKey: false })
      );
    } catch {
      /* ignore */
    }
  }, baseURL);
  await page.goto('/');
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, { timeout: 60_000 });
}

/** One conversation whose answer carries two structured citations, then reload. */
async function seedCitedConversation(page: Page, longNames = false): Promise<void> {
  await page.evaluate(async ({ now, longNames }) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('docqa_conversations');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise<void>((res, rej) => {
      const t = db.transaction('conversations', 'readwrite');
      t.objectStore('conversations').put({
        id: 'c-reflow',
        title: 'Reflow',
        createdAt: now,
        updatedAt: now,
        mode: 'wllama',
        modelUsed: 'test',
        messages: [
          { id: 'u1', role: 'user', content: 'How many vacation days?', timestamp: now },
          {
            id: 'a1',
            role: 'assistant',
            content: 'Fifteen days [1][2].',
            timestamp: now,
            grounding: 'grounded',
            citations: [
              { docId: 'd1', chunkIndex: 0, source: longNames ? 'A-very-long-employee-handbook-document-name-number-1.pdf' : 'Employee-Handbook.pdf', page: 4, text: 'New hires receive 15 days.' },
              { docId: 'd2', chunkIndex: 0, source: longNames ? 'A-very-long-employee-handbook-document-name-number-2.pdf' : 'Benefits-Overview.pdf', page: 2, text: longNames ? 'Carry-over is capped. '.repeat(40) : 'Carry-over is capped.' },
            ],
          },
        ],
      });
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
    db.close();
  }, { now: NOW, longNames });
  await page.reload();
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText('Fifteen days', { exact: false })).toBeVisible({ timeout: 15_000 });
}

test.describe('chat reflow (Lumen phase 5)', () => {
  // boot() waits up to 60s for the search services to initialise, and the seeded
  // tests wait for it twice (boot + reload) plus a 15s render wait. Playwright's
  // 30s default test timeout would cut those waits short, so size it to cover the
  // worst case (60 + 60 + 15 s plus the interactions) without touching the global
  // config.
  test.describe.configure({ timeout: 180_000 });

  test('<= 500px: citation chips stay hidden until the "N sources" chip is pressed', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 500, height: 900 });
    await boot(page, baseURL!);
    await seedCitedConversation(page);

    const toggle = page.getByRole('button', { name: '2 sources' });
    const first = page.getByRole('button', { name: /^Source 1:/ });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The chips are in the DOM (not a vacuous pass) but collapsed.
    await expect(page.locator('.chat-cite__pill')).toHaveCount(2);
    await expect(page.locator('.chat-cite__pill').first()).toBeHidden();
    await expect(first).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(first).toBeVisible();
    await expect(page.getByRole('button', { name: /^Source 2:/ })).toBeVisible();

    await toggle.click();
    await expect(first).toBeHidden();
  });

  test('> 500px: the chips show directly and the count chip is not rendered visibly', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await boot(page, baseURL!);
    await seedCitedConversation(page);
    await expect(page.getByRole('button', { name: /^Source 1:/ })).toBeVisible();
    // The count chip exists in the DOM (so this is not a vacuous pass) but is display:none.
    const countChip = page.locator('button.chat-cites__toggle');
    await expect(countChip).toHaveCount(1);
    await expect(countChip).toHaveText('2 sources');
    await expect(countChip).toBeHidden();
  });

  test('PRE-4: an opened source popover stays inside the viewport and adds no horizontal scroll', async ({ page, baseURL }) => {
    // 600px: chips are visible (> 500px) and the second long-named chip starts far enough
    // right that a pill-anchored 60vw popover used to overflow the chat log.
    await page.setViewportSize({ width: 600, height: 900 });
    await boot(page, baseURL!);
    await seedCitedConversation(page, true);

    await page.getByRole('button', { name: /^Source 2:/ }).click();
    const popover = page.locator('.chat-cite__popover');
    await expect(popover).toBeVisible();
    const box = (await popover.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(600);
    const overflow = await page.locator('.chat-log').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBe(0);
  });

  test('the composer status row collapses when idle and shows while generating', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await boot(page, baseURL!);
    const status = page.locator('.chat-composer__status');
    await expect(status).toBeHidden();
    expect(await status.evaluate((el) => getComputedStyle(el).display)).toBe('none');

    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.fill('Hello');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop generation' })).toBeVisible({ timeout: 10_000 });
    await expect(status).toBeVisible();
    await expect(status.getByTestId('streaming-indicator')).toBeVisible();

    await page.getByRole('button', { name: 'Stop generation' }).click();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(status).toBeHidden();
  });
});
