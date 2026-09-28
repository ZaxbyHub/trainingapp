/**
 * OpenAI-compatible chat provider (trace: external-llm-provider-settings).
 *
 * Lets the app use a locally served (loopback) server that speaks the OpenAI
 * wire format (`/v1/chat/completions` SSE, `/v1/models`) — llama-server, LM
 * Studio, Ollama's compat layer, etc. Provider mode is DIRECT generation: the
 * question (plus bounded conversation context) goes to the configured server
 * and responses are NOT grounded in the browser document index.
 *
 * Wire contract frozen by trace check C1:
 *   new OpenAICompatChatService({ baseUrl, model, apiKey? }).chat(messages)
 *     -> POST `${normalized base}/chat/completions`
 *        body {model, messages, stream: true} (exactly these fields),
 *        `Authorization: Bearer <key>` when a key is set,
 *        resolves the concatenation of the streamed `delta.content` values.
 * C2 freezes the probe: GET `${normalized base}/models`, never /auth/status,
 * {ok:false, detail} with an actionable message when unreachable.
 */

import type {
  LLMGenerateOptions,
  LLMInferenceMode,
  LLMMessage,
  LLMModelInfo,
  LLMProgress,
  LLMService,
} from '../../types/llm';

/** Provider connection settings (persisted via {@link loadProviderConfig}). */
export interface ProviderConfig {
  baseUrl: string;
  model: string;
  /** Optional; when empty NO Authorization header is sent. */
  apiKey: string;
}

/**
 * Normalize a user-entered provider base URL to the server root that the
 * OpenAI routes hang off:
 *   trim; strip ALL trailing slashes; strip one trailing
 *   `/chat/completions` (users paste the full endpoint); append `/v1` unless
 *   the final path segment is already `/v1` (case-insensitive).
 * Shared by chat() and the probe so both always hit the same surface.
 */
export function normalizeProviderBaseUrl(raw: string): string {
  let url = (raw ?? '').trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  const finalSegment = url.split('/').pop() ?? '';
  if (finalSegment.toLowerCase() !== 'v1') {
    url = `${url}/v1`;
  }
  return url;
}

/**
 * Guard for provider base URLs: HTTP-only (the packaged CSP connect-src has
 * no https:// entries), and LOOPBACK-ONLY hosts
 * (`127.0.0.1` / `[::1]` — the packaged app's CSP `connect-src` allows exactly
 * `http://127.0.0.1:*` and `http://[::1]:*` on app:// responses, so any other
 * host would be network-blocked in the shipped build; this guard rejects it up
 * front with an actionable message instead). IPv6 metadata/link-local forms
 * that api/streaming.ts blocks are named explicitly for parity even though
 * loopback-only already excludes them. LAN/remote providers are a documented
 * follow-up (requires a desktop CSP decision — do not widen here unilaterally).
 */
export function assertProviderUrlAllowed(raw: string): void {
  if (!raw || raw.trim() === '') {
    throw new Error('Provider base URL must not be empty');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('Provider base URL must be an absolute http:// URL');
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:') {
    // http-only: the packaged CSP connect-src permits exactly
    // http://127.0.0.1:* and http://[::1]:* — an https:// loopback URL would
    // pass the host check but be CSP-blocked mid-flight (reviewer round 2,
    // finding C).
    throw new Error(
      `Provider base URL scheme "${scheme}" is not allowed (use http:// for the local server)`
    );
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const blockedMetadataHost =
    hostname === '::ffff:a9fe:a9fe' ||
    hostname === 'fe80::a9fe:a9fe' ||
    hostname === '169.254.169.254' ||
    hostname.endsWith('.169.254.169.254');
  if (blockedMetadataHost) {
    throw new Error(`Provider base URL host "${hostname}" is not allowed`);
  }
  if (hostname !== '127.0.0.1' && hostname !== '::1') {
    throw new Error(
      `Provider base URL must be a loopback address (http://127.0.0.1:<port> or http://[::1]:<port>) in this release — got "${hostname}". The packaged app's content-security policy only permits loopback providers.`
    );
  }
}

/** First-byte watchdog for the provider stream (reviewer round 1, finding 2). */
export const FIRST_BYTE_TIMEOUT_MS = 30_000;

/**
 * Extract the delta strings from SSE `data:` lines (one line per call; also
 * accepts a whole buffer for the buffered fallback). Non-delta frames
 * (keep-alives, comments, [DONE]) contribute nothing.
 */
export function extractLineDeltas(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const frame = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = frame.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta !== '') out.push(delta);
    } catch {
      // Keep-alive/comment frame — skip.
    }
  }
  return out;
}

