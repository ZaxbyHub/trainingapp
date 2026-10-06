/**
 * Lumen phase 7: the in-chat model gate is a non-modal alertdialog over the chat page
 * only. Real-browser keyboard contract (jsdom ignores `inert` and Tab order):
 *  - Shift+Tab from the gate's first button lands IN the shell navigation (no trap);
 *  - a full forward Tab cycle from the gate's last button reaches the shell nav items
 *    and wraps back to the gate, and never lands in the covered chat content, which is
 *    inert. The cycle length is derived from the page (PR #151 review PRR-151-056/057:
 *    the old spec asserted only negatives over a fixed 13 presses).
 * Engine difference (observation only, PRR-151-030): at the END of the document Chromium moves
 * focus to the browser chrome (document.activeElement becomes the body), while Playwright's
 * Firefox has no chrome to move to and leaves focus where it is. The cycle test therefore
 * stands in for that one chrome stop on Firefox by blurring, and ONLY when the Tab provably
 * hit the document end: focus did not move, the focused element is the page's last tabbable
 * element, and the Tab keydown was not default-prevented (a page trap that swallows Tab is
 * still caught). Everything the cycle must reach, and must never enter, is identical.
 * Needs a build without staged weights (the gate must be up): it FAILS without a gate
 * unless LUMEN_ALLOW_NO_OVERLAY=1 (local builds with staged weights; refused under CI,
 * PRR-151-054). CI never stages them.
 */
import { expect, test, type Page } from '@playwright/test';
import { assertOverlayOptOutAllowed, requireModelGate } from './model-gate';

assertOverlayOptOutAllowed();

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await requireModelGate(page, 'Model not ready');
}

interface Focused {
  label: string;
  inContent: boolean;
  inGate: boolean;
  inShellNav: boolean;
}

/** What has focus (null for the document/body), and where it is. */
const focused = (page: Page): Promise<Focused | null> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    return {
      label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
      inContent: el.closest('.chat-page__content') !== null,
      inGate: el.closest('[role="alertdialog"]') !== null,
      inShellNav: el.closest('.ui-shell__sidebar, .ui-shell__topbar') !== null,
    };
  });

interface TabProbeWindow {
  /** Keyboard-reachable elements on the page (outside inert subtrees), in document order. */
  __tabbables(): HTMLElement[];
  /** The last Tab keydown seen by a window capture listener installed before the app's. */
  __lastTab?: KeyboardEvent;
}

/** Installed before the app boots: the tabbable list and the last Tab keydown (see TabProbeWindow). */
async function installTabProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as TabProbeWindow;
    w.__tabbables = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]')
      ).filter(
        (el) =>
          el.closest('[inert]') === null &&
          el.tabIndex >= 0 &&
          !(el as HTMLButtonElement).disabled &&
          el.getClientRects().length > 0
      );
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Tab') w.__lastTab = event;
      },
      true
    );
  });
}

/** Keyboard-reachable elements on the page: bounds a full Tab cycle. */
const tabbableCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as TabProbeWindow).__tabbables().length);

/**
 * Press Tab once. On Firefox, when the press provably hit the end of the document (focus
 * unchanged, on the page's LAST tabbable element, keydown not default-prevented), stand in
 * for the browser-chrome stop Chromium makes there: blur, so the next Tab re-enters the
 * document at its start exactly as it does in Chromium. Returns true when it did so.
 */
async function pressTab(page: Page, browserName: string): Promise<boolean> {
  const before = await page.evaluateHandle(() => document.activeElement);
  await page.evaluate(() => {
    delete (window as unknown as TabProbeWindow).__lastTab;
  });
  await page.keyboard.press('Tab');
  if (browserName !== 'firefox') return false;
  const atEnd = await page.evaluate((prev) => {
    const w = window as unknown as TabProbeWindow;
    const el = document.activeElement;
    const list = w.__tabbables();
    return (
      el === prev &&
      el !== null &&
      list.length > 0 &&
      list[list.length - 1] === el &&
      w.__lastTab !== undefined &&
      !w.__lastTab.defaultPrevented
    );
  }, before);
  await before.dispose();
  if (atEnd) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return atEnd;
}

test('Shift+Tab from the gate lands in the shell navigation', async ({ page }) => {
  await boot(page);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  const where = await focused(page);
  // Positive: focus is ON a shell control (not merely "not in the gate": the body would satisfy that).
  expect(where, 'Shift+Tab left focus on the document body').not.toBeNull();
  expect(where?.inShellNav, `Shift+Tab landed on ${JSON.stringify(where)}`).toBe(true);
  expect(where?.inGate).toBe(false);
  expect(where?.inContent).toBe(false);
});

test('a full Tab cycle from the gate reaches the shell nav, wraps back to the gate and never enters the inert chat content', async ({ page, browserName }) => {
  await installTabProbe(page);
  await boot(page);
  await page.getByRole('button', { name: 'Use a local server or cloud model' }).focus();
  const bound = (await tabbableCount(page)) + 2; // +2: the browser may park focus on the document once per wrap
  const seen: Array<Focused | null> = [];
  let documentEndStops = 0;
  for (let i = 0; i < bound; i++) {
    if (await pressTab(page, browserName)) documentEndStops += 1;
    const where = await focused(page);
    seen.push(where);
    expect(where?.inContent ?? false, `Tab #${i + 1} landed in the covered chat content: ${JSON.stringify(where)}`).toBe(false);
  }
  const sequence = JSON.stringify(seen.map((w) => w?.label ?? '<body>'));
  // Forward Tab from the last gate button leaves the gate (a trap would wrap to Retry).
  expect(seen[0]?.inGate ?? false, 'Tab from the last gate button stayed in the gate').toBe(false);
  // Positive destinations: the shell nav items, and back into the gate after wrapping.
  const labels = seen.map((w) => w?.label);
  for (const target of ['Chat', 'Documents', 'Training', 'Settings']) {
    expect(labels, `the Tab cycle never reached the "${target}" nav item: ${sequence}`).toContain(target);
  }
  expect(labels, `the Tab cycle never wrapped back to the gate: ${sequence}`).toContain('Retry');
  // Firefox: the stand-in fired (non-vacuous), and only at the document end (pressTab's guard).
  if (browserName === 'firefox') expect(documentEndStops, `Firefox document-end stops: ${sequence}`).toBeGreaterThanOrEqual(1);
});

test('activating Settings from the nav while the gate is up keeps focus there (not yanked back to the opener)', async ({ page }) => {
  await boot(page);
  const nav = page.locator('.ui-shell__sidebar');
  // Make the opener the Chat nav item: leave the gate's page, then come back with the keyboard.
  await nav.getByRole('button', { name: 'Documents', exact: true }).click();
  const chat = nav.getByRole('button', { name: 'Chat', exact: true });
  await chat.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog', { name: 'Model not ready' })).toBeVisible();
  // The user Tabs into the nav and activates Settings while the gate is up.
  const settings = nav.getByRole('button', { name: 'Settings', exact: true });
  await settings.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog', { name: 'Model not ready' })).toHaveCount(0);
  await expect(settings).toBeFocused();
  // Positive: the Settings surface actually rendered (the activation was not swallowed).
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});
