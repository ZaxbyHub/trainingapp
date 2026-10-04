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
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const LONG_MODEL = 'an-extremely-long-model-identifier-for-truncation-checks-v1-instruct-q4_k_m';

async function boot(page: Page, baseURL: string, model = 'probe-model', external = true): Promise<void> {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
  });
  // Registered last, so it wins: the generation request is held open forever.
  await page.route('**/probe/v1/**', () => {
    /* never fulfilled */
  });
  await page.addInitScript(({ base, model, external }) => {
    if (!external) return;
    try {
      localStorage.setItem(
        'external-provider-config',
        JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: `${base}/probe/v1`, model, grounded: false, rememberKey: false })
      );
    } catch {
      /* ignore */
    }
  }, { base: baseURL, model, external });
  await page.goto('/');
  await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, { timeout: 60_000 });
}

/** One conversation whose answer carries two structured citations, then reload. */
async function seedCitedConversation(page: Page, longNames = false, onlyFirst = false): Promise<void> {
  await page.evaluate(async ({ now, longNames, onlyFirst }) => {
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
              { docId: 'd1', chunkIndex: 0, source: longNames ? 'A-very-long-employee-handbook-document-name-number-1.pdf' : 'Employee-Handbook.pdf', page: 4, text: onlyFirst ? 'New hires receive 15 days. '.repeat(40) : 'New hires receive 15 days.' },
              { docId: 'd2', chunkIndex: 0, source: longNames ? 'A-very-long-employee-handbook-document-name-number-2.pdf' : 'Benefits-Overview.pdf', page: 2, text: longNames ? 'Carry-over is capped. '.repeat(40) : 'Carry-over is capped.' },
            ].slice(0, onlyFirst ? 1 : 2),
          },
        ],
      });
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
    db.close();
  }, { now: NOW, longNames, onlyFirst });
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

  test('PRE-4: a lone short chip still opens a full-width popover (list is column-wide, not chip-wide)', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await boot(page, baseURL!);
    await seedCitedConversation(page, false, true);

    const pill = page.getByRole('button', { name: /^Source 1:/ });
    await pill.click();
    const popover = page.locator('.chat-cite__popover');
    await expect(popover).toBeVisible();
    const box = (await popover.boundingBox())!;
    // Capped at 480px; with a chip-wide containing block it collapsed to ~160px.
    expect(box.width).toBeGreaterThanOrEqual(400);
  });

  test('rail chip tooltip opens upward inside the viewport on focus, with an accessible name (axe clean)', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await boot(page, baseURL!, LONG_MODEL);
    const rail = page.locator('.app-sidebar__connection--rail button');
    await expect(rail).toBeVisible();
    await rail.focus();
    const tip = page.getByRole('tooltip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(LONG_MODEL);
    const box = (await tip.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    expect(box.x + box.width).toBeLessThanOrEqual(1024);
    const axe = await new AxeBuilder({ page }).withRules(['aria-tooltip-name', 'aria-valid-attr-value', 'duplicate-id-aria']).analyze();
    expect(axe.violations.map((v) => `${v.id}:${v.nodes.length}`)).toEqual([]);
  });

  test('chip tooltips are hoverable: the pointer can cross the gap onto the tooltip without closing it (rail and header)', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await boot(page, baseURL!, LONG_MODEL);
    for (const [name, locator] of [
      ['rail', page.locator('.app-sidebar__connection--rail button')],
      ['header', page.getByTestId('chat-model-chip')],
    ] as const) {
      await locator.hover();
      const tip = page.getByRole('tooltip');
      await expect(tip, `${name} tooltip opens`).toBeVisible();
      const trigger = (await locator.boundingBox())!;
      const box = (await tip.boundingBox())!;
      // Move in small steps from the trigger centre to the tooltip centre (crossing the gap).
      const from = { x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height / 2 };
      const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.move(to.x, to.y, { steps: 25 });
      await expect(tip, `${name} tooltip stays open over the tooltip`).toBeVisible();
      // Leaving both closes it.
      await page.mouse.move(600, 450, { steps: 5 });
      await expect(tip, `${name} tooltip closes when the pointer leaves`).toBeHidden();
    }
  });

  test('header chip with a very long model name ellipsizes inside the header at 500px and 768px', async ({ page, baseURL }) => {
    await boot(page, baseURL!, LONG_MODEL);
    for (const width of [500, 768]) {
      await page.setViewportSize({ width, height: 900 });
      const m = await page.evaluate(() => {
        const chip = document.querySelector('[data-testid="chat-model-chip"]') as HTMLElement;
        const name = chip.querySelector('.chat-model-chip__name') as HTMLElement;
        const header = chip.closest('.ui-page-header') as HTMLElement;
        return { chipRight: chip.getBoundingClientRect().right, headerRight: header.getBoundingClientRect().right, truncated: name.scrollWidth > name.clientWidth };
      });
      expect(m.chipRight, `chip inside header @ ${width}`).toBeLessThanOrEqual(m.headerRight + 0.5);
      expect(m.truncated, `name ellipsized @ ${width}`).toBe(true);
    }
  });

  test('header chip keeps the "not ready" suffix visible and inside the header at 500px and 360px (local model, no external endpoint)', async ({ page, baseURL }) => {
    await boot(page, baseURL!, 'probe-model', false);
    // Local-mode names are short, so this does NOT discriminate the .chat-header-actions
    // shrink rule (verified: it still passes without it); the long-name ellipsis test above
    // is the guard for that rule. This one pins the suffix + header containment at narrow widths.
    for (const width of [500, 360]) {
      await page.setViewportSize({ width, height: 900 });
      const suffix = page.getByTestId('chat-model-chip-suffix');
      await expect(suffix).toBeVisible();
      const chip = (await page.getByTestId('chat-model-chip').boundingBox())!;
      const s = (await suffix.boundingBox())!;
      expect(s.x + s.width, `suffix inside chip @ ${width}`).toBeLessThanOrEqual(chip.x + chip.width + 0.5);
      const header = (await page.locator('.ui-page-header').boundingBox())!;
      expect(chip.x + chip.width, `chip inside header @ ${width}`).toBeLessThanOrEqual(header.x + header.width + 0.5);
    }
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
