/**
 * Classified external-provider failures (universal-provider-settings-overhaul,
 * AC11). Every browser generator and the connection probe reject with a
 * ProviderError whose `kind` names the likely cause, and whose message names
 * the likely fix. Messages NEVER contain the API key: anything that echoes
 * upstream text passes through scrubSecrets() first.
 *
 * Kept in its own leaf module (re-exported by external-provider.ts) so the
 * provider services can import it without an import cycle through the
 * generator factory.
 */

export type ProviderFailureKind = 'network' | 'auth' | 'model' | 'timeout' | 'server' | 'other';

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly status?: number;

  constructor(kind: ProviderFailureKind, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** Echoes of at least this many consecutive key characters are redacted (mid-key echoes). */
export const SCRUB_MIN_ECHO_CHARS = 12;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Lower-case one UTF-16 unit, keeping it one unit (case-insensitive matching). */
function foldUnit(unit: string): string {
  const lower = unit.toLowerCase();
  return lower.length === 1 ? lower : unit;
}

interface ScrubView {
  /** One UTF-16 unit per entry of `starts`/`ends` (string index = unit index). */
  hay: string;
  /** [start, end) of the original text each unit came from. */
  starts: number[];
  ends: number[];
}

/**
 * A case-folded view of `text` for matching. With `decode`, the encodings an
 * upstream may echo a key in are folded back to the character they encode:
 * percent-encoding (encodeURIComponent, incl. the 2-byte UTF-8 form of
 * Latin-1 characters) and HTML character references (&amp; &lt; &gt; &quot;
 * &apos;, decimal &#NN; and hex &#xHH;). Without it, the view is the text
 * itself (so a key that literally contains "%41" or "&amp;" still matches).
 */
function scrubView(text: string, decode: boolean): ScrubView {
  let hay = '';
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (unit: string, start: number, end: number): void => {
    hay += foldUnit(unit);
    starts.push(start);
    ends.push(end);
  };
  const hexByte = (at: number): number | null => {
    if (text[at] !== '%') return null;
    const pair = text.slice(at + 1, at + 3);
    return /^[0-9a-fA-F]{2}$/.test(pair) ? Number.parseInt(pair, 16) : null;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (decode && ch === '%') {
      const b1 = hexByte(i);
      if (b1 !== null && b1 < 0x80) {
        push(String.fromCharCode(b1), i, i + 3);
        i += 3;
        continue;
      }
      const b2 = b1 !== null && b1 >= 0xc2 && b1 <= 0xdf ? hexByte(i + 3) : null;
      if (b1 !== null && b2 !== null && b2 >= 0x80 && b2 <= 0xbf) {
        push(String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f)), i, i + 6);
        i += 6;
        continue;
      }
    } else if (decode && ch === '&') {
      const match = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,4}));/.exec(text.slice(i, i + 12));
      if (match !== null) {
        let decoded: string | null = null;
        if (match[1] !== undefined || match[2] !== undefined) {
          const code = match[1] !== undefined ? Number.parseInt(match[1], 10) : Number.parseInt(match[2] as string, 16);
          if (code > 0 && code <= 0xffff) decoded = String.fromCharCode(code);
        } else {
          decoded = NAMED_ENTITIES[(match[3] as string).toLowerCase()] ?? null;
        }
        if (decoded !== null) {
          push(decoded, i, i + match[0].length);
          i += match[0].length;
          continue;
        }
      }
    }
    push(ch, i, i + 1);
    i += 1;
  }
  return { hay, starts, ends };
}

