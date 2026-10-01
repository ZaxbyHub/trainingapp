/**
 * Anthropic-compatible chat generator for the browser app
 * (universal-provider-settings-overhaul, AC2/AC3).
 *
 * Messages API wire contract:
 *   POST {root}/v1/messages with headers
 *     content-type: application/json
 *     x-api-key: <key>                              (omitted when no key)
 *     anthropic-version: 2023-06-01
 *     anthropic-dangerous-direct-browser-access: true  (required for CORS)
 *   body { model, max_tokens (always present), stream: true, system
 *          (top-level; every system message joined), messages (user /
 *          assistant only, consecutive same-role turns merged, first and last
 *          turn are user turns), temperature? }
 *   Only `content_block_delta` frames with `delta.type === 'text_delta'` are
 *   answer text (thinking / tool-input deltas and pings are ignored); an SSE
 *   `error` event rejects with the provider's message.
 * The base URL may be given with or without a trailing `/v1`.
 */
import type {
  LLMGenerateOptions,
  LLMInferenceMode,
  LLMMessage,
  LLMModelInfo,
  LLMProgress,
  LLMService,
} from '../../types/llm';
import { openRequest, readBodyBounded, readLines, readSseFrames, type TransportOptions } from './external-http';
import { FIRST_BYTE_TIMEOUT_MS, resolveEndpoint } from './openai-provider';
import { ProviderError, authError, modelError, scrubSecrets, type FailureContext } from './provider-error';

export const ANTHROPIC_VERSION = '2023-06-01';
/** The Messages API requires max_tokens; used when the caller passes none. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 1024;
/** Hard cap on model-list pages (a server that keeps saying has_more). */
const MAX_MODEL_PAGES = 50;

/**
 * Normalize a base URL to the API ROOT (no trailing `/v1`): trim, strip
 * query/fragment and userinfo, strip trailing slashes, a pasted `/messages`
 * or `/models` route, then one trailing `/v1`.
 */
