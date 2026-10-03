// External generation for the desktop backend (universal-provider-settings-
// overhaul, AC5/AC6/AC8/AC11/AC13/AC14).
//
// Builds the OpenAI (/v1/chat/completions) or Anthropic (/v1/messages)
// streaming request from the SAME retrieval results the local path uses and
// streams `text` deltas back through the engine's streamCallback. Every request
// goes through the guarded client (net/guarded-request.ts): policy + airgap,
// connect-time address validation, pinned connect, no redirects, first-byte
// and idle timeouts, cancellation. The local llama.cpp prompt is untouched —
// this module builds its own message list (system + bounded history + the
// user turn carrying the retrieved passages).
import {
  guardedRequest,
  MAX_COMPLETION_BODY_BYTES,
  MAX_MODEL_LIST_BYTES,
  MAX_SSE_LINE_BYTES,
  MAX_STREAMED_ANSWER_BYTES,
  RequestCancelledError,
  type DnsLookup,
} from '../net/guarded-request.js';
import { ExternalProviderError, oversizeError, scrubSecrets, timeoutError, type FailureContext } from '../net/provider-error.js';
import type { CancellationFlag } from '../types.js';
import { EXTERNAL_GROUNDED_INSTRUCTION, EXTERNAL_GROUNDED_QUESTION_LABEL, EXTERNAL_SYSTEM_PROMPT } from './external-prompts.js';

export type ExternalProtocol = 'openai' | 'anthropic';

// The prompt text lives in its own self-contained module (PR #142 review
// F-004: the browser app keeps a byte-identical twin with a drift test).
// Re-exported here so existing imports keep working.
export { EXTERNAL_SYSTEM_PROMPT } from './external-prompts.js';
export const ANTHROPIC_VERSION = '2023-06-01';
/** The Messages API requires max_tokens. */
export const DEFAULT_EXTERNAL_MAX_TOKENS = 1024;
const MAX_HISTORY_TURNS = 12;
/** PR #142 review F-002: aggregate deadline for one connection test (all pages). */
export const PROBE_TOTAL_TIMEOUT_MS = 30_000;
/** Upstream error text shown in a message (scrubbed first, then cut). */
const UPSTREAM_TEXT_CHARS = 300;
const MAX_HISTORY_CHARS = 4000;

export interface ExternalEndpointConfig {
  protocol: ExternalProtocol;
  baseUrl: string;
  model: string;
  /** null = send no key (none saved, or bound to a different origin). */
  apiKey: string | null;
}

export interface ExternalGenerateInput {
  config: ExternalEndpointConfig;
  question: string;
  /** Retrieved passages (grounded); null/empty = no retrieval context. */
  contextTexts: string[] | null;
  history?: unknown[];
  maxTokens?: number;
  temperature?: number;
  streamCallback?: (token: string) => void;
  cancellationEvent?: CancellationFlag;
  airgap: boolean;
  lookup?: DnsLookup;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/** OpenAI-compatible root ending in /v1 (no doubling; pasted routes stripped). */
export function openAIBase(raw: string): string {
  let url = raw.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '');
  return /\/v1$/i.test(url) ? url : `${url}/v1`;
}

/** Anthropic API root WITHOUT /v1 (routes append /v1/...). */
export function anthropicRoot(raw: string): string {
  let url = raw.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  url = url.replace(/\/(messages|models)$/i, '').replace(/\/v1$/i, '');
  return url.replace(/\/+$/, '');
}

export function originOf(raw: string): string {
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return '';
  }
}

/** The user turn: the question, prefixed by the retrieved passages when grounded. */
export function groundedUserContent(question: string, contextTexts: string[] | null): string {
  if (contextTexts === null || contextTexts.length === 0) return question;
  return `${EXTERNAL_GROUNDED_INSTRUCTION}\n\n${contextTexts
    .map((text, index) => `[${index + 1}] ${text}`)
    .join('\n\n')}\n\n\n${EXTERNAL_GROUNDED_QUESTION_LABEL}${question}`;
}

/** Contract history ({role, content}) -> bounded user/assistant turns. */
export function historyTurns(history?: unknown[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(history)) return [];
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of history) {
    if (typeof turn !== 'object' || turn === null) continue;
    const role = (turn as { role?: unknown }).role;
    const content = (turn as { content?: unknown }).content;
    if (typeof content !== 'string') continue;
    if (role === 'user' || role === 'assistant') out.push({ role, content: content.slice(0, MAX_HISTORY_CHARS) });
  }
  return out.slice(-MAX_HISTORY_TURNS);
}

/** Merge consecutive same-role turns; first and last turns are user turns. */
export function normalizeTurns(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const merged: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.content = `${last.content}\n\n${turn.content}`;
    else merged.push({ ...turn });
  }
  while (merged.length > 0 && merged[0]?.role !== 'user') merged.shift();
  while (merged.length > 0 && merged[merged.length - 1]?.role !== 'user') merged.pop();
  return merged;
}

