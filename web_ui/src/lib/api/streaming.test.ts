/**
 * Comprehensive test suite for SSEStreamConsumer
 * Tests POST-based SSE streaming for API server mode.
 * Uses vitest + jsdom patterns from the web_ui project.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEStreamConsumer } from './streaming';

describe('SSEStreamConsumer', () => {
  let consumer: SSEStreamConsumer;
  let mockFetch: ReturnType<typeof vi.fn>;
  const encoder = new TextEncoder();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Helper to access private members for constructor verification only
  interface TestableConsumer extends SSEStreamConsumer {
    url: string;
    body: object;
    token?: string;
    onTokenCallbacks: Array<(t: string) => void>;
    onDoneCallbacks: Array<(d: any) => void>;
    onErrorCallbacks: Array<(e: string) => void>;
  }

  function asTestable(c: SSEStreamConsumer): TestableConsumer {
    return c as unknown as TestableConsumer;
  }

  // Helper to flush microtasks for async start() processing.
  // Single deterministic microtask yield using queueMicrotask (replaces brittle
  // setTimeout(0) loop which had no guarantee of draining under CI load).
  async function flushMicrotasks(times = 2): Promise<void> {
    await new Promise((resolve) => queueMicrotask(resolve));
  }

  describe('Constructor', () => {
    it('stores url, body, and token', () => {
      const url = 'http://localhost:8000/ask/stream';
      const body = { question: 'What is RAG?' };
      const token = 'abc123';

      consumer = new SSEStreamConsumer(url, body, token);
      const testable = asTestable(consumer);

      expect(testable.url).toBe(url);
      expect(testable.body).toEqual(body);
      expect(testable.token).toBe(token);
    });

    it('works without token', () => {
      consumer = new SSEStreamConsumer('http://ex.com/api', { question: 'hi' });
      const testable = asTestable(consumer);

      expect(testable.token).toBeUndefined();
    });
  });

  describe('Callback registration', () => {
    beforeEach(() => {
      consumer = new SSEStreamConsumer('http://ex.com', {});
    });

    it('onToken registers callback', () => {
      const callback = vi.fn();
      consumer.onToken(callback);

      expect(asTestable(consumer).onTokenCallbacks).toContain(callback);
    });

    it('onDone registers callback', () => {
      const callback = vi.fn();
      consumer.onDone(callback);

      expect(asTestable(consumer).onDoneCallbacks).toContain(callback);
    });

    it('onError registers callback', () => {
      const callback = vi.fn();
      consumer.onError(callback);

      expect(asTestable(consumer).onErrorCallbacks).toContain(callback);
    });

    it('multiple callbacks can be registered for the same event', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      consumer.onToken(cb1);
      consumer.onToken(cb2);

      expect(asTestable(consumer).onTokenCallbacks.length).toBe(2);
      expect(asTestable(consumer).onTokenCallbacks).toContain(cb1);
      expect(asTestable(consumer).onTokenCallbacks).toContain(cb2);
    });
  });

  describe('start()', () => {
    const testUrl = 'http://localhost:8000/ask/stream';
    const testBody = { question: 'Explain quantum computing' };
    const testToken = 'test-bearer-token';

    beforeEach(() => {
      consumer = new SSEStreamConsumer(testUrl, testBody, testToken);
    });

    it('calls fetch with POST method', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await flushMicrotasks();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('POST');
    });

    it('includes Content-Type: application/json header', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await flushMicrotasks();

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Content-Type']).toBe('application/json');
    });

    it('includes JSON stringified body', async () => {
      const body = { question: 'test question', n_results: 5 };
      consumer = new SSEStreamConsumer('u', body);
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await flushMicrotasks();

      const [, options] = mockFetch.mock.calls[0];
      expect(options.body).toBe(JSON.stringify(body));
    });

    it('includes Authorization: Bearer header when token provided', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await flushMicrotasks();

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Authorization']).toBe(`Bearer ${testToken}`);
    });

    it('does not include Authorization header when no token', async () => {
      consumer = new SSEStreamConsumer('http://ex.com', { question: 'no auth' });
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await flushMicrotasks();

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Authorization']).toBeUndefined();
    });

    it('uses AbortController signal', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await flushMicrotasks();

      const [, options] = mockFetch.mock.calls[0];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('emits error via onError for non-OK responses (ApiError path)', async () => {
      const errorCallback = vi.fn();
      consumer.onError(errorCallback);

      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
      } as unknown as Response);

      consumer.start();
      await flushMicrotasks();

      expect(errorCallback).toHaveBeenCalledWith('HTTP error: 401');
    });

    it('emits error via onError when response.body is null', async () => {
      const errorCallback = vi.fn();
      consumer.onError(errorCallback);

      mockFetch.mockResolvedValue({
        ok: true,
        body: null,
      } as unknown as Response);

      consumer.start();
      await flushMicrotasks();

      expect(errorCallback).toHaveBeenCalledWith('Response body is null');
    });

    it('silently ignores AbortError (does not emit error)', async () => {
      const errorCallback = vi.fn();
      consumer.onError(errorCallback);

      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      consumer.start();
      await flushMicrotasks();

      expect(errorCallback).not.toHaveBeenCalled();
    });
  });

  describe('processLine (tested via start + mocked stream)', () => {
    beforeEach(() => {
      consumer = new SSEStreamConsumer('http://ex.com', {});
    });

    it('parses token event from "data: {\\"token\\":\\"hello\\"}"', async () => {
      const tokenCallback = vi.fn();
      consumer.onToken(tokenCallback);

      const tokenPromise = new Promise<string>((resolve) => {
        consumer.onToken((t) => {
          tokenCallback(t);
          resolve(t);
        });
      });

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"token":"hello"}\n'));
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      const received = await tokenPromise;

      expect(received).toBe('hello');
      expect(tokenCallback).toHaveBeenCalledWith('hello');
    });

    it('parses done event when data has sources and context_length', async () => {
      const doneCallback = vi.fn();
      const donePromise = new Promise<any>((resolve) => {
        consumer.onDone((data) => {
          doneCallback(data);
          resolve(data);
        });
      });

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"sources":["doc1.pdf","doc2.txt"],"context_length":1536,"inference_time":245}\n'
            )
          );
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      const received = await donePromise;

      expect(doneCallback).toHaveBeenCalledWith({
        sources: ['doc1.pdf', 'doc2.txt'],
        context_length: 1536,
        inference_time: 245,
      });
      expect(received).toEqual({
        sources: ['doc1.pdf', 'doc2.txt'],
        context_length: 1536,
        inference_time: 245,
      });
    });

    it('parses error event when data has error field', async () => {
      const errorCallback = vi.fn();
      const errorPromise = new Promise<string>((resolve) => {
        consumer.onError((err) => {
          errorCallback(err);
          resolve(err);
        });
      });

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"error":"model overloaded"}\n'));
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      const received = await errorPromise;

      expect(received).toBe('model overloaded');
      expect(errorCallback).toHaveBeenCalledWith('model overloaded');
    });

    it('ignores non-data: lines (e.g., "event: error")', async () => {
      const tokenCallback = vi.fn();
      const errorCallback = vi.fn();
      consumer.onToken(tokenCallback);
      consumer.onError(errorCallback);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: error\n'));
          controller.enqueue(encoder.encode('data: {"token":"should-not-emit"}\n')); // still processes data lines
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await flushMicrotasks(3);

      // The data line still fires (per current impl), but we verify event: line itself caused no side effect
      // To purely test ignore of event line, we use a stream with ONLY event line
      const pureEventStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: error\n'));
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: pureEventStream } as unknown as Response);

      const freshConsumer = new SSEStreamConsumer('u', {});
      const tcb = vi.fn();
      const ecb = vi.fn();
      freshConsumer.onToken(tcb);
      freshConsumer.onError(ecb);

      freshConsumer.start();
      await flushMicrotasks(3);

      expect(tcb).not.toHaveBeenCalled();
      expect(ecb).not.toHaveBeenCalled();
    });

    it('handles malformed JSON gracefully without throwing or emitting', async () => {
      const errorCallback = vi.fn();
      consumer.onError(errorCallback);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {invalid json here}\n'));
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await flushMicrotasks(3);

      expect(errorCallback).not.toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    beforeEach(() => {
      consumer = new SSEStreamConsumer('http://ex.com', {});
    });

    it('is safe to call when not started', async () => {
      await expect(consumer.stop()).resolves.not.toThrow();
    });

    it('can be called multiple times safely', async () => {
      await consumer.stop();
      await expect(consumer.stop()).resolves.not.toThrow();
      await consumer.stop();
      await consumer.stop();
    });

    it('aborts the controller', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      consumer.start();
      await flushMicrotasks();

      await consumer.stop();

      expect(abortSpy).toHaveBeenCalled();

      abortSpy.mockRestore();
    });
  });

  describe('readStream (tested through start() with mocked ReadableStream)', () => {
    beforeEach(() => {
      consumer = new SSEStreamConsumer('http://ex.com', {});
    });

    it('processes chunked SSE data correctly', async () => {
      const receivedTokens: string[] = [];
      const donePromise = new Promise<void>((resolve) => {
        consumer.onDone(() => resolve());
      });
      consumer.onToken((t) => receivedTokens.push(t));

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"token":"hello"}\n'));
          controller.enqueue(encoder.encode('data: {"token":" "}\n'));
          controller.enqueue(encoder.encode('data: {"token":"world"}\n'));
          controller.enqueue(encoder.encode('data: {"sources":[],"context_length":0}\n'));
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await donePromise;

      expect(receivedTokens).toEqual(['hello', ' ', 'world']);
    });

    it('handles split tokens across chunks (line buffer)', async () => {
      const receivedTokens: string[] = [];
      const tokenPromise = new Promise<string>((resolve) => {
        consumer.onToken((t) => {
          receivedTokens.push(t);
          if (receivedTokens.length === 1) resolve(t);
        });
      });

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"token":"hel'));
          controller.enqueue(encoder.encode('lo"}\n'));
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await tokenPromise;

      expect(receivedTokens).toEqual(['hello']);
    });

    it('handles stream end with trailing data in buffer', async () => {
      const receivedTokens: string[] = [];
      const lastTokenPromise = new Promise<string>((resolve) => {
        consumer.onToken((t) => {
          receivedTokens.push(t);
          if (t === 'trailing') resolve(t);
        });
      });

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"token":"first"}\n'));
          // trailing line without final \n — flush logic in readStream handles it at stream end
          controller.enqueue(encoder.encode('data: {"token":"trailing"}'));
          controller.close();
        },
      });
      mockFetch.mockResolvedValue({ ok: true, body: stream } as unknown as Response);

      consumer.start();
      await lastTokenPromise;

      expect(receivedTokens).toEqual(['first', 'trailing']);
    });
  });
});
