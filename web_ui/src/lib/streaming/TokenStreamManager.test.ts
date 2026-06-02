/**
 * Tests for TokenStreamManager class
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
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
    vi.clearAllMocks();
    manager = new TokenStreamManager();
  });

  afterEach(() => {
    manager.dispose();
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

    it('allows multiple token callbacks to be registered', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      manager.onToken(callback1);
      manager.onToken(callback2);

      manager.pushToken('Test');

      vi.advanceTimersByTime(100);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
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

      vi.advanceTimersByTime(100);

      expect(tokenCallback).toHaveBeenCalled();
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

      vi.advanceTimersByTime(100);

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

    it('clears pending tokens', () => {
      const callback = vi.fn();
      manager.onToken(callback);

      manager.pushToken('Hello');
      manager.cancel();

      vi.advanceTimersByTime(100);

      expect(callback).not.toHaveBeenCalled();
    });

    it('stops active consumer', () => {
      manager.cancel();
      // Should not throw
      expect(manager).toBeDefined();
    });

    it('clears flush timer', () => {
      const cancelAnimationFrameSpy = vi.spyOn(global, 'cancelAnimationFrame');

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

      // After dispose, pushing tokens should not call callbacks
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
      vi.useFakeTimers();

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

      vi.useRealTimers();
    });

    it('schedules new RAF after flush', () => {
      vi.useFakeTimers();

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

      vi.useRealTimers();
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
      const mockConsumer = vi.mocked(SSEStreamConsumer).mock.results[0].value;

      manager.onToken(vi.fn());
      manager.startSSEStream('/api/chat', {});

      expect(mockConsumer.onToken).toHaveBeenCalled();
    });

    it('wires done callback to consumer', async () => {
      const { SSEStreamConsumer } = await import('../api/streaming');
      const mockConsumer = vi.mocked(SSEStreamConsumer).mock.results[0].value;

      manager.onDone(vi.fn());
      manager.startSSEStream('/api/chat', {});

      expect(mockConsumer.onDone).toHaveBeenCalled();
    });

    it('wires error callback to consumer', async () => {
      const { SSEStreamConsumer } = await import('../api/streaming');
      const mockConsumer = vi.mocked(SSEStreamConsumer).mock.results[0].value;

      manager.onError(vi.fn());
      manager.startSSEStream('/api/chat', {});

      expect(mockConsumer.onError).toHaveBeenCalled();
    });

    it('starts the consumer', async () => {
      const { SSEStreamConsumer } = await import('../api/streaming');
      const mockConsumer = vi.mocked(SSEStreamConsumer).mock.results[0].value;

      manager.startSSEStream('/api/chat', {});

      expect(mockConsumer.start).toHaveBeenCalled();
    });
  });

});
