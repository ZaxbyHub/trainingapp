/**
 * Shared model-gate helpers for the Playwright specs (PR #151 review PRR-151-003,
 * -025, -054, -063, -073). One copy instead of four, with post-conditions, so a
 * gate that is still visible, or chat content that is still inert, fails the spec
 * instead of letting axe skip the inert subtree (green while auditing nothing) or a
 * screenshot capture the gate.
 *
 * What hideModelGate does to the page, stated exactly: it hides every model-gate
 * backdrop (display:none via data-lumen-hidden) and REMOVES the gate's `inert` from
 * `.chat-page__content`, for the rest of that page's life. It is not restored: each
 * spec that calls it then scans or captures the surface as if no gate were up, and
 * the page is discarded with the test. The gated state itself (gate up, content
 * inert) is what the 'overlay' axe pass, the overlay-model-not-ready baselines and
 * e2e/model-gate-keyboard.spec.ts cover.
 */
import { expect, test, type Page } from '@playwright/test';

/**
 * LUMEN_ALLOW_NO_OVERLAY=1 lets a LOCAL build with staged weights (no gate) skip the
 * gate-dependent checks. It must never be set in CI (which never stages weights):
 * there it would turn a gate regression into a silent skip, so it throws (PRR-151-054).
 * Called at module load by every spec that honours the opt-out.
 */
export function assertOverlayOptOutAllowed(): void {
  const raw = process.env.LUMEN_ALLOW_NO_OVERLAY;
  if (raw !== undefined && raw !== '' && process.env.CI) {
    throw new Error(
      `LUMEN_ALLOW_NO_OVERLAY=${raw} is set while CI=${process.env.CI}: the model-gate opt-out is for local builds with staged weights only.`
    );
  }
}

/** True when the local opt-out is on (and allowed; see assertOverlayOptOutAllowed). */
export function overlayOptOut(): boolean {
  assertOverlayOptOutAllowed();
  return process.env.LUMEN_ALLOW_NO_OVERLAY === '1';
}

/**
 * Wait until the chat page is up (the gate or, absent a gate, the composer), then
 * require the gate. Without it the test FAILS, unless the local opt-out is on, in
 * which case it is skipped.
 */
export async function requireModelGate(page: Page, name?: string): Promise<void> {
  const gate = page.getByRole('alertdialog', name === undefined ? {} : { name });
  await expect(gate.or(page.getByLabel('Message input')).first()).toBeVisible({ timeout: 60_000 });
  const present = (await gate.count()) > 0;
  if (!present && overlayOptOut()) test.skip(true, 'overlay opt-out (LUMEN_ALLOW_NO_OVERLAY=1)');
  expect(present, 'model gate must render; set LUMEN_ALLOW_NO_OVERLAY=1 only for local builds with staged weights').toBe(true);
}

/**
 * Post-condition, also re-run immediately before every scan/capture: no visible
 * alertdialog and no inert chat content. A gate that mounted after the hide (and
 * re-made the content inert) fails here.
 */
export async function expectModelGateHidden(page: Page): Promise<void> {
  await expect(page.getByRole('alertdialog'), 'a model gate is still visible over the surface').toHaveCount(0);
  await expect(page.locator('.chat-page__content[inert]'), 'the chat content is still inert (axe would skip it)').toHaveCount(0);
}

/**
 * Hide the model gate so the surface underneath can be scanned/captured (see the
 * header). With `expectGate`, the gate must be up first (requireModelGate): use it
 * on the chat page. Without it the hide is tolerant (after navigating away the
 * chat page, and its gate, are unmounted). Either way the post-condition holds on
 * return.
 */
export async function hideModelGate(page: Page, { expectGate }: { expectGate: boolean }): Promise<void> {
  if (expectGate) await requireModelGate(page);
  await page.evaluate(() => {
    document.querySelectorAll('[role="alertdialog"]').forEach((el) => {
      (el.closest('[data-testid="ui-dialog-backdrop"]') ?? el).setAttribute('data-lumen-hidden', '1');
    });
    document.querySelectorAll('.chat-page__content[inert]').forEach((el) => el.removeAttribute('inert'));
  });
  await page.addStyleTag({ content: '[data-lumen-hidden="1"]{display:none !important}' });
  await expectModelGateHidden(page);
}

/** Web fonts loaded and two animation frames rendered (layout settled after font swap). */
export async function settleFontsAndFrames(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}
