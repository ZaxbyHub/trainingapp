/**
 * inactivity-clear-two-tab-browser.spec.ts — issue #279 AC1 (check C8): the
 * shared-workstation inactivity auto-clear is ALL-OR-NOTHING in a real
 * Chromium two-tab session against the production build (vite preview of
 * dist).
 *
 * RED at base, GREEN after the fix (#279 B1): at base the idle tab's fire
 * ran its in-tab handler reset BEFORE the persisted clear's exclusive
 * arbitration — a DEFERRED clear (the colleague tab is active and holds the
 * shared session-active lock) still emptied the idle tab's pane, so the
 * next send in that tab persisted [user:NEW-QUESTION, assistant:...] and
 * destroyed the seeded four-message record (nothing had been cleared — the
 * deferral wrote nothing). After the fix the handler reset rides the
 * persisted clear's beforeClear seam: a deferred clear resets NOTHING, and
 * the send appends to the intact local state, so the stored record keeps
 * every seeded message.
 *
 * The inactivity threshold is the 1-minute floor the audit repro used,
 * configured through the existing Settings persistence key
 * (inactivity-timeout-min) before first load; the per-test timeout sits
 * above the idle wait. A same-origin external endpoint (never any model
 * weights) answers the send so the turn completes and persists.
 */
import { expect, test, type Page } from '@playwright/test';

const SEED_CONTENTS = [
  'SEED-Q1 what is the vacation policy',
  'SEED-A1 fifteen days per year',
  'SEED-Q2 what about carry-over',
  'SEED-A2 capped at five days',
];
const NEW_QUESTION = 'NEW-QUESTION';
const ASSISTANT_ANSWER = 'controls say hello';

/** Threshold floor in minutes (Settings clamps to 1..120; 0 disables). */
const THRESHOLD_MIN = 1;
/** Wall-clock idle window: threshold plus scheduler margin. */
const IDLE_WAIT_MS = (THRESHOLD_MIN * 60 + 20) * 1000;

