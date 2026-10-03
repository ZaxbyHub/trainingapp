/**
 * OpenAI-compatible chat generator for the browser app
 * (universal-provider-settings-overhaul; first shipped by PR #138 as a
 * loopback-only direct-chat provider).
 *
 * Speaks the OpenAI wire format (`/v1/chat/completions` SSE, `/v1/models`)
 * used by OpenAI, OpenRouter, LM Studio, Ollama's compat layer, llama-server
 * and vLLM. The endpoint is checked by the shared URL policy
 * (endpoint-policy.ts: loopback, private network, or public https; airgap
 * builds refuse public hosts) BEFORE any request, every request refuses
 * redirects, and every failure is a classified ProviderError (AC11).
 *
 * The service implements LLMService, so the browser app plugs it into
 * RAGOrchestrator for grounded answers (the default) or calls it directly for
 * the opt-in ungrounded "Direct chat".
 */

import type {
  LLMGenerateOptions,
  LLMInferenceMode,
  LLMMessage,
  LLMModelInfo,
  LLMProgress,
  LLMService,
} from '../../types/llm';
import { validateEndpointUrl } from './endpoint-policy';
import {
  MAX_COMPLETION_BODY_BYTES,
  MAX_MODEL_LIST_BYTES,
  MAX_STREAMED_ANSWER_BYTES,
  openRequest,
  readBodyBounded,
  readLines,
  utf8ByteLength,
  type TransportOptions,
} from './external-http';
import { ProviderError, responseTooLargeError, scrubSecrets, type FailureContext } from './provider-error';

/** Provider connection settings. */
export interface ProviderConfig {
  baseUrl: string;
  model: string;
  /** Optional; when empty NO Authorization header is sent. */
  apiKey: string;
}

/**
 * Normalize a user-entered base URL to the root the OpenAI routes hang off:
 * trim; strip query/fragment; strip a userinfo component; strip ALL trailing
 * slashes; strip a pasted trailing `/chat/completions` or `/models`; append
 * `/v1` unless the final path segment already is `/v1` (case-insensitive).
 * Shared by generation, model listing and the probe so all hit one surface.
 */
