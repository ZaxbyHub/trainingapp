/**
 * SSE Stream Consumer for POST-based server-sent events.
 * Uses fetch with ReadableStream to handle POST requests with SSE responses.
 */

import type { StreamDoneEvent } from './types';
import { ApiError } from './types';

/**
 * Validates a stream URL.
 *
 * This is a self-hosted, client-side app: the user configures the server URL
 * (commonly a LAN box, or localhost for local development). This client
 * intentionally allows private/LAN/loopback/.local/link-local hostnames so
 * users can point at a self-hosted LAN server (see issue #21 F5). There is
 * currently no server-side compensating SSRF control — `validate_url()` in
 * the Python server's security.py is dead code (never called from
 * api_server.py or llm_interface.py), so the only remaining protection here
 * is blocking the well-known cloud metadata address below. We block: empty
 * URLs, dangerous schemes (javascript/data/file), non-http(s) schemes,
 * malformed URLs, and the cloud metadata endpoint (a genuine
 * credential-exfiltration target even for a client app), including its IPv6
 * forms.
 */
function validateStreamUrl(url: string): void {
  if (!url || url.trim() === '') {
    throw new ApiError(400, 'Invalid URL: URL must not be empty');
  }

  const trimmed = url.trim();

  // Allow relative same-origin paths (inherently same-origin)
  if (trimmed.startsWith('/')) {
    return;
  }

  // Must be an absolute URL to validate further
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError(
      400,
      'Invalid URL: must be a relative path or an absolute http/https URL'
    );
  }

  // Block dangerous schemes
  const blockedSchemes = ['javascript:', 'data:', 'file:'];
  const scheme = parsed.protocol.toLowerCase();
  if (blockedSchemes.includes(scheme)) {
    throw new ApiError(400, `Invalid URL: scheme "${scheme}" is not allowed`);
  }

  // Only allow http and https for absolute URLs
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new ApiError(400, `Invalid URL: scheme "${scheme}" is not allowed`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Block the cloud metadata endpoint — a genuine SSRF/credential target even
  // for client-side code. All other private/LAN/loopback hosts are permitted
  // (this app's realistic deployment is a self-hosted LAN server).
  if (hostname === '169.254.169.254' || isIpv6MetadataAddress(hostname)) {
    throw new ApiError(400, `Invalid URL: host "${hostname}" is not allowed`);
  }
}

/**
 * Returns true if the (already-lowercased, unbracketed) hostname is an IPv6
 * representation of the cloud metadata address 169.254.169.254. Covers the
 * IPv4-mapped-IPv6 form (::ffff:169.254.169.254, which the WHATWG URL parser
 * canonicalizes to ::ffff:a9fe:a9fe) and the IPv6 link-local encoding of the
 * same bytes (fe80::a9fe:a9fe — 169.254.169.254 is a9fe:a9fe in hex).
 *
 * General fe80::/10 link-local addresses are otherwise intentionally allowed
 * (see the LAN-use carve-out above); only this specific metadata-equivalent
 * address is blocked.
 */
function isIpv6MetadataAddress(hostname: string): boolean {
  return hostname === '::ffff:a9fe:a9fe' || hostname === 'fe80::a9fe:a9fe';
}

/**
 * How long to wait for the FIRST chunk of the stream response before giving
 * up and aborting. A server that accepts the connection but never sends or
 * closes it would otherwise hang indefinitely, recoverable only via a manual
 * Cancel click. This does NOT cap total stream duration — it is cleared as
 * soon as any data (or stream close) arrives, since generation itself may
 * legitimately run long once it has started.
 */