test.describe('inactivity auto-clear across two tabs (issue #279)', () => {
  // The idle wait alone is ~80 s; boot + seeding + send add more. Size the
  // per-test timeout above the whole sequence without touching the global
  // config.
  test.describe.configure({ timeout: 240_000 });

  test('a deferred clear resets nothing: the idle tab keeps its state and the seeded messages survive the next send', async ({
    page: tabA,
    context,
    baseURL,
  }) => {
    const boot = async (page: Page): Promise<void> => {
      await page.route('**/*', (route) => {
        const host = new URL(route.request().url()).hostname;
        return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
      });
      // Registered last so it wins: the generation request is answered by a
      // JSON completion (no model weights, no network beyond the origin).
      await page.route('**/probe/v1/chat/completions', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ message: { content: ASSISTANT_ANSWER } }] }),
        }),
      );
      await page.addInitScript(({ base, threshold }) => {
        try {
          // The existing Settings persistence path for the threshold: the
          // same localStorage key the Settings page writes.
          localStorage.setItem('inactivity-timeout-min', String(threshold));
          localStorage.setItem(
            'external-provider-config',
            JSON.stringify({
              enabled: true,
              protocol: 'openai',
              baseUrl: `${base}/probe/v1`,
              model: 'probe-model',
              grounded: false,
              rememberKey: false,
            }),
          );
        } catch {
          /* ignore */
        }
      }, { base: baseURL, threshold: THRESHOLD_MIN });
      await page.goto('/');
      await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
        timeout: 60_000,
      });
    };

    // Tab A — the ACTIVE colleague: every activity event re-arms its watch
    // and keeps its SHARED session-active hold, so B's clear must defer.
    await boot(tabA);
    const tabB = await context.newPage();
    await boot(tabB);

    // Seed one conversation with four messages into the ACTIVE profile's
    // conversations db (same-origin storage is shared by both tabs).
    const prefix = await tabB.evaluate(() => localStorage.getItem('doc-qa-profile-id'));
    expect(prefix, 'profile id is minted at boot').toBeTruthy();
    const conversationId = 'e2e-two-tab-survival';
    await tabB.evaluate(
      async ({ now, contents, name, id }) => {
        const db = await new Promise<IDBDatabase>((res, rej) => {
          // Open WITHOUT a pinned version: Dexie 4 declares the app's v2
          // schema at native IndexedDB version 20 and a lower pinned open
          // VersionErrors.
          const r = indexedDB.open(name);
          r.onupgradeneeded = () => {
            if (!r.result.objectStoreNames.contains('conversations')) {
              r.result.createObjectStore('conversations', { keyPath: 'id' });
            }
            if (!r.result.objectStoreNames.contains('meta')) {
              r.result.createObjectStore('meta', { keyPath: 'key' });
            }
          };
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        await new Promise<void>((res, rej) => {
          const t = db.transaction('conversations', 'readwrite');
          t.objectStore('conversations').put({
            id,
            title: 'Two-tab survival',
            createdAt: now,
            updatedAt: now,
            mode: 'wllma',
            modelUsed: 'test',
            messages: contents.map((content: string, i: number) => ({
              id: `seed-${i}`,
              role: i % 2 === 0 ? 'user' : 'assistant',
              content,
              timestamp: now,
            })),
          });
          t.oncomplete = () => res();
          t.onerror = () => rej(t.error);
        });
        db.close();
      },
      { now: Date.now(), contents: SEED_CONTENTS, name: `${prefix}-doc-qa-conversations`, id: conversationId },
    );

    // Fresh load of B, then open the seeded conversation so B's pane and the
    // send path both target it. (Not page.reload(): under the app's COOP
    // same-origin header a same-URL navigation can hang; about:blank is the
    // same fresh load in every engine.)
    await tabB.goto('about:blank');
    await tabB.goto('/');
    await expect(tabB.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
      timeout: 60_000,
    });
    await tabB.getByText('Two-tab survival').click();
    await expect(tabB.getByText(SEED_CONTENTS[0], { exact: false })).toBeVisible({ timeout: 15_000 });

    // Keep A alive (activity resets A's watch and holds its shared lock)
    // while B idles past the threshold. A's periodic pointerdown is the
    // "colleague is active" signal that must defer B's clear.
    const deadline = Date.now() + IDLE_WAIT_MS;
    while (Date.now() < deadline) {
      await tabA.evaluate(() => window.dispatchEvent(new Event('pointerdown')));
      await tabA.waitForTimeout(5_000);
    }

    // The deferred fire reset NOTHING in B either: at base the idle tab's
    // pane was emptied by the pre-arbitration handler run (the audit repro's
    // observation) — after the fix the pane still shows the seeded turn.
    await expect(tabB.getByText(SEED_CONTENTS[0], { exact: false })).toBeVisible({ timeout: 5_000 });

    // The deferred clear wrote NOTHING (nothing was cleared) — the stored
    // record still holds every seeded message before the send.
    const storedBefore = await tabB.evaluate(readStoredMessages, {
      name: `${prefix}-doc-qa-conversations`,
      id: conversationId,
    });
    expect(storedBefore?.map((m: { content: string }) => m.content)).toEqual(SEED_CONTENTS);

    // Send in B after the deferral.
    await tabB.getByLabel('Message input').fill(NEW_QUESTION);
    await tabB.getByLabel('Message input').press('Enter');
    await expect(tabB.getByText(ASSISTANT_ANSWER, { exact: false })).toBeVisible({ timeout: 30_000 });

    // Read the stored record through the page: the four seeded messages
    // SURVIVE the send (at base the record became [user:NEW-QUESTION,
    // assistant:...] — the emptied pane overwrote the intact store).
    const stored = await tabB.evaluate(readStoredMessages, {
      name: `${prefix}-doc-qa-conversations`,
      id: conversationId,
    });
    const contents = (stored ?? []).map((m: { content: string }) => m.content);
    expect(contents).toEqual([...SEED_CONTENTS, NEW_QUESTION, ASSISTANT_ANSWER]);
  });
});

/** Read one conversation's message list straight from the profile db. */
function readStoredMessages(this: void, opts: { name: string; id: string }): Promise<Array<{ role: string; content: string }> | undefined> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(opts.name);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const t = db.transaction('conversations', 'readonly');
      const get = t.objectStore('conversations').get(opts.id);
      get.onsuccess = () => {
        const row = get.result as { messages?: Array<{ role: string; content: string }> } | undefined;
        db.close();
        resolve(row?.messages);
      };
      get.onerror = () => {
        db.close();
        reject(get.error);
      };
    };
  });
}
