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

/**
 * Remove the configured key (and anything shaped like a provider key) from
 * text that may be shown to the user or logged. Keys shorter than 4 chars are
 * still scrubbed verbatim; `sk-` / `sk-ant-` style tokens are always masked.
 */
export function scrubSecrets(text: string, apiKey?: string): string {
  let out = String(text ?? '');
  const key = (apiKey ?? '').trim();
  if (key.length > 0) {
    out = out.split(key).join('[redacted]');
    if (key.length >= 8) {
      // Partial echoes (providers often print the first/last characters).
      out = out.split(key.slice(0, 8)).join('[redacted]');
      out = out.split(key.slice(-8)).join('[redacted]');
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