/** Parse an OpenAI SSE stream body into the concatenated delta contents.
 * Delegates to extractLineDeltas so chat() and generate() parse identically
 * (reviewer round 2, finding C / round 3, Important 3 — single parser).
 */
function parseOpenAISseDeltas(body: string): string {
  return extractLineDeltas(body).join('');
}

/**
 * Actionable connection-failure message shared by chat() and generate() so a
 * dead endpoint reads the same in the probe and in the chat bubble.
 */
function cannotReachMessage(base: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `Cannot reach the provider server at ${base} (${reason}). Is it running?`;
}

/**
 * Extract an actionable message from a non-OK or non-SSE response body.
 * Standard OpenAI error shape: {"error": {"message": "..."}}.
 */
async function extractServerError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string }; detail?: unknown };
    const message = body?.error?.message;
    if (typeof message === 'string' && message.trim()) return message;
    if (typeof body?.detail === 'string' && body.detail.trim()) return body.detail;
  } catch {
    // Non-JSON body — fall through to the status-line message.
  }
  return `Server returned ${response.status}`;
}

/**
 * Browser-side OpenAI-compatible chat service.
 *
 * Implements the shared LLMService seam so mode plumbing stays engine-shaped,
 * plus the frozen standalone `chat()` entry point (works without initialize();
 * sends the messages array verbatim — no system-prompt injection, no mutation).
 */
export class OpenAICompatChatService implements LLMService {
  private readonly config: ProviderConfig;
  private readonly firstByteTimeoutMs: number;
  private ready = false;
  private controller: AbortController | null = null;

  constructor(
    cfg: { baseUrl: string; model: string; apiKey?: string; firstByteTimeoutMs?: number }
  ) {
    this.config = {
      baseUrl: cfg.baseUrl ?? '',
      model: cfg.model ?? '',
      apiKey: cfg.apiKey ?? '',
    };
    this.firstByteTimeoutMs = cfg.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  }