/** Mark (in `marked`, indexed by original offset) every echo of the key found in `view`. */
function markEchoes(view: ScrubView, needleKey: string, marked: Uint8Array): void {
  const { hay } = view;
  const markUnits = (from: number, to: number): void => {
    marked.fill(1, view.starts[from] as number, view.ends[to - 1] as number);
  };
  const markAll = (needle: string): void => {
    if (needle.length === 0) return;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) markUnits(at, at + needle.length);
  };
  // The whole key, and (>= 8 chars) its first and last 8 characters.
  markAll(needleKey);
  if (needleKey.length >= 8) {
    markAll(needleKey.slice(0, 8));
    markAll(needleKey.slice(-8));
  }
  // Mid-key echoes: every window of SCRUB_MIN_ECHO_CHARS units that occurs
  // anywhere in the key marks its span, so the union covers every common run
  // of at least that length.
  const w = SCRUB_MIN_ECHO_CHARS;
  if (needleKey.length < w || hay.length < w) return;
  const grams = new Set<string>();
  for (let start = 0; start + w <= needleKey.length; start += 1) grams.add(needleKey.slice(start, start + w));
  for (let start = 0; start + w <= hay.length; start += 1) {
    if (grams.has(hay.slice(start, start + w))) markUnits(start, start + w);
  }
}

/**
 * Remove the key (and anything shaped like a provider key) from text.
 *
 * PR #142 review F-018: besides the verbatim key, redacts its
 * encodeURIComponent form, its HTML-escaped forms (named and numeric
 * character references), case-variant echoes, the first/last 8 characters,
 * and ANY run of SCRUB_MIN_ECHO_CHARS or more consecutive key characters (a
 * mid-key echo). Ported verbatim from the desktop twin
 * (desktop/main/backend/net/provider-error.ts): keep the two in step.
 */
export function scrubSecrets(text: string, apiKey?: string | null): string {
  const source = String(text ?? '');
  const key = (apiKey ?? '').trim();
  let out = source;
  if (key.length > 0 && source.length > 0) {
    const needleKey = key.split('').map(foldUnit).join('');
    const marked = new Uint8Array(source.length);
    markEchoes(scrubView(source, false), needleKey, marked);
    markEchoes(scrubView(source, true), needleKey, marked);
    // Each maximal marked run of the original text becomes one marker.
    out = '';
    let i = 0;
    while (i < source.length) {
      if (marked[i] !== 1) {
        let j = i;
        while (j < source.length && marked[j] !== 1) j += 1;
        out += source.slice(i, j);
        i = j;
        continue;
      }
      while (i < source.length && marked[i] === 1) i += 1;
      out += '[redacted]';
    }
  }
  return out.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[redacted]');
}

export interface FailureContext {
  /** Origin of the endpoint (scheme://host:port), for the message. */
  origin: string;
  /** Model id the request named (model-kind messages name it). */
  model?: string;
  apiKey?: string;
}

const SETTINGS_HINT = 'Settings → External model';

export function authError(ctx: FailureContext, status?: number, upstream?: string): ProviderError {
  const detail = upstream ? ` (${scrubSecrets(upstream, ctx.apiKey).slice(0, 200)})` : '';
  return new ProviderError(
    'auth',
    `Authentication failed${status ? ` (HTTP ${status})` : ''}: ${ctx.origin} rejected the API key${detail}. Check the API key in ${SETTINGS_HINT}.`,
    status,
  );
}

export function modelError(ctx: FailureContext, status?: number, upstream?: string): ProviderError {
  const detail = upstream ? ` (${scrubSecrets(upstream, ctx.apiKey).slice(0, 200)})` : '';
  return new ProviderError(
    'model',
    `Unknown model "${ctx.model ?? ''}"${status ? ` (HTTP ${status})` : ''}: ${ctx.origin} does not serve that model${detail}. Pick a model from the endpoint's list in ${SETTINGS_HINT}.`,
    status,
  );
}

