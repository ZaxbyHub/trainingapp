/**
 * Tests for TokenStreamManager class
 *
 * Updated for issue #36 (S4) new contracts:
 *   - cancel() now FLUSHES buffered tokens via the callback BEFORE clearing
 *     (previously it dropped them). Stop must deliver every token received
 *     up to the cancel.
 *   - pushToken overflow now flushes the buffer (preserving token order)
 *     instead of splicing the oldest unflushed tokens out.
 *   - scheduleFlush uses a setTimeout fallback when the document is hidden.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenStreamManager } from '../streaming/TokenStreamManager';

// Mock the SSEStreamConsumer
vi.mock('../api/streaming', () => ({
  SSEStreamConsumer: vi.fn().mockImplementation(() => ({
    onToken: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('TokenStreamManager', () => {
  let manager: TokenStreamManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    manager = new TokenStreamManager();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe('Constructor', () => {
    it('initializes with empty token buffer', () => {
      expect(manager).toBeDefined();
    });

    it('initializes with cancelled as false', () => {
      expect(manager).toBeDefined();
    });
  });

  describe('onToken callback', () => {
    it('registers token callback', () => {
      const callback = vi.fn();
      manager.onToken(callback);

      manager.pushToken('Hello');
      manager.pushToken('World');

      // Tokens are buffered and flushed via RAF
      vi.advanceTimersByTime(100);

      expect(callback).toHaveBeenCalled();
    });

    it('last-registered token callback wins (onToken overwrites)', () => {
      // onToken() assigns (overwrites) the single token callback slot rather
      // than subscribing; registering a second callback replaces the first.
      // This documents the actual contract so callers know not to stack
      // multiple token callbacks expecting fan-out.
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      manager.onToken(callback1);
      manager.onToken(callback2);

      manager.pushToken('Test');

      vi.advanceTimersByTime(100);

      expect(callback2).toHaveBeenCalledWith('Test');
      expect(callback1).not.toHaveBeenCalled();
    });
  });

  describe('onDone callback', () => {
    it('registers done callback', () => {
      const callback = vi.fn();
      manager.onDone(callback);

      manager.complete({
        sources: ['doc1.pdf'],
        contextLength: 2048,
        inferenceTime: 1000,
      });

      expect(callback).toHaveBeenCalledWith({
        sources: ['doc1.pdf'],
        contextLength: 2048,
        inferenceTime: 1000,
      });
    });

    it('is called with correct data structure', () => {
      const callback = vi.fn();
      manager.onDone(callback);

      manager.complete({
        sources: ['doc1.pdf', 'doc2.pdf'],
        contextLength: 4096,
        inferenceTime: 2500,
      });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          sources: expect.arrayContaining(['doc1.pdf', 'doc2.pdf']),
          contextLength: 4096,
          inferenceTime: 2500,
        })
      );
    });
  });

  describe('onError callback', () => {
    it('registers error callback', () => {
      const callback = vi.fn();
      manager.onError(callback);

      manager.error('Something went wrong');

      expect(callback).toHaveBeenCalledWith('Something went wrong');
    });

    it('flushes remaining tokens before error', () => {
      const tokenCallback = vi.fn();
      const errorCallback = vi.fn();

      manager.onToken(tokenCallback);
      manager.onError(errorCallback);

      manager.pushToken('Hello');
      manager.pushToken('World');
      manager.error('Error occurred');

      // error() flushes synchronously before invoking the error callback,
      // so the token callback has already fired by the time error() returns.
      expect(tokenCallback).toHaveBeenCalledWith('HelloWorld');
      expect(errorCallback).toHaveBeenCalledWith('Error occurred');
    });
  });

  describe('pushToken', () => {
    it('adds tokens to buffer', () => {
      const callback = vi.fn();
      manager.onToken(callback);

      manager.pushToken('Hello');
      manager.pushToken(' ');
      manager.pushToken('World');

      vi.advanceTimersByTime(100);

      // All tokens should be joined and sent
      expect(callback).toHaveBeenCalledWith('Hello World');
    });

    it('does not add tokens when cancelled', () => {
      const callback = vi.fn();
      manager.onToken(callback);

      // cancel() with an EMPTY buffer does not invoke the token callback
      // (nothing to flush), so this still asserts no callback fires.
      manager.cancel();
      manager.pushToken('Should not appear');

      vi.advanceTimersByTime(100);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    it('signals completion with data', () => {
      const callback = vi.fn();
      manager.onDone(callback);

      manager.complete({
        sources: ['source.pdf'],
        contextLength: 2048,
        inferenceTime: 500,
      });

      expect(callback).toHaveBeenCalled();
    });

    it('flushes remaining tokens before completing', () => {
      const tokenCallback = vi.fn();
      const doneCallback = vi.fn();

      manager.onToken(tokenCallback);
      manager.onDone(doneCallback);

      manager.pushToken('Remaining');
      manager.complete({
        sources: [],
        contextLength: 0,
        inferenceTime: 0,
      });

      // complete() flushes synchronously before invoking the done callback,
      // so the token callback fires during the complete() call itself.
      expect(tokenCallback).toHaveBeenCalledWith('Remaining');
    });

    it('does not complete when cancelled', () => {
      const callback = vi.fn();
      manager.onDone(callback);

      manager.cancel();
      manager.complete({
        sources: [],
        contextLength: 0,
        inferenceTime: 0,
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('sets cancelled flag to true', () => {
      manager.cancel();
      // Further operations should be no-ops
      manager.pushToken('Test');
      vi.advanceTimersByTime(100);
    });

    it('flushes buffered tokens before clearing (S4)', () => {
      // NEW contract (issue #36 / S4): cancel() flushes the buffered tokens
      // through the token callback BEFORE clearing, so Stop delivers every
      // token received up to the cancel. The old behavior (nulling the buffer
      // without flushing) dropped up to a RAF frame of tokens.
      const callback = vi.fn();
      manager.onToken(callback);

      manager.pushToken('Hello');
      manager.pushToken(' ');
      manager.pushToken('World');

      // No RAF flush has fired yet — tokens are still buffered.
      expect(callback).not.toHaveBeenCalled();

      manager.cancel();

      // cancel() flushes synchronously: the callback receives every buffered
      // token joined, in order, before the buffer is cleared.
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('Hello World');
    });

    it('cancel after cancel does not re-flush', () => {
      const callback = vi.fn();
      manager.onToken(callback);

      manager.pushToken('first');
      manager.cancel();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('first');

      // A second cancel is a no-op (cancelled flag guards it) and must not
      // re-deliver already-flushed tokens.
      manager.cancel();
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('stops active consumer', () => {
      manager.cancel();
      // Should not throw
      expect(manager).toBeDefined();
    });

    it('clears flush timer', () => {
      // cancel() only cancels a flush timer if one was actually scheduled.
      // Pushing a token schedules a RAF, so cancel() must tear it down.
      const cancelAnimationFrameSpy = vi.spyOn(global, 'cancelAnimationFrame');

      manager.pushToken('buffered'); // schedules a RAF
      manager.cancel();

      expect(cancelAnimationFrameSpy).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('cancels any active stream', () => {
      manager.dispose();

      // Should not throw on repeated dispose
      manager.dispose();
    });

    it('nulls all callbacks', () => {
      const tokenCb = vi.fn();
      const doneCb = vi.fn();
      const errorCb = vi.fn();

      manager.onToken(tokenCb);
      manager.onDone(doneCb);
      manager.onError(errorCb);

      manager.dispose();

      // After dispose, pushing tokens should not call callbacks. dispose()
      // cancels (which would flush buffered tokens) but no tokens have been
      // pushed yet, so the token callback has not fired.
      expect(tokenCb).not.toHaveBeenCalled();

      manager.pushToken('Test');
      vi.advanceTimersByTime(100);

      expect(tokenCb).not.toHaveBeenCalled();
    });

    it('can be called multiple times safely', () => {
      expect(() => {
        manager.dispose();
        manager.dispose();
      }).not.toThrow();
    });
  });

  describe('RAF Batching', () => {
    it('batches multiple tokens into single RAF frame', () => {
      const callback = vi.fn();
      manager.onToken(callback);

      manager.pushToken('A');
      manager.pushToken('B');
      manager.pushToken('C');

      // Before RAF
      expect(callback).not.toHaveBeenCalled();

      // After RAF
      vi.advanceTimersByTime(100);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('ABC');
    });

    it('schedules new RAF after flush', () => {
      const callback = vi.fn();
      manager.onToken(callback);

      // First batch
      manager.pushToken('1');
      vi.advanceTimersByTime(100);
      expect(callback).toHaveBeenCalledWith('1');

      // Second batch after first flush
      manager.pushToken('2');
      vi.advanceTimersByTime(100);
      expect(callback).toHaveBeenCalledWith('2');
    });
  });

  describe('Overflow (S4)', () => {
    it('flushes synchronously on overflow preserving token order (no drops)', () => {
      // NEW contract (issue #36 / S4): pushToken overflow now flushes the
      // buffer through the callback (preserving every token in order) instead
      // of splicing the oldest unflushed tokens out of the middle of the
      // displayed content. The old splice silently corrupted content.
      const callback = vi.fn();
      manager.onToken(callback);

      // MAX_BUFFER_SIZE is 10000. Push more than that synchronously with no
      // RAF flush in between. Every token must arrive via the callback,
      // concatenated in push order, with none dropped.
      const N = 10005;
      let expected = '';
      for (let i = 0; i < N; i++) {
        const tok = `t${i}`;
        expected += tok;
        manager.pushToken(tok);
      }

      // The overflow path flushes the buffer (in order) each time the cap is
      // crossed, instead of splicing oldest tokens. Whatever has been flushed
      // so far must be an in-order PREFIX of the full stream — no gaps, no
      // reordering, no oldest-token drops (the old splice behavior would have
      // made this a non-prefix by deleting t0..tN from the middle).
      const flushedSoFar = callback.mock.calls.map((c) => c[0]).join('');
      expect(expected.startsWith(flushedSoFar)).toBe(true);
      // The overflow fired at least once (buffer crossed 10000).
      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(1);

      // Drain anything still buffered at the end via cancel (which also
      // flushes per the S4 cancel contract) to confirm the tail is delivered
      // too. After cancel, the concatenation of EVERY callback invocation
      // must equal the full in-order token stream — nothing dropped.
      manager.cancel();
      const receivedAll = callback.mock.calls.map((c) => c[0]).join('');
      expect(receivedAll).toBe(expected);
    });
  });

  describe('Hidden-tab setTimeout fallback (S4)', () => {
    it('uses setTimeout fallback when document is hidden', () => {
      // NEW contract (issue #36 / S4): when the tab is hidden, RAF is
      // suspended by the browser, so scheduleFlush falls back to a setTimeout
      // (100ms) to keep tokens flushing in background tabs.
      const originalHidden = Object.getOwnPropertyDescriptor(document, 'visibilityState');
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });

      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const rafSpy = vi.spyOn(global, 'requestAnimationFrame');

      try {
        const callback = vi.fn();
        manager.onToken(callback);

        manager.pushToken('bg-token');

        // In hidden state, setTimeout must be used to schedule the flush
        // (requestAnimationFrame would never fire).
        expect(setTimeoutSpy).toHaveBeenCalled();
        expect(rafSpy).not.toHaveBeenCalled();

        // Flushing the timer delivers the token.
        vi.advanceTimersByTime(100);
        expect(callback).toHaveBeenCalledWith('bg-token');
      } finally {
        // Restore
        if (originalHidden) {
          Object.defineProperty(document, 'visibilityState', originalHidden);
        } else {
          // best-effort restore to visible
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'visible',
          });
        }
        setTimeoutSpy.mockRestore();
        rafSpy.mockRestore();
      }
    });
  });

  describe('startSSEStream', () => {
    it('creates SSEStreamConsumer with correct parameters', async () => {
      const { SSEStreamConsumer } = await import('../api/streaming');

      manager.startSSEStream('/api/chat', { question: 'test' }, 'Bearer token');

      expect(SSEStreamConsumer).toHaveBeenCalledWith('/api/chat', { question: 'test' }, 'Bearer token');
    });

    it('wires token callback to consumer', async () => {
      const { SSEStreamConsumer } = await import('../api/streaming');

      manager.onToken(vi.fn());
      manager.startSSEStream('/api/chat', {});

      const mockConsumer = vi.mocked(SSEStreamConsumer).mock.results.at(-1)?.value;
      expect(mockConsumer).toBeDefined();
      expect(mockConsumer.onToken).toHaveBeenCalled();
    });

    it('wires done callback to consumer', async () => {
      const { SSEStreamConsumer } = await import('../api/streaming');

      manager.onDone(vi.fn());
      manager.startSSEStream('/api/chat', {});

      const mockConsumer = vi.mocked(SSEStreamConsumer).mock.results.at(-1)?.value;
      expect(mockConsumer).toBeDefined();
      expect(mockConsumer.onDone).toHaveBeenCalled();
    });

    it('wires error callback to consumer', async () => {
      const { SSEStreamConsumer } = await import('../api/streaming');

      manager.onError(vi.fn());
      manager.startSSEStream('/api/chat', {});

      const mockConsumer = vi.mocked(SSEStreamConsumer).mock.results.at(-1)?.value;
      expect(mockConsumer).toBeDefined();
      expect(mockConsumer.onError).toHaveBeenCalled();
    });

    it('starts the consumer', async () => {
      const { SSEStreamConsumer } = await import('../api/streaming');

      manager.startSSEStream('/api/chat', {});

      const mockConsumer = vi.mocked(SSEStreamConsumer).mock.results.at(-1)?.value;
      expect(mockConsumer).toBeDefined();
      expect(mockConsumer.start).toHaveBeenCalled();
    });
  });
});
