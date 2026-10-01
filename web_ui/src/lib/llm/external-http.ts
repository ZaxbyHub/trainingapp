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
  scrubSecrets,
  timeoutError,
  unsendableHeaderError,
  type FailureContext,
} from './provider-error';

/** Default gap allowed between stream chunks once data is flowing. */
export const IDLE_TIMEOUT_MS = 120_000;

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
  return raw.trim().slice(0, 300);
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
    const body = race(response.text(), opts.firstByteTimeoutMs, () =>
      timeoutError(opts.ctx, opts.firstByteTimeoutMs, 'error-body', response.status),
    );
    let raw = '';
    try {
      raw = await body.promise;
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

/** Read a whole (non-stream) body within the first-byte bound. */
export async function readBodyBounded(response: Response, opts: TransportOptions): Promise<string> {
  const body = race(response.text(), opts.firstByteTimeoutMs, () =>
    timeoutError(opts.ctx, opts.firstByteTimeoutMs, 'body', response.status),
  );
  try {
    return await body.promise;
  } finally {
    body.clear();
  }
}

/**
 * Yield the response body line by line (CRLF tolerant) as it streams. The
 * first chunk is bounded by the first-byte timeout, every later chunk by the
 * idle timeout. Stops quietly once `isCancelled()` turns true. The reader is
 * always released.
 */
export async function* readLines(
  response: Response,
  opts: TransportOptions & { isCancelled: () => boolean },
): AsyncGenerator<string> {
  if (!response.body) {
    const text = await readBodyBounded(response, opts);
    for (const line of text.split('\n')) yield line.replace(/\r$/, '');
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (opts.isCancelled()) return;
        yield line.replace(/\r$/, '');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0 && !opts.isCancelled()) yield buffer.replace(/\r$/, '');
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

/** Group streamed lines into SSE frames (blank line terminates a frame). */
export async function* readSseFrames(lines: AsyncGenerator<string>): AsyncGenerator<SseFrame> {
  let event = '';
  let data: string[] = [];
  let errorField: string | undefined;
  const flush = (): SseFrame | null => {
    if (event === '' && data.length === 0 && errorField === undefined) return null;
    const frame: SseFrame = { event: event || 'message', data: data.join('\n') };
    if (errorField !== undefined) frame.errorField = errorField;
    event = '';
    data = [];
    errorField = undefined;
    return frame;
  };
  for await (const line of lines) {
    if (line === '') {
      const frame = flush();
      if (frame) yield frame;
      continue;
    }
    if (line.startsWith(':')) continue;
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
