/**
 * SSE Stream Consumer for POST-based server-sent events.
 * Uses fetch with ReadableStream to handle POST requests with SSE responses.
 */

import type { StreamDoneEvent } from './types';
import { ApiError } from './types';

/**
 * Callback type for receiving token events
 */
type TokenCallback = (token: string) => void;

/**
 * Callback type for receiving done events
 */
type DoneCallback = (data: StreamDoneEvent) => void;

/**
 * Callback type for receiving error events
 */
type ErrorCallback = (error: string) => void;

/**
 * SSEStreamConsumer handles POST-based SSE streams.
 * Parses SSE format lines starting with "data: " containing JSON payloads.
 */
export class SSEStreamConsumer {
  private url: string;
  private body: object;
  private token?: string;
  private controller: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private onTokenCallbacks: TokenCallback[] = [];
  private onDoneCallbacks: DoneCallback[] = [];
  private onErrorCallbacks: ErrorCallback[] = [];
  private decoder: TextDecoder;

  /**
   * Create a new SSEStreamConsumer.
   * @param url - The endpoint URL to POST to
   * @param body - The request body object
   * @param token - Optional authorization token
   */
  constructor(url: string, body: object, token?: string) {
    this.url = url;
    this.body = body;
    this.token = token;
    this.decoder = new TextDecoder();
  }

  /**
   * Register a callback for token events.
   * @param callback - Function called when a token is received
   */
  onToken(callback: TokenCallback): void {
    this.onTokenCallbacks.push(callback);
  }

  /**
   * Register a callback for done events.
   * @param callback - Function called when the stream completes
   */
  onDone(callback: DoneCallback): void {
    this.onDoneCallbacks.push(callback);
  }

  /**
   * Register a callback for error events.
   * @param callback - Function called when an error occurs
   */
  onError(callback: ErrorCallback): void {
    this.onErrorCallbacks.push(callback);
  }

  /**
   * Start the SSE stream connection.
   * Uses fetch with ReadableStream to handle POST-based SSE.
   */
  start(): void {
    if (this.controller) {
      void this.stop();
    }

    this.controller = new AbortController();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(this.body),
      signal: this.controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new ApiError(response.status, `HTTP error: ${response.status}`);
        }

        if (!response.body) {
          throw new ApiError(500, 'Response body is null');
        }

        this.reader = response.body.getReader();
        this.readStream();
      })
      .catch((error) => {
        if (error instanceof ApiError) {
          this.emitError(error.detail);
        } else if ((error as Error).name === 'AbortError') {
          // Stream was cancelled, not an error
        } else {
          this.emitError((error as Error).message || 'Network error');
        }
      });
  }

  /**
   * Stop the SSE stream connection.
   * Aborts the fetch request and cleans up resources.
   */
  async stop(): Promise<void> {
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // Reader may already be cancelled
      }
      this.reader = null;
    }

    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  /**
   * Read the stream incrementally, parsing SSE format.
   */
  private async readStream(): Promise<void> {
    if (!this.reader) return;

    let buffer = '';

    try {
      while (true) {
        const { done, value } = await this.reader.read();

        if (done) {
          break;
        }

        buffer += this.decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          this.processLine(line);
        }
      }

      // Flush remaining buffered bytes (no stream:true)
      buffer += this.decoder.decode();

      // Process any remaining data in buffer
      if (buffer.trim()) {
        this.processLine(buffer);
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        this.emitError((error as Error).message || 'Stream read error');
      }
    }
  }

  /**
   * Process a single SSE-formatted line.
   * @param line - A single line from the SSE stream
   */
  private processLine(line: string): void {
    const trimmed = line.trim();

    if (trimmed.startsWith('event: error')) {
      // Handle error events
      return;
    }

    if (trimmed.startsWith('data: ')) {
      const dataStr = trimmed.slice(6);

      try {
        const data = JSON.parse(dataStr);

        // Check if this is a done event
        if (data.sources !== undefined && data.context_length !== undefined) {
          const doneEvent: StreamDoneEvent = {
            sources: data.sources,
            context_length: data.context_length,
            inference_time: data.inference_time || 0,
          };
          this.emitDone(doneEvent);
        } else if (data.token !== undefined) {
          // Token event
          this.emitToken(data.token);
        } else if (data.error !== undefined) {
          // Error in the data payload
          this.emitError(data.error);
        }
      } catch {
        // Ignore parse errors for incomplete JSON
      }
    }
  }

  private emitToken(token: string): void {
    for (const callback of this.onTokenCallbacks) {
      callback(token);
    }
  }

  private emitDone(data: StreamDoneEvent): void {
    for (const callback of this.onDoneCallbacks) {
      callback(data);
    }
  }

  private emitError(error: string): void {
    for (const callback of this.onErrorCallbacks) {
      callback(error);
    }
  }
}