  /** The normalized base all provider requests hang off. */
  private resolvedBase(): string {
    const base = normalizeProviderBaseUrl(this.config.baseUrl);
    assertProviderUrlAllowed(base);
    return base;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey.trim() !== '') {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  /**
   * Frozen C1 entry point: POST {model, messages, stream: true} to
   * `${base}/chat/completions` and resolve the concatenated SSE deltas.
   * Sends the caller's messages array verbatim.
   */
  async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
    const base = this.resolvedBase();
    let response: Response;
    try {
      response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ model: this.config.model, messages, stream: true }),
      });
    } catch (err) {
      throw new Error(cannotReachMessage(base, err));
    }
    if (!response.ok) {
      throw new Error(await extractServerError(response));
    }
    return parseOpenAISseDeltas(await response.text());
  }

  // ---- LLMService seam -------------------------------------------------

  initialize(_modelId?: string, onProgress?: (progress: LLMProgress) => void): Promise<void> {
    // A provider needs no local load; validate the config so failures surface
    // as a readiness problem instead of a mid-send network error.
    assertProviderUrlAllowed(normalizeProviderBaseUrl(this.config.baseUrl));
    if (!this.config.model.trim()) {
      throw new Error('Provider model id is not configured');
    }
    onProgress?.({ progress: 1, timeElapsed: 0, text: 'Provider server configured' });
    this.ready = true;
    return Promise.resolve();
  }

  async *generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal }
  ): AsyncGenerator<string> {
    const base = this.resolvedBase();
    const controller = new AbortController();
    this.controller = controller;
    let cancelled = false;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let firstByteTimer: ReturnType<typeof setTimeout> | null = null;
    const clearWatchdog = () => {
      if (firstByteTimer) clearTimeout(firstByteTimer);
      firstByteTimer = null;
    };
    const markCancelled = () => {
      cancelled = true;
      clearWatchdog();
      // Release the network immediately on Stop/interrupt (reviewer round 1,
      // finding 2; round 2 finding A): cancelling the reader tears down the
      // in-flight response, and the fetch's own signal aborts the pre-headers
      // window when the environment accepts cross-realm signals.
      void activeReader?.cancel().catch(() => undefined);
      controller.abort();
    };
    // The AbortSignal is passed into fetch ONLY when this realm's fetch
    // accepts it — jsdom + undici reject cross-realm instances ("Expected
    // signal ... to be an instance of AbortSignal"), so the feature-detect
    // below mirrors streaming.ts's pre-headers abort posture where possible
    // and falls back to the watchdog + cancel paths where not (reviewer
    // round 2, finding A).
    let fetchSignal: AbortSignal | undefined;
    try {
      new Request('http://127.0.0.1/', { method: 'POST', signal: controller.signal });
      fetchSignal = controller.signal;
    } catch {
      fetchSignal = undefined;
    }
    options?.signal?.addEventListener('abort', markCancelled);
    controller.signal.addEventListener('abort', markCancelled);
    const plainMessages = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
    }));
    try {
      let response: Response;
      // First-byte watchdog armed BEFORE fetch (reviewer round 2, finding
      // A): races the pre-headers window (a server that accepts but never
      // answers) and the body-stage leg below, so neither phase can hang past
      // FIRST_BYTE_TIMEOUT_MS.
      const watchdogPromise = new Promise<never>((_, reject) => {
        firstByteTimer = setTimeout(() => {
          markCancelled();
          reject(
            new Error(
              `Provider server at ${base} accepted the request but sent no data within ${this.firstByteTimeoutMs}ms.`
            )
          );
        }, this.firstByteTimeoutMs);
      });
      try {
        response = await Promise.race([
          fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify({ model: this.config.model, messages: plainMessages, stream: true }),
            signal: fetchSignal,
          }),
          watchdogPromise,
        ]);
        if (cancelled) {
          void response.body?.cancel().catch(() => undefined);
          return;
        }
      } catch (err) {
        // The watchdog's rejection carries cancelled=true (markCancelled ran
        // first) — surface it as the actionable error, not a silent stop.
        if (err instanceof Error && /sent no data within/.test(err.message)) throw err;
        if (cancelled) return;
        throw new Error(cannotReachMessage(base, err));
      }
      // The pre-headers watchdog stays ARMED through the !response.ok
      // error-body read (reviewer round 4, finding 1): a 5xx whose error body
      // stalls must fail bounded, not hang. The watchdog firing here yields a
      // bounded THROW (raced against extractServerError), never a silent
      // completion. Disarm once we reach the success path — the body-stage
      // readChunk watchdog owns first-body-byte from there.
      if (!response.ok) {
        let message: string;
        try {
          // watchdogPromise is REJECT-ONLY (the timer never resolves it), so
          // the stall arm must be a rejection handler — a .then(onFulfilled)
          // here would pass the pre-headers rejection through unchanged
          // (reviewer round 5, finding 1) and surface the wrong-phase
          // "sent no data" message.
          message = await Promise.race([
            extractServerError(response),
            watchdogPromise.then(
              () => {
                throw new Error(
                  `Provider server at ${base} sent a ${response.status} response whose error body stalled (exceeded ${this.firstByteTimeoutMs}ms).`
                );
              },
              () => {
                throw new Error(
                  `Provider server at ${base} sent a ${response.status} response whose error body stalled (exceeded ${this.firstByteTimeoutMs}ms).`
                );
              }
            ),
          ]);
        } finally {
          clearWatchdog();
        }
        throw new Error(message);
      }
      clearWatchdog();
      // TRUE incremental streaming (reviewer round 1, finding 2): read the SSE
      // body chunk-by-chunk so deltas reach the UI as the server emits them,
      // with a first-byte watchdog so a hung server cannot spin forever.
      const readLineDeltas = async function* (text: string): AsyncGenerator<string> {
        yield* extractLineDeltas(text);
      };
      if (!response.body) {
        // No streaming body in this environment: buffered fallback.
        yield* readLineDeltas(await response.text());
        return;
      }
      const reader = response.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      let sawFirstByte = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const readChunk = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        if (sawFirstByte) return reader.read();
        // Body-stage leg of the same watchdog armed before fetch: a server
        // that sent headers but never streams a byte must fail with an
        // actionable error, not spin forever.
        return Promise.race([
          reader.read().then((r) => {
            sawFirstByte = true;
            if (watchdog) clearTimeout(watchdog);
            return r;
          }),
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(
              () =>
                reject(
                  new Error(
                    `Provider server at ${base} accepted the request but sent no data within ${this.firstByteTimeoutMs}ms.`
                  )
                ),
              this.firstByteTimeoutMs
            );
          }),
        ]);
      };
      for (;;) {
        if (cancelled) return;
        const { done, value } = await readChunk();
        if (cancelled) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          if (cancelled) return;
          for (const delta of extractLineDeltas(rawLine)) {
            yield delta;
          }
        }
      }
      if (!cancelled && buffer.trim()) {
        for (const delta of extractLineDeltas(buffer)) {
          yield delta;
        }
      }
    } finally {
      // Reviewer round 2, finding A: release the connection on EVERY exit path
      // (error, watchdog, cancellation), not only on explicit Stop.
      clearWatchdog();
      void activeReader?.cancel().catch(() => undefined);
      options?.signal?.removeEventListener('abort', markCancelled);
      controller.signal.removeEventListener('abort', markCancelled);
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
 * Connectivity probe against an OpenAI-compatible server (frozen by C2):
 * GET `${normalized base}/models` with a bounded timeout. Never touches the
 * project-only `/auth/status` route, so a standard server (which does not
 * implement it) probes successfully.
 */
export async function probeOpenAICompat(
  baseUrl: string,
  opts?: { timeoutMs?: number }
): Promise<{ ok: boolean; detail?: string }> {
  let base: string;
  try {
    base = normalizeProviderBaseUrl(baseUrl);
    assertProviderUrlAllowed(base);
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : 'Provider base URL is invalid',
    };
  }
  if (!base) {
    return { ok: false, detail: 'Provider base URL must not be empty' };
  }
  const timeoutMs = opts?.timeoutMs ?? 5000;
  // NOTE: no AbortSignal is passed into fetch (jsdom + undici reject the
  // cross-realm instance); the bound is enforced with a Promise.race so the
  // probe always resolves within the timeout.
  const timeout = new Promise<{ ok: false; detail: string }>((resolve) => {
    setTimeout(() => {
      resolve({
        ok: false,
        detail: `Cannot reach an OpenAI-compatible server at ${base} (timed out after ${timeoutMs}ms). Is the server running, and does it serve /v1/models?`,
      });
    }, timeoutMs);
  });
  const attempt = (async (): Promise<{ ok: boolean; detail?: string }> => {
    try {
      const response = await fetch(`${base}/models`, { method: 'GET' });
      if (response.ok) return { ok: true };
      return {
        ok: false,
        detail: `Cannot reach an OpenAI-compatible server at ${base} (server returned ${response.status}). Is the server running, and does it serve /v1/models?`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        detail: `Cannot reach an OpenAI-compatible server at ${base} (${reason}). Is the server running, and does it serve /v1/models?`,
      };
    }
  })();
  return Promise.race([attempt, timeout]);
}

