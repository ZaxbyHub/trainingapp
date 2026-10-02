/**
 * Browser transport shared by the external generators and the connection
 * probe (universal-provider-settings-overhaul, AC2/AC3/AC11/AC14):
 *
 *   - every request uses `redirect: 'error'` (a 3xx is refused, so the key is
 *     never replayed to a redirect target), `credentials: 'omit'` (no ambient
 *     cookies to a third-party endpoint) and `cache: 'no-store'`;
 *   - a FIRST-BYTE watchdog bounds the pre-headers window, a non-OK error-body
 *     read and the first body chunk; an IDLE watchdog bounds every later gap
 *     between chunks (a model may legitimately stream for a long time, but a
 *     silent stream must not hang the UI forever);
 *   - failures are classified ProviderErrors (auth / model / network / timeout
 *     / server) whose messages are scrubbed of the API key.
 *
 * The browser cannot resolve DNS, so connect-time address checks are a
 * desktop-only defense (ADR-0011); the URL policy check runs before any call.
 */
import {
  ProviderError,
  errorForStatus,
  isHeaderSafeValue,
  networkError,
  responseTooLargeError,
  scrubSecrets,
  timeoutError,
  unsendableHeaderError,
  type FailureContext,
} from './provider-error';

/** Default gap allowed between stream chunks once data is flowing. */
export const IDLE_TIMEOUT_MS = 120_000;

/*
 * F-003 (PR #142 review): every upstream-controlled buffer is byte-capped
 * (twins of the desktop lane's limits). Timeouts bound how LONG a read may
 * take, these bound how MUCH it may hold. Exceeding a cap aborts the request
 * with a classified ProviderError (kind 'server'); an over-long error body is
 * truncated instead, so a 401/404 keeps its auth/model classification.
 */
/** One SSE line, and one assembled SSE frame (event + data lines). */
export const MAX_SSE_LINE_BYTES = 1024 * 1024;
export const MAX_SSE_FRAME_BYTES = 1024 * 1024;
/** A non-streamed completion body (server ignored stream:true). */
export const MAX_COMPLETION_BODY_BYTES = 8 * 1024 * 1024;
/**
 * The whole streamed answer, in UTF-8 bytes (PR #142 closeout F-003). The idle
 * timer bounds only the gap between chunks and a server may ignore
 * max_tokens, so the accumulated answer text needs its own cap. Enforced by
 * the providers (openai-provider.ts, anthropic-provider.ts) per delta.
 */
export const MAX_STREAMED_ANSWER_BYTES = 8 * 1024 * 1024;
/** A model listing: the whole listing, every page together. */
export const MAX_MODEL_LIST_BYTES = 4 * 1024 * 1024;
/** How much of a non-2xx error body is read for the message. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface TransportOptions {
  ctx: FailureContext;
  firstByteTimeoutMs: number;
  idleTimeoutMs?: number;
  /** Caller cancellation (Stop / interrupt). */
  signal?: AbortSignal;
}

/**
 * jsdom + undici reject cross-realm AbortSignal instances ("Expected signal
 * to be an instance of AbortSignal"); only hand fetch a signal this realm's
 * Request accepts. Cancellation still works through the reader/watchdog path
 * when the signal cannot be passed.
 */
function fetchableSignal(signal: AbortSignal): AbortSignal | undefined {
  try {
    new Request('http://127.0.0.1/', { method: 'POST', signal });
    return signal;
  } catch {
    return undefined;
  }
}

/** Best-effort upstream error text from a JSON or plain body. */
export function upstreamMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as {
      error?: { message?: unknown } | string;
      detail?: unknown;
      message?: unknown;
    };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
    if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') return body.error.message;
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
  } catch {
    /* not JSON */
  }
  // PR #142 Stage B (parity with desktop provider-error.ts): callers scrub,
  // THEN cut to 200-300 characters; this bound only keeps the scrub input
  // small. Cutting to 300 here, before the scrub, could split an echoed key
  // across the cut so the scrub no longer recognises (and masks) its prefix.
  return raw.trim().slice(0, 4096);
}

/** UTF-8 byte length of a string, without allocating an encoded copy. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Read a body through a counting reader, never holding more than `maxBytes`.
 * Resolves `{ text, truncated }`; on overflow it stops pulling, cancels the
 * stream and returns the first `maxBytes` bytes with `truncated: true`.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        text += decoder.decode(value.subarray(0, maxBytes - bytes), { stream: true });
        truncated = true;
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return { text, truncated };
}

function race<T>(work: Promise<T>, ms: number, onTimeout: () => ProviderError): { promise: Promise<T>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return {
    promise: Promise.race([work, timeout]),
    clear: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export interface OpenedStream {
  response: Response;
  /** Abort the underlying request (idempotent). */
  abort: () => void;
}