const FIRST_BYTE_TIMEOUT_MS = 30_000;

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
  private _starting: boolean = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private onTokenCallbacks: TokenCallback[] = [];
  private onDoneCallbacks: DoneCallback[] = [];
  private onErrorCallbacks: ErrorCallback[] = [];
  private decoder: TextDecoder;
  /**
   * True once a terminal event (done/error) has been emitted. Used by the
   * end-of-stream fallback so a server that closes the connection WITHOUT a
   * terminal SSE payload still resolves the UI — otherwise isLoading sticks
   * forever. (issue #21 F6)
   */
  private _terminated: boolean = false;
  /**
   * Timer that aborts the stream if no data (or stream close) is received
   * within FIRST_BYTE_TIMEOUT_MS of starting the request. Cleared as soon as
   * the first `reader.read()` resolves, so it never caps the duration of an
   * in-progress stream — only the time to first response. (issue #21 F-NO-FETCH-TIMEOUT)
   */
  private firstByteTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /**
   * True while an in-flight abort was triggered by the first-byte timeout
   * (as opposed to a user-initiated stop()). Lets the AbortError handlers
   * tell the two cases apart: a manual cancel stays silent, but a timeout
   * must still surface as an error so the UI reaches a terminal state.
   */
  private _timedOut: boolean = false;

  /**
   * Create a new SSEStreamConsumer.
   * @param url - The endpoint URL to POST to
   * @param body - The request body object
   * @param token - Optional authorization token
   */
  constructor(url: string, body: object, token?: string) {
    validateStreamUrl(url);
    this.url = url;
    this.body = body;
    this.token = token;
    this.decoder = new TextDecoder();
  }

  /**
   * Clears the first-byte timeout, if one is pending. Safe to call multiple
   * times or when no timeout is pending.
   */
  private clearFirstByteTimeout(): void {
    if (this.firstByteTimeoutId !== null) {
      clearTimeout(this.firstByteTimeoutId);
      this.firstByteTimeoutId = null;
    }
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
  async start(): Promise<void> {
    if (this._starting) return;
    this._starting = true;

    try {
      if (this.controller) {
        await this.stop();
      }

      this.controller = new AbortController();
      this._timedOut = false;

      // Guard against a server that accepts the connection but never sends or
      // closes it: abort if no response data has arrived within
      // FIRST_BYTE_TIMEOUT_MS. Cleared on the first `reader.read()` result in
      // readStream() (or by stop()), so it never caps the whole generation —
      // only the wait for the first chunk. (issue #21 F-NO-FETCH-TIMEOUT)
      this.clearFirstByteTimeout();
      this.firstByteTimeoutId = setTimeout(() => {
        this._timedOut = true;
        this.controller?.abort();
      }, FIRST_BYTE_TIMEOUT_MS);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.body),
        signal: this.controller.signal,
      });
      if (!response.ok) {
        throw new ApiError(response.status, `HTTP error: ${response.status}`);
      }

      if (!response.body) {
        throw new ApiError(500, 'Response body is null');
      }

      this.reader = response.body.getReader();
      this.readStream();
    } catch (error) {
      this.clearFirstByteTimeout();
      if (error instanceof ApiError) {
        this.emitError(error.detail);
      } else if ((error as Error).name === 'AbortError') {
        if (this._timedOut) {
          // Automatic first-byte timeout, not a user cancel — surface it so
          // the UI reaches a terminal state instead of hanging indefinitely.
          this.emitError('Request timed out waiting for a response');
        }
        // Otherwise: stream was cancelled via stop(), not an error.
      } else {
        this.emitError((error as Error).message || 'Network error');
      }
    } finally {
      this._starting = false;
    }
  }

  /**
   * Stop the SSE stream connection.
   * Aborts the fetch request and cleans up resources.
   */
  async stop(): Promise<void> {
    this.clearFirstByteTimeout();

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
      let firstRead = true;

      while (true) {
        const { done, value } = await this.reader.read();

        if (firstRead) {
          // A response arrived (data or immediate close) — the connection is
          // alive, so the first-byte guard no longer applies.
          firstRead = false;
          this.clearFirstByteTimeout();
        }

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

      // End-of-stream fallback: if the server closed the connection without a
      // terminal `done`/`error` SSE event, synthesize an error completion so the
      // UI always reaches a terminal state (otherwise isLoading sticks forever).
      // Safe to double-emit: emitDone/emitError guard on _terminated. (issue #21 F6)
      if (!this._terminated) {
        this.emitError('Stream ended without a completion signal');
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        this.emitError((error as Error).message || 'Stream read error');
      } else if (this._timedOut) {
        // Automatic first-byte timeout fired mid-read — surface it so the UI
        // reaches a terminal state instead of hanging indefinitely.
        this.emitError('Request timed out waiting for a response');
      }
    } finally {
      this.clearFirstByteTimeout();
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
    if (this._terminated) return;
    this._terminated = true;
    for (const callback of this.onDoneCallbacks) {
      callback(data);
    }
  }

  private emitError(error: string): void {
    if (this._terminated) return;
    this._terminated = true;
    for (const callback of this.onErrorCallbacks) {
      callback(error);
    }
  }
}