// ---- Provider configuration persistence -----------------------------------
// Stored in the shared `inference-mode` blob (key `providerConfig`, so it
// survives alongside mode/engine/preset) with the API key in a separate key so
// it can be cleared independently. Plain text, local to this browser profile;
// it is sent ONLY to the configured provider server. (Plan open-question 1 —
// desktop safeStorage was rejected for v1.)

const PROVIDER_APIKEY_STORAGE_KEY = 'openai-provider-apikey';

interface StoredInferenceModeLoose {
  providerConfig?: { baseUrl?: string; model?: string };
  [k: string]: unknown;
}

function readStoredBlob(): StoredInferenceModeLoose {
  try {
    return JSON.parse(localStorage.getItem('inference-mode') ?? '{}') as StoredInferenceModeLoose;
  } catch {
    return {};
  }
}

/** Load the persisted provider connection settings (empty strings if unset). */
export function loadProviderConfig(): ProviderConfig {
  const blob = readStoredBlob();
  const cfg = blob.providerConfig ?? {};
  let apiKey = '';
  try {
    apiKey = localStorage.getItem(PROVIDER_APIKEY_STORAGE_KEY) ?? '';
  } catch {
    apiKey = '';
  }
  return {
    baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
    model: typeof cfg.model === 'string' ? cfg.model : '',
    apiKey,
  };
}

/** Persist provider connection settings (read-modify-write; key-level merge). */
export function saveProviderConfig(patch: Partial<ProviderConfig>): void {
  const blob = readStoredBlob();
  const prev = blob.providerConfig ?? {};
  const next = {
    baseUrl: patch.baseUrl ?? prev.baseUrl ?? '',
    model: patch.model ?? prev.model ?? '',
  };
  try {
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({ ...blob, providerConfig: next })
    );
    if (patch.apiKey !== undefined) {
      localStorage.setItem(PROVIDER_APIKEY_STORAGE_KEY, patch.apiKey);
    }
  } catch {
    // localStorage unavailable or quota exceeded — settings stay in-memory.
  }
}

/** True when the provider branch may attempt a send. */
export function isProviderConfigured(cfg: ProviderConfig): boolean {
  return cfg.baseUrl.trim() !== '' && cfg.model.trim() !== '';
}
