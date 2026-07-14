/**
 * TokenStreamManager - Manages token streaming for chat responses.
 * Provides unified token callback interface with RAF-batched DOM updates to prevent jank.
 */

import { SSEStreamConsumer } from '../api/streaming';

type TokenCallback = (token: string) => void;
type DoneCallback = (data: { sources: string[]; contextLength: number; inferenceTime: number }) => void;
type ErrorCallback = (error: string) => void;

/**
 * TokenStreamManager manages SSE token streaming for chat responses
 * and feeds tokens to a unified callback with RAF-batched DOM updates.
 *
 * Tokens from fast producers are buffered and flushed via requestAnimationFrame
 * to prevent jank when tokens arrive faster than React can render.
 */
export class TokenStreamManager {
  private static readonly MAX_BUFFER_SIZE = 10000;

  private tokenBuffer: string[];
  private flushTimer: number | null;
  private tokenCallback: TokenCallback | null;
  private doneCallback: DoneCallback | null;
  private errorCallback: ErrorCallback | null;
  private activeConsumer: SSEStreamConsumer | null;
  private cancelled: boolean;

  constructor() {
    this.tokenBuffer = [];
    this.flushTimer = null;
    this.tokenCallback = null;
    this.doneCallback = null;
    this.errorCallback = null;
    this.activeConsumer = null;
    this.cancelled = false;
  }

  /**
   * Register a callback for token events.
   * @param cb - Function called when tokens are flushed to the DOM
   */
  onToken(cb: TokenCallback): void {
    this.tokenCallback = cb;
  }

  /**
   * Register a callback for done events.
   * @param cb - Function called when the stream completes
   */
  onDone(cb: DoneCallback): void {
    this.doneCallback = cb;
  }

  /**
   * Register a callback for error events.
   * @param cb - Function called when an error occurs
   */
  onError(cb: ErrorCallback): void {
    this.errorCallback = cb;
  }

  /**
   * Add a token to the buffer and schedule a RAF flush if not already scheduled.
   * @param token - The token string to add
   */
  pushToken(token: string): void {
    if (this.cancelled) return;

    this.tokenBuffer.push(token);

    if (this.flushTimer === null) {
      this.scheduleFlush();
    }

    if (this.tokenBuffer.length > TokenStreamManager.MAX_BUFFER_SIZE) {
      const dropped = this.tokenBuffer.length - TokenStreamManager.MAX_BUFFER_SIZE;
      this.tokenBuffer.splice(0, dropped);
      console.warn(`[TokenStreamManager] Buffer overflow: dropped ${dropped} oldest tokens (max ${TokenStreamManager.MAX_BUFFER_SIZE})`);
    }
  }

  /**
   * Schedule a requestAnimationFrame flush of the token buffer.
   */
  private scheduleFlush(): void {
    this.flushTimer = requestAnimationFrame(() => {
      this.flushTimer = null;
      this.flushBuffer();
    });
  }

  /**
   * Flush the token buffer by joining all tokens and calling the token callback.
   */
  private flushBuffer(): void {
    if (this.tokenBuffer.length === 0) return;
    if (!this.tokenCallback) return;

    const joined = this.tokenBuffer.join('');
    this.tokenBuffer = [];

    this.tokenCallback(joined);
  }

  /**
   * Signal completion of the stream.
   * @param data - Completion data including sources and inference metrics
   */
  complete(data: { sources: string[]; contextLength: number; inferenceTime: number }): void {
    if (this.cancelled) return;

    // Flush any remaining tokens first
    this.flushBuffer();

    if (this.doneCallback) {
      this.doneCallback(data);
    }

    this.cleanup();
    this.cancelled = true;
  }

  /**
   * Signal an error occurred.
   * @param message - Error message
   */
  error(message: string): void {
    if (this.cancelled) return;

    // Flush any remaining tokens first
    this.flushBuffer();

    if (this.errorCallback) {
      this.errorCallback(message);
    }

    this.cleanup();
    this.cancelled = true;
  }

  /**
   * Start an SSE stream using the ApiClient endpoint.
   * @param url - The API endpoint URL
   * @param body - Request body object
   * @param token - Optional authorization token
   * @returns The SSEStreamConsumer instance
   */
  startSSEStream(url: string, body: object, token?: string): SSEStreamConsumer {
    // Cancel any existing stream
    this.cancel();

    // Reset cancelled flag so new stream can receive tokens
    this.cancelled = false;

    // The SSEStreamConsumer constructor validates the URL synchronously and can
    // throw BEFORE the done/error callbacks are wired. Wrap setup so any throw
    // is routed through this.error() (which fires the registered onError,
    // letting the UI reach a terminal state instead of wedging the send
    // pipeline). (issue #21 F5)
    let consumer: SSEStreamConsumer;
    try {
      consumer = new SSEStreamConsumer(url, body, token);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err));
      // Re-throw to preserve the synchronous contract; callers that care wrap
      // their own try/catch (ChatPage's API branch does, routing to onError).
      throw err;
    }

    consumer.onToken((token) => {
      this.pushToken(token);
    });

    consumer.onDone((data) => {
      this.complete({
        sources: data.sources,
        contextLength: data.context_length,
        inferenceTime: data.inference_time,
      });
    });

    consumer.onError((error) => {
      this.error(error);
    });

    this.activeConsumer = consumer;
    consumer.start();

    return consumer;
  }

  /**
   * Cancel any active stream and clear pending operations.
   */
  cancel(): void {
    this.cancelled = true;

    if (this.activeConsumer) {
      void this.activeConsumer.stop();
      this.activeConsumer = null;
    }

    this.clearFlushTimer();
    this.tokenBuffer = [];
  }

  /**
   * Clear any pending RAF flush timer.
   */
  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      cancelAnimationFrame(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Full cleanup - cancel stream and null all callbacks to prevent memory leaks.
   */
  dispose(): void {
    this.cancel();
    this.tokenCallback = null;
    this.doneCallback = null;
    this.errorCallback = null;
  }

  /**
   * Internal cleanup after complete or error.
   */
  private cleanup(): void {
    if (this.activeConsumer) {
      void this.activeConsumer.stop();
      this.activeConsumer = null;
    }
    this.clearFlushTimer();
  }
}