export function normalizeAnthropicRoot(raw: string): string {
  let url = (raw ?? '').trim();
  if (!url) return '';
  url = url.replace(/[?#].*$/, '');
  url = url.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/(messages|models)$/i, '');
  url = url.replace(/\/v1$/i, '');
  return url.replace(/\/+$/, '');
}

function anthropicHeaders(apiKey: string, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (json) headers['content-type'] = 'application/json';
  if (apiKey.trim() !== '') headers['x-api-key'] = apiKey;
  return headers;
}

/**
 * Split an LLMMessage list into the Messages API shape: system text joined
 * into the top-level field; user/assistant turns with consecutive same-role
 * turns merged; leading assistant turns dropped (the first turn must be a
 * user turn) and trailing assistant turns dropped (the last turn must be the
 * user's question).
 */
export function toAnthropicMessages(messages: LLMMessage[]): {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const system: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'system') {
      if (content.trim() !== '') system.push(content);
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${content}`;
    else turns.push({ role: m.role, content });
  }
  while (turns.length > 0 && turns[0].role !== 'user') turns.shift();
  while (turns.length > 0 && turns[turns.length - 1].role !== 'user') turns.pop();
  return { system: system.join('\n\n'), messages: turns };
}

/** Map an Anthropic error object (SSE `error` event or error body) to a ProviderError. */
function anthropicStreamError(ctx: FailureContext, error: { type?: unknown; message?: unknown } | undefined): ProviderError {
  const type = typeof error?.type === 'string' ? error.type : '';
  const message = typeof error?.message === 'string' ? error.message : 'the endpoint reported a stream error';
  if (type === 'authentication_error' || type === 'permission_error') return authError(ctx, undefined, message);
  if (type === 'not_found_error') return modelError(ctx, undefined, message);
  return new ProviderError('server', `The endpoint ${ctx.origin} reported an error: ${scrubSecrets(message, ctx.apiKey).slice(0, 300)}`);
}

export class AnthropicCompatChatService implements LLMService {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly firstByteTimeoutMs: number;
  private readonly idleTimeoutMs: number | undefined;
  private ready = false;
  private controller: AbortController | null = null;

  constructor(cfg: { baseUrl: string; model: string; apiKey?: string; firstByteTimeoutMs?: number; idleTimeoutMs?: number }) {
    this.baseUrl = cfg.baseUrl ?? '';
    this.model = cfg.model ?? '';
    this.apiKey = cfg.apiKey ?? '';
    this.firstByteTimeoutMs = cfg.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
    this.idleTimeoutMs = cfg.idleTimeoutMs;
  }

  private endpoint(): { base: string; ctx: FailureContext } {
    return resolveEndpoint(this.baseUrl, this.model, this.apiKey, normalizeAnthropicRoot);
  }

  initialize(_modelId?: string, onProgress?: (progress: LLMProgress) => void): Promise<void> {
    this.endpoint();
    if (!this.model.trim()) {
      return Promise.reject(new ProviderError('model', 'No model is selected. Choose one in Settings → External model.'));
    }
    onProgress?.({ progress: 1, timeElapsed: 0, text: 'External model configured' });
    this.ready = true;
    return Promise.resolve();
  }

  async *generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal },
  ): AsyncGenerator<string> {
    const { base, ctx } = this.endpoint();
    const shaped = toAnthropicMessages(messages);
    if (shaped.messages.length === 0) {
      throw new ProviderError('other', 'There is no user message to send to the external model.');
    }
    const controller = new AbortController();
    this.controller = controller;
    const onCallerAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onCallerAbort);
    if (options?.signal?.aborted) controller.abort();
    const transport: TransportOptions = {
      ctx,
      firstByteTimeoutMs: this.firstByteTimeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
      signal: controller.signal,
    };
    const maxTokens =
      typeof options?.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0
        ? Math.floor(options.maxTokens)
        : DEFAULT_ANTHROPIC_MAX_TOKENS;
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      stream: true,
      messages: shaped.messages,
    };
    if (shaped.system !== '') body.system = shaped.system;
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    let opened: Awaited<ReturnType<typeof openRequest>> = null;
    try {
      opened = await openRequest(
        `${base}/v1/messages`,
        { method: 'POST', headers: anthropicHeaders(this.apiKey, true), body: JSON.stringify(body) },
        transport,
      );
      if (opened === null) return;
      let text = '';
      const lines = readLines(opened.response, { ...transport, isCancelled: () => controller.signal.aborted });
      for await (const frame of readSseFrames(lines)) {
        if (frame.data === '' && frame.event !== 'error') continue;
        let data: { type?: string; delta?: { type?: string; text?: unknown }; error?: { type?: unknown; message?: unknown } } = {};
        try {
          data = JSON.parse(frame.data) as typeof data;
        } catch {
          if (frame.event === 'error') throw anthropicStreamError(ctx, { message: frame.data });
          continue;
        }
        if (frame.event === 'error' || data.type === 'error') throw anthropicStreamError(ctx, data.error);
        if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
          if (data.delta.text === '') continue;
          text += data.delta.text;
          yield data.delta.text;
        }
        if (data.type === 'message_stop') break;
      }
      if (controller.signal.aborted) return;
      if (text.trim() === '') {
        throw new ProviderError(
          'other',
          'The endpoint finished without producing any answer text. Check the server logs or try a different model.',
        );
      }
    } finally {
      opened?.abort();
      options?.signal?.removeEventListener('abort', onCallerAbort);
      if (this.controller === controller) this.controller = null;
    }
  }

  async generateComplete(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal },
  ): Promise<string> {
    let out = '';
    for await (const delta of this.generate(messages, options)) out += delta;
    return out;
  }

  getInferenceMode(): LLMInferenceMode {
    return 'anthropic-compat';
  }

  getModelInfo(): LLMModelInfo | null {
    return { modelId: this.model, quantization: 'remote', sizeBytes: 0, cached: true };
  }

  isReady(): boolean {
    return this.ready;
  }

  interrupt(): void {
    this.controller?.abort();
    this.controller = null;
  }

  dispose(): void {
    this.interrupt();
    this.ready = false;
  }
}

/**
 * List model ids from an Anthropic-compatible endpoint: GET {root}/v1/models,
 * following `has_more` with `after_id=<last_id>` (the Anthropic headers ride
 * every page). Stops on a stuck or missing cursor and after MAX_MODEL_PAGES.
 * Rejects with a classified ProviderError on any non-2xx page.
 */
export async function listAnthropicModels(
  cfg: { baseUrl: string; apiKey?: string },
  opts?: { timeoutMs?: number; signal?: AbortSignal; model?: string },
): Promise<string[]> {
  const apiKey = cfg.apiKey ?? '';
  const { base, ctx } = resolveEndpoint(cfg.baseUrl, opts?.model ?? '', apiKey, normalizeAnthropicRoot);
  const transport: TransportOptions = { ctx, firstByteTimeoutMs: opts?.timeoutMs ?? 15_000, signal: opts?.signal };
  const ids: string[] = [];
  const seenCursors = new Set<string>();
  let afterId: string | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const url = new URL(`${base}/v1/models`);
    url.searchParams.set('limit', '1000');
    if (afterId !== null) url.searchParams.set('after_id', afterId);
    const opened = await openRequest(url.toString(), { method: 'GET', headers: anthropicHeaders(apiKey, false) }, transport);
    if (opened === null) throw new ProviderError('other', 'Model listing was cancelled.');
    let parsed: { data?: Array<{ id?: unknown }>; has_more?: unknown; last_id?: unknown };
    try {
      const raw = await readBodyBounded(opened.response, transport);
      parsed = JSON.parse(raw) as typeof parsed;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('server', `${ctx.origin} did not return a JSON model list from /v1/models.`);
    } finally {
      opened.abort();
    }
    if (!Array.isArray(parsed.data)) {
      throw new ProviderError('server', `${ctx.origin} returned a model list without a data array.`);
    }
    for (const m of parsed.data) {
      if (typeof m?.id === 'string' && m.id !== '' && !ids.includes(m.id)) ids.push(m.id);
    }
    const next = typeof parsed.last_id === 'string' ? parsed.last_id : null;
    if (parsed.has_more !== true || next === null || seenCursors.has(next)) break;
    seenCursors.add(next);
    afterId = next;
  }
  return ids;
}