/**
 * Issue one request and wait for a successful response's headers. Resolves
 * null when the caller cancelled before headers arrived. Rejects with a
 * classified ProviderError on any failure (non-2xx included).
 */
export async function openRequest(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  opts: TransportOptions,
): Promise<OpenedStream | null> {
  // A header value fetch() would refuse (a key with a character outside
  // Latin-1, CR/LF ...) fails classified and key-free, before any request.
  for (const value of Object.values(init.headers)) {
    if (!isHeaderSafeValue(value)) throw unsendableHeaderError(opts.ctx);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cancelled = () => opts.signal?.aborted === true;
  if (cancelled()) return null;
  opts.signal?.addEventListener('abort', abort);
  let timedOut = false;
  const watchdog = race(
    fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: fetchableSignal(controller.signal),
    }),
    opts.firstByteTimeoutMs,
    () => {
      timedOut = true;
      abort();
      return timeoutError(opts.ctx, opts.firstByteTimeoutMs, 'first-byte');
    },
  );
  let response: Response;
  try {
    response = await watchdog.promise;
  } catch (err) {
    watchdog.clear();
    opts.signal?.removeEventListener('abort', abort);
    if (err instanceof ProviderError) throw err;
    if (cancelled() && !timedOut) return null;
    // Residual guard: a header TypeError from fetch() (its text may quote the
    // value) is reported as the classified, key-free unsendable-key error.
    if (err instanceof TypeError && /header|ISO-8859-1|ByteString/i.test(err.message)) {
      throw unsendableHeaderError(opts.ctx);
    }
    throw networkError(opts.ctx, err);
  }
  if (cancelled()) {
    watchdog.clear();
    void response.body?.cancel().catch(() => undefined);
    opts.signal?.removeEventListener('abort', abort);
    return null;
  }
  if (!response.ok) {
    // The pre-headers bound stays armed through the error-body read so a
    // stalled 5xx body fails bounded rather than hanging.
    watchdog.clear();
    // F-003: at most MAX_ERROR_BODY_BYTES are buffered; a longer body is
    // truncated (not a new error kind) so the status keeps its class.
    const body = race(readCapped(response, MAX_ERROR_BODY_BYTES), opts.firstByteTimeoutMs, () =>
      timeoutError(opts.ctx, opts.firstByteTimeoutMs, 'error-body', response.status),
    );
    let raw = '';
    try {
      raw = (await body.promise).text;
    } finally {
      body.clear();
      opts.signal?.removeEventListener('abort', abort);
      abort();
    }
    throw errorForStatus(opts.ctx, response.status, upstreamMessage(raw));
  }
  watchdog.clear();
  return {
    response,
    abort: () => {
      opts.signal?.removeEventListener('abort', abort);
      abort();
    },
  };
}

/** What a capped whole-body read is for (names the cap in the error). */
export interface BodyLimit {
  maxBytes: number;
  /** e.g. 'a completion body', 'a model list'. */
  what: string;
  /** The cap the error message names when `maxBytes` is what is LEFT of a
   *  shared budget (multi-page listings). Defaults to `maxBytes`. */
  namedLimitBytes?: number;
}

/**
 * Read a whole (non-stream) body within the first-byte bound and the byte
 * cap. Over the cap rejects with responseTooLargeError (kind 'server'); the
 * caller's finally aborts the request.
 */
export async function readBodyBounded(response: Response, opts: TransportOptions, limit: BodyLimit): Promise<string> {
  const body = race(readCapped(response, limit.maxBytes), opts.firstByteTimeoutMs, () =>
    timeoutError(opts.ctx, opts.firstByteTimeoutMs, 'body', response.status),
  );
  let result: { text: string; truncated: boolean };
  try {
    result = await body.promise;
  } finally {
    body.clear();
  }
  if (result.truncated) {
    throw responseTooLargeError(opts.ctx, limit.what, limit.namedLimitBytes ?? limit.maxBytes, response.status);
  }
  return result.text;
}

/**
 * Yield the response body line by line (CRLF tolerant) as it streams. The
 * first chunk is bounded by the first-byte timeout, every later chunk by the
 * idle timeout. Stops quietly once `isCancelled()` turns true. The reader is
 * always released.
 */
