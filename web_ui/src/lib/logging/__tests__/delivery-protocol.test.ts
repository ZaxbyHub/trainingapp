/**
 * delivery-protocol.test.ts — issue #248: the renderer→main IPC forward is
 * STOP-AND-WAIT (at most one entry in flight; seq N+1 waits for seq N's ack),
 * preserves order across rejections (head requeue), and reconnects after a
 * failure. The main-side dedupe partner (ack-loss-after-write) is pinned in
 * desktop/src/__tests__/diagnostics-logging.test.ts. The transport/delivery
 * reply semantics (PRR-013/014/041/002) and the export bundle's
 * transport-facing shape (PRR-049/073/065) also land here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __deliveryStateForTests,
  __resetLoggingCoreForTests,
  admittedEntries,
  createLogger,
  RETRY_DELAY_MS,
  setConsoleSinks,
  setEnhancedLogging,
  setEntryForwarder,
} from '../index';
import { buildDiagnosticsBundle } from '../export';

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
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS + 70));
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
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS + 70));
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

  it('an admission during the retry backoff window does not bypass the delay (PRR-013)', async () => {
    const wire = deferringForwarder();
    setEntryForwarder(wire.forwarder);
    const log = createLogger('wire');
    log.info('first');
    await flushAsync();
    expect(wire.forwarder).toHaveBeenCalledTimes(1);
    wire.fail();
    // An admission DURING the backoff window must not re-send immediately
    // (the measured bypass re-sent 33ms into the 250ms delay).
    log.info('during-backoff');
    await new Promise((r) => setTimeout(r, 100));
    expect(wire.forwarder).toHaveBeenCalledTimes(1);
    // The timer re-pumps after the delay; the head-requeued 'first' retries first.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS + 120));
    expect(wire.sent.map((args) => (args[0] as { message: string }).message)).toEqual(['first', 'first']);
    wire.ack();
    await flushAsync();
    wire.ack();
    await flushAsync();
    expect(__deliveryStateForTests()).toEqual({ queued: 0, inFlight: false });
  });

  it('a resolved {ok:false} reply is honored: one-time warn, no requeue, the entry stays in the ring (PRR-014)', async () => {
    const errorSink = vi.fn();
    setConsoleSinks({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: errorSink,
    });
    const forwarder = vi.fn(async (_entry: unknown): Promise<unknown> => ({ ok: true }));
    forwarder.mockResolvedValueOnce({ ok: false, detail: 'malformed log entry' });
    setEntryForwarder(forwarder);
    const log = createLogger('wire');
    log.info('rejected-by-main');
    log.info('after');
    await flushAsync();
    // No requeue of the rejected entry: the NEXT entry sends immediately.
    expect(forwarder.mock.calls.map((c) => (c[0] as { message: string }).message)).toEqual([
      'rejected-by-main',
      'after',
    ]);
    expect(__deliveryStateForTests()).toEqual({ queued: 0, inFlight: false });
    // One-time warn through the console sink.
    const warns = errorSink.mock.calls.filter((c) => String(c[0]).includes('rejected by the main diagnostics sink'));
    expect(warns).toHaveLength(1);
    // The entry is historical fact and stays in the ring.
    expect(admittedEntries().map((e) => e.message)).toEqual(['rejected-by-main', 'after']);
  });

  it('a resolved persisted:false reply warns once; the entry is kept in the ring (PRR-002)', async () => {
    const errorSink = vi.fn();
    setConsoleSinks({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: errorSink,
    });
    const forwarder = vi.fn(async (_entry: unknown): Promise<unknown> => ({
      ok: true,
      persisted: false,
      detail: 'file transport disabled',
    }));
    setEntryForwarder(forwarder);
    const log = createLogger('wire');
    log.info('one');
    log.info('two');
    await flushAsync();
    // Delivered (ok:true) but named unpersisted: both stay in the ring, ONE warn.
    expect(admittedEntries().map((e) => e.message)).toEqual(['one', 'two']);
    const warns = errorSink.mock.calls.filter((c) => String(c[0]).includes('did not persist'));
    expect(warns).toHaveLength(1);
  });

  it('a forwarder that throws SYNCHRONOUSLY is treated like a rejection (PRR-041)', async () => {
    let throwOnce = true;
    const sent: unknown[][] = [];
    const forwarder = vi.fn((entry: unknown): Promise<unknown> => {
      sent.push([entry]);
      if (throwOnce) {
        throwOnce = false;
        throw new Error('sync throw escapes the call site');
      }
      return Promise.resolve({ ok: true });
    });
    setEntryForwarder(forwarder);
    const log = createLogger('wire');
    // The throw must not escape into the console call site...
    expect(() => log.info('first')).not.toThrow();
    // ...and the pump requeues + retries it after the backoff delay.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS + 120));
    expect(sent.map((a) => (a[0] as { message: string }).message)).toEqual(['first', 'first']);
    await flushAsync();
    expect(__deliveryStateForTests()).toEqual({ queued: 0, inFlight: false });
  });
});

describe('export bundle transport shape (PRR-049/073/065)', () => {
  it('carries platform "web" and the level at export; entries omit the delivery metadata sessionId/seq', () => {
    setEnhancedLogging(true);
    try {
      const log = createLogger('bundle');
      log.debug('debug-while-enhanced');
      log.info('info-entry');
      const bundle = JSON.parse(buildDiagnosticsBundle()) as {
        version: number;
        platform: string;
        levelAtExport: string;
        entries: Array<{ message: string; sessionId?: string; seq?: number }>;
      };
      expect(bundle.version).toBe(1);
      expect(bundle.platform).toBe('web');
      expect(bundle.levelAtExport).toBe('debug');
      expect(bundle.entries.map((e) => e.message)).toEqual(['debug-while-enhanced', 'info-entry']);
      for (const entry of bundle.entries) {
        expect('sessionId' in entry, 'delivery metadata must not leave the device').toBe(false);
        expect('seq' in entry, 'delivery metadata must not leave the device').toBe(false);
      }
    } finally {
      setEnhancedLogging(false);
    }
  });

  it('levelAtExport samples the LIVE level at build time, not the boot level', () => {
    const log = createLogger('bundle');
    log.info('entry');
    const atDefault = JSON.parse(buildDiagnosticsBundle()) as { levelAtExport: string };
    setEnhancedLogging(true);
    const atEnhanced = JSON.parse(buildDiagnosticsBundle()) as { levelAtExport: string };
    setEnhancedLogging(false);
    expect(atDefault.levelAtExport).toBe('info');
    expect(atEnhanced.levelAtExport).toBe('debug');
  });
});