export function normalizeProviderBaseUrl(raw: string): string {
  let url = (raw ?? '').trim();
  if (!url) return '';
  url = url.replace(/[?#].*$/, '');
  url = url.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  url = url.replace(/\/models$/i, '');
  const finalSegment = url.split('/').pop() ?? '';
  if (finalSegment.toLowerCase() !== 'v1') {
    url = `${url}/v1`;
  }
  return url;
}

/**
 * Check the RAW configured base URL against the shared endpoint policy and
 * return the normalized base plus the failure context. Throws a ProviderError
 * (kind 'other', message naming the policy rule) before any network access.
 */
export function resolveEndpoint(
  rawBase: string,
  model: string,
  apiKey: string,
  normalize: (raw: string) => string,
): { base: string; ctx: FailureContext } {
  const verdict = validateEndpointUrl(rawBase);
  if (!verdict.ok) {
    throw new ProviderError('other', `${verdict.message}. Fix the base URL in Settings → Model & connection.`);
  }
  const base = normalize(rawBase);
  let origin = base;
  try {
    origin = new URL(base).origin;
  } catch {
    /* validated above; keep the raw base for the message */
  }
  return { base, ctx: { origin, model, apiKey } };
}

/**
 * How long to wait for the FIRST byte of the provider response (headers +
 * first generated token). Parity with the desktop SSE precedent (#133): a
 * cold model load or long prompt evaluation on a local server takes minutes.
 * Cleared as soon as data arrives; later gaps are bounded by the idle timeout.
 */
export const FIRST_BYTE_TIMEOUT_MS = 600_000;

/**
 * One classified OpenAI SSE line. `deltas` carries answer text; `error`
 * carries a provider-reported failure (mid-stream `data:{"error":...}` frames
 * and llama-server-style `error:` lines — surfaced as a THROW, never as a
 * silent empty answer); `done` marks `data: [DONE]`; `finish` marks any
 * `choices[].finish_reason`. `reasoning_content`-only deltas are NOT answer
 * text (F-003): a reasoning-only reply ends in an explicit error.
 */
export interface OpenAISseLine {
  deltas: string[];
  error?: string;
  done?: boolean;
  finish?: boolean;
}

/** Classify ONE SSE line. */
export function parseOpenAISseLine(rawLine: string): OpenAISseLine {
  const line = rawLine.trim();
  if (!line) return { deltas: [] };
  if (line.startsWith('error:')) {
    const payload = line.slice('error:'.length).trim();
    let message = payload;
    try {
      const frame = JSON.parse(payload) as { message?: unknown; error?: { message?: unknown } };
      const nested =
        typeof frame.message === 'string'
          ? frame.message
          : typeof frame.error?.message === 'string'
            ? frame.error.message
            : undefined;
      if (nested) message = nested;
    } catch {
      // plain-text error body — use it verbatim
    }
    return { deltas: [], error: message || 'the endpoint reported a stream error' };
  }
  if (!line.startsWith('data:')) return { deltas: [] };
  const payload = line.slice('data:'.length).trim();
  if (!payload) return { deltas: [] };
  if (payload === '[DONE]') return { deltas: [], done: true };
  try {
    const frame = JSON.parse(payload) as {
      error?: unknown;
      choices?: Array<{
        delta?: { content?: string };
        finish_reason?: string | null;
      }>;
    };
    if (frame.error !== undefined && frame.error !== null) {
      const message =
        typeof frame.error === 'string'
          ? frame.error
          : typeof (frame.error as { message?: unknown }).message === 'string'
            ? (frame.error as { message: string }).message
            : JSON.stringify(frame.error);
      return { deltas: [], error: message || 'the endpoint reported a stream error' };
    }
    const out: OpenAISseLine = { deltas: [] };
    const choice = frame.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta !== '') out.deltas.push(delta);
    if (choice?.finish_reason) out.finish = true;
    return out;
  } catch {
    // Keep-alive/comment frame — skip.
    return { deltas: [] };
  }
}

/**
 * Actionable failure message for a stream that produced no answer text
 * (F-003: empty 200s, reasoning-only output, clean closes before content).
 */
function emptyStreamMessage(sawFinish: boolean, sawDone: boolean): string {
  if (sawFinish) {
    return 'The endpoint finished without producing any answer text (the model may have returned only reasoning content). Check the server logs or try a different model.';
  }
  return `The endpoint closed the stream without sending any content${
    sawDone ? ' (the [DONE] sentinel arrived, but no answer frames preceded it)' : ''
  }. Is the model loaded on the server?`;
}

/** Answer from a non-streamed JSON completion (server ignored stream:true). */
function extractNonStreamAnswer(body: string, ctx: FailureContext): string {
  let frame: {
    error?: { message?: unknown } | string;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  try {
    frame = JSON.parse(body) as typeof frame;
  } catch {
    throw new ProviderError('server', `The endpoint ${ctx.origin} returned a JSON response that could not be parsed.`);
  }
  if (frame.error !== undefined && frame.error !== null) {
    const message =
      typeof frame.error === 'string'
        ? frame.error
        : typeof frame.error.message === 'string'
          ? frame.error.message
          : JSON.stringify(frame.error);
    throw new ProviderError('server', scrubSecrets(message || 'The endpoint reported an error', ctx.apiKey));
  }
  const content = frame.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new ProviderError('server', 'The endpoint returned a JSON response without choices[0].message.content');
  }
  if (content.trim() === '') {
    throw new ProviderError('other', emptyStreamMessage(true, false));
  }
  return content;
}

function bearerHeaders(apiKey: string, json: boolean): Record<string, string> {
  const headers: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {};
  if (apiKey.trim() !== '') headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

/**
 * Browser-side OpenAI-compatible chat service (LLMService). Also exposes the
 * standalone `chat()` entry point: works without initialize(), sends the
 * messages array verbatim and resolves the concatenated answer.
 */
export class OpenAICompatChatService implements LLMService {
  private readonly config: ProviderConfig;
  private readonly firstByteTimeoutMs: number;
  private readonly idleTimeoutMs: number | undefined;
  private ready = false;
  private controller: AbortController | null = null;

  constructor(cfg: { baseUrl: string; model: string; apiKey?: string; firstByteTimeoutMs?: number; idleTimeoutMs?: number }) {
    this.config = {
      baseUrl: cfg.baseUrl ?? '',
      model: cfg.model ?? '',
      apiKey: cfg.apiKey ?? '',
    };
    this.firstByteTimeoutMs = cfg.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
    this.idleTimeoutMs = cfg.idleTimeoutMs;
  }

  private endpoint(): { base: string; ctx: FailureContext } {
    return resolveEndpoint(this.config.baseUrl, this.config.model, this.config.apiKey, normalizeProviderBaseUrl);
  }

  /** Resolve the concatenated answer for `messages` (sent verbatim). */
  async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
    return this.generateComplete(messages as LLMMessage[]);
  }

  // ---- LLMService seam -------------------------------------------------

  initialize(_modelId?: string, onProgress?: (progress: LLMProgress) => void): Promise<void> {
    // A remote endpoint needs no local load; validate the config so failures
    // surface as a readiness problem instead of a mid-send network error.
    this.endpoint();
    if (!this.config.model.trim()) {
      return Promise.reject(new ProviderError('model', 'No model is selected. Choose one in Settings → Model & connection.'));
    }
    onProgress?.({ progress: 1, timeElapsed: 0, text: 'External model configured' });
    this.ready = true;
    return Promise.resolve();
  }

  async *generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal }
  ): AsyncGenerator<string> {
    const { base, ctx } = this.endpoint();
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
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      stream: true,
    };
    if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    let opened: Awaited<ReturnType<typeof openRequest>> = null;
    try {
      opened = await openRequest(
        `${base}/chat/completions`,
        { method: 'POST', headers: bearerHeaders(this.config.apiKey, true), body: JSON.stringify(body) },
        transport,
      );
      if (opened === null) return; // cancelled before headers
      const response = opened.response;
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        // Server ignored stream:true — read the single JSON completion (F-003).
        const raw = await readBodyBounded(response, transport, {
          maxBytes: MAX_COMPLETION_BODY_BYTES,
          what: 'a completion body',
        });
        yield extractNonStreamAnswer(raw, ctx);
        return;
      }
      let text = '';
      /** UTF-8 bytes of `text`, counted per delta (never re-measured whole). */
      let textBytes = 0;
      let sawFinish = false;
      let sawDone = false;
      for await (const raw of readLines(response, { ...transport, isCancelled: () => controller.signal.aborted })) {
        const line = parseOpenAISseLine(raw);
        // F-010: upstream text is scrubbed of the key like every other error path.
        if (line.error) throw new ProviderError('server', scrubSecrets(line.error, ctx.apiKey));
        if (line.done) sawDone = true;
        if (line.finish) sawFinish = true;
        for (const delta of line.deltas) {
          // PR #142 closeout F-003: cap the whole answer in bytes, checked
          // BEFORE the delta is kept or yielded (what was shown stays shown);
          // the throw aborts the request (finally below).
          const deltaBytes = utf8ByteLength(delta);
          if (textBytes + deltaBytes > MAX_STREAMED_ANSWER_BYTES) {
            throw responseTooLargeError(ctx, 'an answer', MAX_STREAMED_ANSWER_BYTES);
          }
          textBytes += deltaBytes;
          text += delta;
          yield delta;
        }
      }
      if (controller.signal.aborted) return;
      if (text.trim() === '') throw new ProviderError('other', emptyStreamMessage(sawFinish, sawDone));
    } finally {
      opened?.abort();
      options?.signal?.removeEventListener('abort', onCallerAbort);
      if (this.controller === controller) this.controller = null;
    }
  }

  async generateComplete(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal }
  ): Promise<string> {
    let out = '';
    for await (const delta of this.generate(messages, options)) {
      out += delta;
    }
    return out;
  }

  getInferenceMode(): LLMInferenceMode {
    return 'openai-compat';
  }

  getModelInfo(): LLMModelInfo | null {
    return {
      modelId: this.config.model,
      quantization: 'remote',
      sizeBytes: 0,
      cached: true,
    };
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
 * List the model ids an OpenAI-compatible endpoint serves (GET {base}/models,
 * Bearer auth when a key is set), in the server's order. Rejects with a
 * classified ProviderError — never an empty success — on any failure.
 */
export async function listOpenAIModels(
  cfg: { baseUrl: string; apiKey?: string },
  opts?: { timeoutMs?: number; signal?: AbortSignal; model?: string },
): Promise<string[]> {
  const apiKey = cfg.apiKey ?? '';
  const { base, ctx } = resolveEndpoint(cfg.baseUrl, opts?.model ?? '', apiKey, normalizeProviderBaseUrl);
  const transport: TransportOptions = { ctx, firstByteTimeoutMs: opts?.timeoutMs ?? 15_000, signal: opts?.signal };
  const opened = await openRequest(`${base}/models`, { method: 'GET', headers: bearerHeaders(apiKey, false) }, transport);
  if (opened === null) throw new ProviderError('other', 'Model listing was cancelled.');
  try {
    const raw = await readBodyBounded(opened.response, transport, { maxBytes: MAX_MODEL_LIST_BYTES, what: 'a model list' });
    let parsed: { data?: Array<{ id?: unknown }> };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new ProviderError('server', `${ctx.origin} did not return a JSON model list from /models.`);
    }
    if (!Array.isArray(parsed.data)) {
      throw new ProviderError('server', `${ctx.origin} returned a model list without a data array.`);
    }
    return parsed.data.map((m) => m?.id).filter((id): id is string => typeof id === 'string' && id !== '');
  } finally {
    opened.abort();
  }
}