export function buildExternalRequest(input: ExternalGenerateInput): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const { config } = input;
  const userTurn = { role: 'user' as const, content: groundedUserContent(input.question, input.contextTexts) };
  const turns = normalizeTurns([...historyTurns(input.history), userTurn]);
  if (config.protocol === 'anthropic') {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (config.apiKey !== null && config.apiKey !== '') headers['x-api-key'] = config.apiKey;
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens:
        typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0
          ? Math.floor(input.maxTokens)
          : DEFAULT_EXTERNAL_MAX_TOKENS,
      stream: true,
      system: EXTERNAL_SYSTEM_PROMPT,
      messages: turns,
    };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    return { url: `${anthropicRoot(config.baseUrl)}/v1/messages`, headers, body };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey !== null && config.apiKey !== '') headers.authorization = `Bearer ${config.apiKey}`;
  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    messages: [{ role: 'system', content: EXTERNAL_SYSTEM_PROMPT }, ...turns],
  };
  if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
  if (input.temperature !== undefined) body.temperature = input.temperature;
  return { url: `${openAIBase(config.baseUrl)}/chat/completions`, headers, body };
}

/** One SSE line from an OpenAI-compatible stream (llama-server `error:` lines included). */
function openAILine(line: string): { deltas: string[]; error?: string; done?: boolean; finish?: boolean } {
  const trimmed = line.trim();
  if (trimmed === '') return { deltas: [] };
  if (trimmed.startsWith('error:')) {
    const payload = trimmed.slice(6).trim();
    try {
      const frame = JSON.parse(payload) as { message?: unknown; error?: { message?: unknown } };
      const message =
        typeof frame.message === 'string' ? frame.message : typeof frame.error?.message === 'string' ? frame.error.message : payload;
      return { deltas: [], error: message || 'the endpoint reported a stream error' };
    } catch {
      return { deltas: [], error: payload || 'the endpoint reported a stream error' };
    }
  }
  if (!trimmed.startsWith('data:')) return { deltas: [] };
  const payload = trimmed.slice(5).trim();
  if (payload === '') return { deltas: [] };
  if (payload === '[DONE]') return { deltas: [], done: true };
  try {
    const frame = JSON.parse(payload) as {
      error?: unknown;
      choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown }; finish_reason?: unknown }>;
    };
    if (frame.error !== undefined && frame.error !== null) {
      const message =
        typeof frame.error === 'string'
          ? frame.error
          : typeof (frame.error as { message?: unknown }).message === 'string'
            ? (frame.error as { message: string }).message
            : JSON.stringify(frame.error);
      return { deltas: [], error: message };
    }
    const choice = frame.choices?.[0];
    const out: { deltas: string[]; finish?: boolean } = { deltas: [] };
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta !== '') out.deltas.push(delta);
    if (choice?.finish_reason) out.finish = true;
    return out;
  } catch {
    return { deltas: [] };
  }
}

function anthropicFrameError(
  ctx: FailureContext,
  error: { type?: unknown; message?: unknown } | undefined,
): ExternalProviderError {
  const type = typeof error?.type === 'string' ? error.type : '';
  const message = scrubSecrets(typeof error?.message === 'string' ? error.message : 'the endpoint reported a stream error', ctx.apiKey).slice(
    0,
    UPSTREAM_TEXT_CHARS,
  );
  if (type === 'authentication_error' || type === 'permission_error') {
    return new ExternalProviderError('auth', `Authentication failed: ${ctx.origin} rejected the API key (${message}). Check the API key in Settings → Model & connection.`);
  }
  if (type === 'not_found_error') {
    return new ExternalProviderError('model', `Unknown model "${ctx.model ?? ''}" (${message}). Pick a model from the endpoint's list in Settings → Model & connection.`);
  }
  return new ExternalProviderError('server', `The endpoint ${ctx.origin} reported an error: ${message}`);
}

/**
 * Generate through the external endpoint. Streams text deltas through
 * `streamCallback`; resolves {answer, cancelled}. Rejects with an
 * ExternalProviderError (classified, key-free) on any failure, including a
 * stream that produced no answer text.
 */
