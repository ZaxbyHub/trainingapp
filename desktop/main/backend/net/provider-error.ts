// Classified external-endpoint failures for the desktop backend
// (universal-provider-settings-overhaul, AC11). Mirrors the browser module
// web_ui/src/lib/llm/provider-error.ts so both apps show the same kinds and
// fixes. Messages NEVER contain the API key: upstream text passes through
// scrubSecrets() before it can reach an error frame, a response or a log.

export type ProviderFailureKind = 'network' | 'auth' | 'model' | 'timeout' | 'server' | 'other';

export class ExternalProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly status?: number;

  constructor(kind: ProviderFailureKind, message: string, status?: number) {
    super(message);
    this.name = 'ExternalProviderError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** Remove the key (and anything shaped like a provider key) from text. */
export function scrubSecrets(text: string, apiKey?: string | null): string {
  let out = String(text ?? '');
  const key = (apiKey ?? '').trim();
  if (key.length > 0) {
    out = out.split(key).join('[redacted]');
    if (key.length >= 8) {
      out = out.split(key.slice(0, 8)).join('[redacted]');
      out = out.split(key.slice(-8)).join('[redacted]');
    }
  }
  return out.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[redacted]');
}

export interface FailureContext {
  origin: string;
  model?: string;
  apiKey?: string | null;
}

const HINT = 'Settings → External model';

export function authError(ctx: FailureContext, status?: number, upstream?: string): ExternalProviderError {
  const detail = upstream ? ` (${scrubSecrets(upstream, ctx.apiKey).slice(0, 200)})` : '';
  return new ExternalProviderError(
    'auth',
    `Authentication failed${status ? ` (HTTP ${status})` : ''}: ${ctx.origin} rejected the API key${detail}. Check the API key in ${HINT}.`,
    status,
  );
}

export function modelError(ctx: FailureContext, status?: number, upstream?: string): ExternalProviderError {
  const detail = upstream ? ` (${scrubSecrets(upstream, ctx.apiKey).slice(0, 200)})` : '';
  return new ExternalProviderError(
    'model',
    `Unknown model "${ctx.model ?? ''}"${status ? ` (HTTP ${status})` : ''}: ${ctx.origin} does not serve that model${detail}. Pick a model from the endpoint's list in ${HINT}.`,
    status,
  );
}

export function networkError(ctx: FailureContext, reason?: string): ExternalProviderError {
  return new ExternalProviderError(
    'network',
    `Cannot reach ${ctx.origin}${reason ? ` (${scrubSecrets(reason, ctx.apiKey)})` : ''}. Check that the server is running and the base URL is right.`,
  );
}

export function refusedError(ctx: FailureContext, reason: string): ExternalProviderError {
  return new ExternalProviderError('network', `Refused to contact ${ctx.origin}: ${reason}`);
}

export function timeoutError(
  ctx: FailureContext,
  ms: number,
  phase: 'first-byte' | 'idle' | 'error-body',
  status?: number,
): ExternalProviderError {
  const what =
    phase === 'first-byte'
      ? `it accepted the request but sent no data within ${ms}ms`
      : phase === 'idle'
        ? `the stream went silent for more than ${ms}ms`
        : `it sent a ${status ?? ''} response whose error body stalled (exceeded ${ms}ms)`;
  return new ExternalProviderError(
    'timeout',
    `The endpoint at ${ctx.origin} timed out: ${what}. The model may still be loading; try again, or check the server.`,
    status,
  );
}

export function serverError(ctx: FailureContext, status: number, upstream?: string): ExternalProviderError {
  const detail = upstream ? `: ${scrubSecrets(upstream, ctx.apiKey).slice(0, 300)}` : '';
  return new ExternalProviderError('server', `The endpoint ${ctx.origin} returned an error (HTTP ${status})${detail}`, status);
}

export function errorForStatus(ctx: FailureContext, status: number, upstream?: string): ExternalProviderError {
  if (status === 401 || status === 403) return authError(ctx, status, upstream);
  if (status === 404) return modelError(ctx, status, upstream);
  return serverError(ctx, status, upstream);
}

/** Best-effort upstream error text from a JSON or plain body. */
export function upstreamMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown } | string; detail?: unknown; message?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
    if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') return body.error.message;
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
  } catch {
    /* not JSON */
  }
  return raw.trim().slice(0, 300);
}