export async function* readLines(
  response: Response,
  opts: TransportOptions & { isCancelled: () => boolean; maxLineBytes?: number },
): AsyncGenerator<string> {
  const maxLineBytes = opts.maxLineBytes ?? MAX_SSE_LINE_BYTES;
  if (!response.body) return; // no body: no lines
  const reader = response.body.getReader();
  // Lines are split on the 0x0A BYTE before decoding (0x0A never occurs
  // inside a multi-byte UTF-8 sequence), so the cap counts real bytes and a
  // line still waiting for its newline is bounded too (F-003).
  const decoder = new TextDecoder();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const tooLong = () => responseTooLargeError(opts.ctx, 'a stream line', maxLineBytes, response.status);
  const takeLine = (tail: Uint8Array): string => {
    let bytes: Uint8Array;
    if (pending.length === 0) bytes = tail;
    else {
      bytes = new Uint8Array(pendingBytes + tail.byteLength);
      let offset = 0;
      for (const part of pending) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      bytes.set(tail, offset);
    }
    pending = [];
    pendingBytes = 0;
    return decoder.decode(bytes).replace(/\r$/, '');
  };
  let first = true;
  try {
    for (;;) {
      if (opts.isCancelled()) return;
      const ms = first ? opts.firstByteTimeoutMs : opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
      const phase = first ? 'first-byte' : 'idle';
      const read = race(reader.read(), ms, () => timeoutError(opts.ctx, ms, phase));
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await read.promise;
      } catch (err) {
        if (opts.isCancelled()) return;
        if (err instanceof ProviderError) throw err;
        throw networkError(opts.ctx, err);
      } finally {
        read.clear();
      }
      first = false;
      if (opts.isCancelled()) return;
      if (chunk.done) break;
      const value = chunk.value;
      let start = 0;
      for (let nl = value.indexOf(0x0a, start); nl !== -1; nl = value.indexOf(0x0a, start)) {
        if (pendingBytes + (nl - start) > maxLineBytes) throw tooLong();
        const line = takeLine(value.subarray(start, nl));
        start = nl + 1;
        if (opts.isCancelled()) return;
        yield line;
      }
      if (start < value.byteLength) {
        pendingBytes += value.byteLength - start;
        if (pendingBytes > maxLineBytes) throw tooLong();
        pending.push(value.slice(start));
      }
    }
    if (pendingBytes > 0 && !opts.isCancelled()) yield takeLine(new Uint8Array(0));
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** One Server-Sent Events frame (event name + joined data lines). */
export interface SseFrame {
  event: string;
  data: string;
  /** llama-server style `error:` field, when present. */
  errorField?: string;
}

/**
 * Group streamed lines into SSE frames (blank line terminates a frame). The
 * assembled frame is capped at MAX_SSE_FRAME_BYTES (F-003): a server that
 * keeps sending `data:` lines without a blank line cannot grow it unbounded.
 */
export async function* readSseFrames(
  lines: AsyncGenerator<string>,
  limit: { ctx: FailureContext; maxFrameBytes?: number },
): AsyncGenerator<SseFrame> {
  const maxFrameBytes = limit.maxFrameBytes ?? MAX_SSE_FRAME_BYTES;
  let event = '';
  let data: string[] = [];
  let errorField: string | undefined;
  let frameBytes = 0;
  const flush = (): SseFrame | null => {
    if (event === '' && data.length === 0 && errorField === undefined) return null;
    const frame: SseFrame = { event: event || 'message', data: data.join('\n') };
    if (errorField !== undefined) frame.errorField = errorField;
    event = '';
    data = [];
    errorField = undefined;
    frameBytes = 0;
    return frame;
  };
  for await (const line of lines) {
    if (line === '') {
      const frame = flush();
      if (frame) yield frame;
      continue;
    }
    if (line.startsWith(':')) continue;
    frameBytes += utf8ByteLength(line) + 1;
    if (frameBytes > maxFrameBytes) throw responseTooLargeError(limit.ctx, 'a stream event', maxFrameBytes);
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'error') errorField = value;
  }
  const frame = flush();
  if (frame) yield frame;
}

/** Redact a header map for diagnostics (never log keys). */
export function redactHeaders(headers: Record<string, string>, apiKey?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = /authorization|x-api-key/i.test(name) ? '[redacted]' : scrubSecrets(value, apiKey);
  }
  return out;
}
