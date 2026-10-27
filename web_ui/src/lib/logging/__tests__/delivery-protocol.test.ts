/**
 * delivery-protocol.test.ts — issue #248: the renderer→main IPC forward is
 * STOP-AND-WAIT (at most one entry in flight; seq N+1 waits for seq N's ack),
 * preserves order across rejections (head requeue), and reconnects after a
 * failure. The main-side dedupe partner (ack-loss-after-write) is pinned in
 * desktop/src/__tests__/diagnostics-logging.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __deliveryStateForTests,
  __resetLoggingCoreForTests,
  createLogger,
  setConsoleSinks,
  setEntryForwarder,
} from '../index';

/** Deferring forwarder: resolve/reject the in-flight send from the test. */
function deferringForwarder() {
  const sent: unknown[][] = [];
  let pending: { resolve: () => void; reject: (err: Error) => void } | null = null;
  const forwarder = vi.fn(
    (entry: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        sent.push([entry]);
        pending = { resolve: () => resolve({ ok: true }), reject };
      }),
  );
  return {
    forwarder,
    sent,
    ack: () => {
      pending?.resolve();
      pending = null;
    },
    fail: () => {
      pending?.reject(new Error('ack lost'));
      pending = null;
    },
  };
}

function flushAsync(times = 4): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) chain = chain.then(() => new Promise<void>((r) => setTimeout(r, 0)));
  return chain;
}

beforeEach(() => {
  __resetLoggingCoreForTests();
  setConsoleSinks({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
});

afterEach(() => {
  __resetLoggingCoreForTests();
});

describe('stop-and-wait delivery protocol', () => {
  it('keeps at most ONE entry in flight; seq N+1 sends only after seq N acks', async () => {
    const wire = deferringForwarder();
    setEntryForwarder(wire.forwarder);
    const log = createLogger('wire');
    log.info('first');
    log.info('second');
    log.info('third');
    await flushAsync();
    expect(wire.forwarder).toHaveBeenCalledTimes(1);
    expect(__deliveryStateForTests()).toEqual({ queued: 2, inFlight: true });

    wire.ack();
    await flushAsync();
    expect(wire.forwarder).toHaveBeenCalledTimes(2);
    expect(__deliveryStateForTests()).toEqual({ queued: 1, inFlight: true });

    wire.ack();
    await flushAsync();
    expect(wire.forwarder).toHaveBeenCalledTimes(3);
    wire.ack();
    await flushAsync();
    expect(__deliveryStateForTests()).toEqual({ queued: 0, inFlight: false });
  });

  it('a rejection requeues at the head so order is preserved across the retry', async () => {
    const wire = deferringForwarder();
    setEntryForwarder(wire.forwarder);
    const log = createLogger('wire');
    log.info('first');
    log.info('second');
    await flushAsync();
    // Reject the in-flight FIRST; after the retry delay it must resend FIRST,
    // then SECOND — never out of order.
    wire.fail();
    await new Promise((r) => setTimeout(r, 320));
    expect(wire.sent.map((args) => (args[0] as { message: string }).message)).toEqual(['first', 'first']);
    wire.ack();
    await flushAsync();
    expect(wire.sent.map((args) => (args[0] as { message: string }).message)).toEqual([
      'first',
      'first',
      'second',
    ]);
    wire.ack();
    await flushAsync();
    expect(__deliveryStateForTests()).toEqual({ queued: 0, inFlight: false });
  });

  it('reconnects: after a failure the queue keeps draining and later entries flow', async () => {
    const wire = deferringForwarder();
    setEntryForwarder(wire.forwarder);
    const log = createLogger('wire');
    log.info('a');
    await flushAsync();
    wire.fail();
    await new Promise((r) => setTimeout(r, 320));
    wire.ack(); // retry of 'a' succeeds
    await flushAsync();
    wire.ack(); // drain continues (nothing else queued yet)
    await flushAsync();
    expect(__deliveryStateForTests()).toEqual({ queued: 0, inFlight: false });
    log.info('b');
    await flushAsync();
    expect(wire.sent.map((args) => (args[0] as { message: string }).message)).toEqual(['a', 'a', 'b']);
    wire.ack();
    await flushAsync();
  });

  it('entries carry {sessionId, seq} with monotonic seq for main-side dedupe', async () => {
    const wire = deferringForwarder();
    setEntryForwarder(wire.forwarder);
    const log = createLogger('wire');
    log.info('a');
    log.info('b');
    await flushAsync();
    wire.ack();
    await flushAsync();
    wire.ack();
    await flushAsync();
    const entries = wire.sent.map((args) => args[0] as { sessionId: string; seq: number; message: string });
    expect(entries.map((e) => e.message)).toEqual(['a', 'b']);
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(new Set(entries.map((e) => e.sessionId)).size).toBe(1);
  });
});