export async function generateExternal(input: ExternalGenerateInput): Promise<{ answer: string; cancelled: boolean }> {
  const { config } = input;
  const ctx: FailureContext = { origin: originOf(config.baseUrl), model: config.model, apiKey: config.apiKey };
  const request = buildExternalRequest(input);
  const isCancelled = (): boolean => input.cancellationEvent?.isSet() ?? false;
  if (isCancelled()) return { answer: '', cancelled: true };
  let response;
  try {
    response = await guardedRequest({
      url: request.url,
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      ctx,
      airgap: input.airgap,
      lookup: input.lookup,
      firstByteTimeoutMs: input.firstByteTimeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
      isCancelled,
    });
  } catch (err) {
    if (err instanceof RequestCancelledError) return { answer: '', cancelled: true };
    throw err;
  }
  let answer = '';
  /** UTF-8 bytes of `answer`, counted per delta (never re-measured whole). */
  let answerBytes = 0;
  const emit = (text: string): void => {
    // PR #142 closeout F-003: the accumulated answer is capped in bytes. The
    // check runs BEFORE the delta is kept or streamed, so what the user saw
    // stays at most the cap; the throw aborts the request (finally below).
    const bytes = Buffer.byteLength(text);
    if (answerBytes + bytes > MAX_STREAMED_ANSWER_BYTES) {
      throw oversizeError(ctx, 'an answer', MAX_STREAMED_ANSWER_BYTES);
    }
    answerBytes += bytes;
    answer += text;
    input.streamCallback?.(text);
  };
  try {
    const contentType = String(response.headers['content-type'] ?? '');
    if (config.protocol === 'openai' && contentType.includes('application/json')) {
      // A server that ignored stream:true answers with one JSON completion
      // (byte-capped before JSON.parse, PR #142 review F-003).
      const raw = await response.text(MAX_COMPLETION_BODY_BYTES, 'a completion body');
      let frame: { choices?: Array<{ message?: { content?: unknown } }>; error?: unknown };
      try {
        frame = JSON.parse(raw) as typeof frame;
      } catch {
        throw new ExternalProviderError('server', `The endpoint ${ctx.origin} returned a JSON response that could not be parsed.`);
      }
      const content = frame.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim() !== '') emit(content);
    } else {
      let buffer = '';
      let event = '';
      let data: string[] = [];
      /** Bytes of the pending Anthropic frame's data lines (capped, F-003). */
      let dataBytes = 0;
      let stop = false;
      const flushAnthropicFrame = (): void => {
        if (data.length === 0 && event === '') return;
        const payload = data.join('\n');
        const name = event;
        event = '';
        data = [];
        dataBytes = 0;
        if (payload === '') {
          if (name === 'error') throw anthropicFrameError(ctx, undefined);
          return;
        }
        let parsed: { type?: string; delta?: { type?: string; text?: unknown }; error?: { type?: unknown; message?: unknown } };
        try {
          parsed = JSON.parse(payload) as typeof parsed;
        } catch {
          if (name === 'error') throw anthropicFrameError(ctx, { message: payload });
          return;
        }
        if (name === 'error' || parsed.type === 'error') throw anthropicFrameError(ctx, parsed.error);
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
          if (parsed.delta.text !== '') emit(parsed.delta.text);
        }
        if (parsed.type === 'message_stop') stop = true;
      };
      const handleLine = (rawLine: string): void => {
        const line = rawLine.replace(/\r$/, '');
        if (config.protocol === 'openai') {
          const parsed = openAILine(line);
          if (parsed.error !== undefined) {
            throw new ExternalProviderError(
              'server',
              `The endpoint ${ctx.origin} reported an error: ${scrubSecrets(parsed.error, ctx.apiKey).slice(0, UPSTREAM_TEXT_CHARS)}`,
            );
          }
          for (const delta of parsed.deltas) emit(delta);
          if (parsed.done) stop = true;
          return;
        }
        if (line === '') {
          flushAnthropicFrame();
          return;
        }
        if (line.startsWith(':')) return;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') {
          dataBytes += Buffer.byteLength(value) + 1;
          if (dataBytes > MAX_SSE_LINE_BYTES) throw oversizeError(ctx, 'a stream frame', MAX_SSE_LINE_BYTES);
          data.push(value);
        }
      };
      // PR #142 review F-003: no line (complete or pending) may exceed
      // MAX_SSE_LINE_BYTES, so neither the line buffer nor a JSON.parse input
      // grows without bound; the throw aborts the request (finally below).
      const checkLine = (line: string): void => {
        if (line.length > MAX_SSE_LINE_BYTES / 4 && Buffer.byteLength(line) > MAX_SSE_LINE_BYTES) {
          throw oversizeError(ctx, 'a stream line', MAX_SSE_LINE_BYTES);
        }
      };
      for await (const chunk of response.chunks()) {
        if (isCancelled()) break;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        checkLine(buffer);
        for (const line of lines) {
          checkLine(line);
          handleLine(line);
          if (stop) break;
        }
        if (stop) break;
      }
      if (!stop && !isCancelled()) {
        if (buffer !== '') handleLine(buffer);
        if (config.protocol === 'anthropic') flushAnthropicFrame();
      }
    }
  } finally {
    response.abort();
  }
  if (isCancelled()) return { answer, cancelled: true };
  if (answer.trim() === '') {
    throw new ExternalProviderError(
      'other',
      `The endpoint ${ctx.origin} finished without producing any answer text. Check the server logs or try a different model.`,
    );
  }
  return { answer, cancelled: false };
}

