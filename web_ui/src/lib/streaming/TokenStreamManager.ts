/**
 * TokenStreamManager - Manages token streaming for chat responses.
 * Provides unified token callback interface with RAF-batched DOM updates to prevent jank.
 */

import { SSEStreamConsumer } from '../api/streaming';
import type { SearchResult } from '../../types/search';

type TokenCallback = (token: string) => void;

/** Completion payload. Server (SSE) mode fills sources/contextLength/inferenceTime;
 *  the browser-local RAG mode additionally fills citations, abstention, and
 *  degradation signals. All RAG-only fields are optional so the server path is
 *  unaffected. */
type DoneCallback = (data: {
  sources: string[];
  contextLength: number;
  inferenceTime: number;
  /** Structured per-chunk citations aligned with the model's [1],[2] order (F7). */
  chunks?: SearchResult[];
  /** True when the pipeline abstained instead of answering (F2). */
  abstain?: boolean;
  abstainReason?: 'insufficient_evidence' | 'retrieval_degraded';
  /** True when retrieval ran keyword-only (F4). */
  retrievalDegraded?: boolean;
  /** Number of context chunks dropped to fit the token budget (F11). */
  contextTrimmed?: number;
}) => void;
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

    // S4: on overflow, flush the buffer DOWN to a safe size via the normal
    // callback (preserving token order and the consumer's append contract)
    // instead of splicing the oldest unflushed tokens out of the middle of
    // displayed+persisted content. The previous splice silently corrupted
    // content; flushing preserves every token. We leave a small headroom so
    // the next push doesn't immediately re-trigger.
    if (this.tokenBuffer.length > TokenStreamManager.MAX_BUFFER_SIZE) {
      this.flushBuffer();
    }
  }

  /**
   * Schedule a requestAnimationFrame flush of the token buffer.
   *
   * S4: when the document is hidden (tab in background), RAF is suspended and
   * the buffer would accrue unbounded until the tab refocuses. Use a setTimeout
   * fallback so tokens still flush in background tabs.
   */
  private scheduleFlush(): void {
    const useTimeoutFallback = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (useTimeoutFallback) {
      this.flushTimer = window.setTimeout(() => {
        this.flushTimer = null;
        this.flushBuffer();
      }, 100) as unknown as number;
    } else {
      this.flushTimer = requestAnimationFrame(() => {
        this.flushTimer = null;
        this.flushBuffer();
      });
    }
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
   * @param data - Completion data including sources, inference metrics, and
   *   optional RAG citation/abstention/degradation signals.
   */
  complete(data: {
    sources: string[];
    contextLength: number;
    inferenceTime: number;
    chunks?: SearchResult[];
    abstain?: boolean;
    abstainReason?: 'insufficient_evidence' | 'retrieval_degraded';
    retrievalDegraded?: boolean;
    contextTrimmed?: number;
  }): void {
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
   *
   * S4: FLUSH buffered tokens to the callback BEFORE clearing, so Stop
   * delivers every token received up to the cancel (previously cancel() nulled
   * the buffer without flushing, dropping up to a RAF frame of tokens — far
   * more after a hidden tab). Mirrors the flush-first contract of complete()
   * and error().
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;

    if (this.activeConsumer) {
      void this.activeConsumer.stop();
      this.activeConsumer = null;
    }

    // Flush remaining tokens so Stop doesn't drop them, THEN clear.
    this.flushBuffer();
    this.clearFlushTimer();
  }

  /**
   * Clear any pending flush timer (RAF or setTimeout fallback).
   */
  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      // The timer may be either a RAF handle or a setTimeout handle. Use both
      // cancellers defensively (each is a no-op for the wrong type).
      cancelAnimationFrame(this.flushTimer);
      clearTimeout(this.flushTimer);
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
