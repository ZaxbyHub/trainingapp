/**
 * Fallback chain-tail pin (PR #285 review PRR-005, rounds 1-2; NOT frozen).
 *
 * Pins the in-tab fallback's tail lifecycle when a waiter's acquisition
 * bound trips while other callers are queued behind it:
 *   1. a queued waiter publishes its own claim at scheduling time, so a
 *      caller arriving during the wait serializes behind it;
 *   2. on timeout the claim DEFERS to the predecessor's settlement — a
 *      caller already chained on the claim keeps waiting under its own
 *      bound and never starts while the predecessor still holds the name;
 *   3. once the predecessor settles, the deferred claim releases and the
 *      queued caller runs — the bound bounds WAITING, it does not strand
 *      the name.
 * (The frozen C3 spec pins the two-caller bounds; this file pins the
 * three-caller tail lifecycle the review found.)
 */

import { describe, it, expect, vi } from 'vitest';
import { withExclusiveLock } from './exclusive-lock';

describe('exclusive-lock fallback tail lifecycle (PRR-005 pin)', () => {
  it('a caller queued behind a waiter that times out keeps waiting until the predecessor settles', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The stuck predecessor holds the name.
    const stuck = withExclusiveLock('docqa-tail-stuck', async () => {
      order.push('s:start');
      await gate;
      order.push('s:end');
    }, { lockManager: null, acquireTimeoutMs: 5_000 });

    // Drain scheduling so `stuck` is the published predecessor.
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['s:start']);

    // The waiter times out at 50ms while `stuck` still holds the name.
    const waiter = withExclusiveLock('docqa-tail-stuck', async () => {
      order.push('w:start');
    }, { lockManager: null, acquireTimeoutMs: 50 });
    const waiterSettled = waiter.then(() => 'ran', () => 'timeout');

    // A caller queued BEHIND the waiter, during the wait window, with a
    // bound LONGER than the waiter's: it must NOT be released by the
    // waiter's timeout (the round-2 defect shape) — it waits for the
    // predecessor under its own bound.
    const queued = withExclusiveLock('docqa-tail-stuck', async () => {
      order.push('q:start');
      order.push('q:end');
    }, { lockManager: null, acquireTimeoutMs: 60_000 });
    const queuedSettled = queued.then(() => 'ran', () => 'timeout');

    // Past the waiter's bound: the waiter gave up, the predecessor still
    // holds, and the queued caller must not have started (the deferred
    // claim did not settle at the waiter's give-up).
    await vi.advanceTimersByTimeAsync(60);
    expect(await waiterSettled).toBe('timeout');
    expect(order).toEqual(['s:start']);
    expect(order.includes('q:start')).toBe(false);

    // The predecessor settles: the deferred claim releases and the queued
    // caller runs — serialized after the predecessor, never concurrent.
    release!();
    await vi.advanceTimersByTimeAsync(0);
    await stuck;
    await queuedSettled.then((v) => expect(v).toBe('ran'));
    expect(order).toEqual(['s:start', 's:end', 'q:start', 'q:end']);

    vi.useRealTimers();
  });

  it('a waiter that is granted publishes its claim so a caller arriving mid-section serializes behind it', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withExclusiveLock('docqa-tail-grant', async () => {
      order.push('a:start');
      await gate;
      order.push('a:end');
    }, { lockManager: null });

    // The waiter queues, is granted after `first` settles, and runs.
    const waiter = withExclusiveLock('docqa-tail-grant', async () => {
      order.push('b:start');
      await gate;
      order.push('b:end');
    }, { lockManager: null });

    // Release `first`; the waiter is granted and enters its section.
    release!();
    await first;
    await vi.waitFor(() => expect(order).toContain('b:start'));

    // A caller arriving DURING the waiter's section must serialize behind
    // it (the round-1 defect shape: it used to start concurrently).
    const third = withExclusiveLock('docqa-tail-grant', async () => {
      order.push('c:start');
      order.push('c:end');
    }, { lockManager: null });

    release!();
    await Promise.all([waiter, third]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });
});