/**
 * List model ids (connection test): OpenAI data[].id, or Anthropic pages via
 * has_more/after_id.
 *
 * PR #142 review F-002: the WHOLE listing (every page, every byte) runs under
 * one aggregate deadline (`totalTimeoutMs`, default PROBE_TOTAL_TIMEOUT_MS):
 * the per-request first-byte/idle timers re-arm on every chunk, so they alone
 * never bound a slow-drip endpoint. Past the deadline the in-flight request is
 * aborted and the listing rejects with a 'timeout' error. `signal` (the
 * client disconnected) aborts the in-flight request and rejects with
 * RequestCancelledError. The listing's bodies share ONE MAX_MODEL_LIST_BYTES
 * budget across every page (F-003; the browser app counts the same way), so
 * pagination cannot multiply it; each body is capped before JSON.parse.
 */
export async function listExternalModels(input: {
  config: ExternalEndpointConfig;
  airgap: boolean;
  lookup?: DnsLookup;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const { config } = input;
  const ctx: FailureContext = { origin: originOf(config.baseUrl), model: config.model, apiKey: config.apiKey };
  const timeoutMs = input.timeoutMs ?? 15_000;
  const totalMs = input.totalTimeoutMs ?? PROBE_TOTAL_TIMEOUT_MS;
  const budget = new AbortController();
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    budget.abort();
  }, totalMs);
  const onCallerAbort = (): void => budget.abort();
  if (input.signal?.aborted === true) budget.abort();
  else input.signal?.addEventListener('abort', onCallerAbort);
  try {
    return await listModelPages(input, ctx, timeoutMs, budget.signal);
  } catch (err) {
    if (expired) throw timeoutError(ctx, totalMs, 'total');
    if (budget.signal.aborted) throw new RequestCancelledError();
    throw err;
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', onCallerAbort);
  }
}

async function listModelPages(
  input: { config: ExternalEndpointConfig; airgap: boolean; lookup?: DnsLookup },
  ctx: FailureContext,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string[]> {
  const { config } = input;
  /** Body bytes already spent from the listing-wide MAX_MODEL_LIST_BYTES budget. */
  let listedBytes = 0;
  const fetchJson = async (url: string, headers: Record<string, string>): Promise<Record<string, unknown>> => {
    if (signal.aborted) throw new RequestCancelledError();
    const response = await guardedRequest({
      url,
      method: 'GET',
      headers,
      ctx,
      airgap: input.airgap,
      lookup: input.lookup,
      firstByteTimeoutMs: timeoutMs,
      idleTimeoutMs: timeoutMs,
      signal,
    });
    try {
      const raw = await response.text(MAX_MODEL_LIST_BYTES - listedBytes, 'a model list', MAX_MODEL_LIST_BYTES);
      listedBytes += Buffer.byteLength(raw);
      // An abort ends the body quietly; never parse a truncated page.
      if (signal.aborted) throw new RequestCancelledError();
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ExternalProviderError || err instanceof RequestCancelledError) throw err;
      throw new ExternalProviderError('server', `${ctx.origin} did not return a JSON model list.`);
    } finally {
      response.abort();
    }
  };
  const idsOf = (body: Record<string, unknown>): string[] => {
    if (!Array.isArray(body.data)) throw new ExternalProviderError('server', `${ctx.origin} returned a model list without a data array.`);
    return (body.data as Array<{ id?: unknown }>).map((m) => m?.id).filter((id): id is string => typeof id === 'string' && id !== '');
  };
  if (config.protocol === 'openai') {
    const headers: Record<string, string> = {};
    if (config.apiKey !== null && config.apiKey !== '') headers.authorization = `Bearer ${config.apiKey}`;
    return idsOf(await fetchJson(`${openAIBase(config.baseUrl)}/models`, headers));
  }
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
  if (config.apiKey !== null && config.apiKey !== '') headers['x-api-key'] = config.apiKey;
  const ids: string[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(`${anthropicRoot(config.baseUrl)}/v1/models`);
    url.searchParams.set('limit', '1000');
    if (after !== null) url.searchParams.set('after_id', after);
    const body = await fetchJson(url.toString(), headers);
    for (const id of idsOf(body)) if (!ids.includes(id)) ids.push(id);
    const next = typeof body.last_id === 'string' ? body.last_id : null;
    if (body.has_more !== true || next === null || seen.has(next)) break;
    seen.add(next);
    after = next;
  }
  return ids;
}