export function networkError(ctx: FailureContext, cause?: unknown): ProviderError {
  let reason = '';
  if (cause instanceof Error) {
    // undici reports refused redirects / refused connections in `cause`.
    const inner = (cause as { cause?: unknown }).cause;
    const innerMessage = inner instanceof Error ? inner.message : '';
    reason = scrubSecrets(innerMessage && innerMessage !== cause.message ? `${cause.message}: ${innerMessage}` : cause.message, ctx.apiKey);
  }
  return new ProviderError(
    'network',
    `Cannot reach ${ctx.origin}${reason ? ` (${reason})` : ''}. Check that the server is running and the base URL is right (redirects are not followed); in the browser app the server must also allow cross-origin (CORS) requests from this page.`,
  );
}

export function timeoutError(ctx: FailureContext, ms: number, phase: 'first-byte' | 'idle' | 'body' | 'error-body', status?: number): ProviderError {
  const what =
    phase === 'first-byte'
      ? `it accepted the request but sent no data within ${ms}ms`
      : phase === 'idle'
        ? `the stream went silent for more than ${ms}ms`
        : phase === 'error-body'
          ? `it sent a ${status ?? ''} response whose error body stalled (exceeded ${ms}ms)`
          : `it sent a ${status ?? 200} response whose body stalled (exceeded ${ms}ms)`;
  return new ProviderError(
    'timeout',
    `The endpoint at ${ctx.origin} timed out: ${what}. The model may still be loading; try again, or check the server.`,
    status,
  );
}

export function serverError(ctx: FailureContext, status: number, upstream?: string): ProviderError {
  const detail = upstream ? `: ${scrubSecrets(upstream, ctx.apiKey).slice(0, 300)}` : '';
  return new ProviderError('server', `The endpoint ${ctx.origin} returned an error (HTTP ${status})${detail}`, status);
}

/**
 * True when `value` can be sent as an HTTP header value (the key travels as
 * `Authorization: Bearer <key>` or `x-api-key: <key>`): no control characters
 * (CR/LF/NUL/TAB/DEL ...) and nothing outside Latin-1 — fetch() would
 * otherwise throw a TypeError whose text can quote the value. Twin of
 * desktop/main/backend/inference/external-provider.ts isHeaderSafeValue.
 */
export function isHeaderSafeValue(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code > 0xff) return false;
  }
  return true;
}

/** Key-free refusal text for a key that cannot travel in a header. */
export const UNSENDABLE_KEY_MESSAGE =
  'the API key contains a character that cannot be sent in an HTTP header (a control character, a line break, or a character outside Latin-1); paste the key again';

/** The request was not sent because a header value (the key) is unsendable. Never names the value. */
export function unsendableHeaderError(ctx: FailureContext): ProviderError {
  return new ProviderError(
    'auth',
    `The request to ${ctx.origin} was not sent: ${UNSENDABLE_KEY_MESSAGE} in ${SETTINGS_HINT}.`,
  );
}

/**
 * The upstream sent more data than the browser will buffer (F-003): an SSE
 * line or frame, a completion body or a model listing past its byte cap. The
 * request is aborted; kind 'server' (the endpoint misbehaved).
 */
export function responseTooLargeError(ctx: FailureContext, what: string, limitBytes: number, status?: number): ProviderError {
  return new ProviderError(
    'server',
    `The endpoint ${ctx.origin} sent ${what} larger than the ${formatBytes(limitBytes)} limit, so the request was stopped. Check the server, or pick a different endpoint in ${SETTINGS_HINT}.`,
    status,
  );
}

function formatBytes(n: number): string {
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MiB`;
  if (n % 1024 === 0) return `${n / 1024} KiB`;
  return `${n} bytes`;
}

/** Map an HTTP failure status to the classified error. */
export function errorForStatus(ctx: FailureContext, status: number, upstream?: string): ProviderError {
  if (status === 401 || status === 403) return authError(ctx, status, upstream);
  if (status === 404) return modelError(ctx, status, upstream);
  return serverError(ctx, status, upstream);
}

/** Wrap any thrown value into a ProviderError (already-classified errors pass through). */
export function asProviderError(err: unknown, ctx: FailureContext): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError('other', scrubSecrets(message, ctx.apiKey));
}
