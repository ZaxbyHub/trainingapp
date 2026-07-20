/**
 * Browser LLM engine backed by wllama (llama.cpp compiled to WASM).
 *
 * Why this exists: the target hardware (12th-gen i5 + Iris Xe) frequently lacks
 * usable WebGPU, which the WebLLM engine hard-requires. wllama runs on CPU via
 * WASM SIMD + threads, loads the SAME GGUF family as the desktop app, and — via
 * an mmproj projector — supports multimodal (image) input. It is therefore the
 * primary, most-robust browser engine.
 *
 * OFFLINE: the wllama WASM runtime and the GGUF weights are served same-origin
 * from /models/ (see PACKAGING.md). `allowOffline: true` tells wllama never to
 * reach for a CDN.
 *
 * Implements the shared `LLMService` contract so it is interchangeable with
 * WebLLMService behind the engine factory.
 */

import { Wllama, CacheManager } from '@wllama/wllama';
import type {
  LLMService,
  LLMMessage,
  LLMGenerateOptions,
  LLMModelInfo,
  LLMInferenceMode,
  LLMProgress,
} from '../../types/llm';
import {
  WLLAMA_WASM_FILE,
  WLLAMA_COMPAT_WASM_URL,
  WLLAMA_COMPAT_WORKER_URL,
  LLM_GGUF_URL,
  LLM_MMPROJ_URL,
  LLM_MODEL_DIR,
} from '../models/model-manifest';
import { probeAsset } from '../models/probe';

/** Context window. Gemma 4 E2B-it supports up to 128K; 8192 is a safe default
 *  that leaves ample RAM for weights + KV cache on 8 GB target boxes. */
export const DEFAULT_N_CTX = 8192;

/**
 * Macro-free Gemma 4 chat template, injected as `LoadModelParams.chat_template`
 * with `jinja: true` to override the broken template embedded in the GGUF.
 *
 * Why this is required: the `gemma-4-e2b-it` GGUF ships an 18 KB Jinja chat
 * template that uses 5 macros (format_parameters, format_function_declaration,
 * format_argument, strip_thinking, format_tool_response_block) plus custom
 * `<|"|>` escape tokens. wllama 3.5.1's Jinja subset cannot evaluate those
 * macros — they render to empty strings, producing a BLANK prompt, so the
 * model emits <eos> immediately and the assistant bubble stays empty despite
 * retrieval + citations working. This is a known class of bug across the
 * llama.cpp ecosystem (goose#9110, LLamaSharp#1375, lmstudio#2012, and
 * llama.cpp#22786 all describe Gemma 4 "loads but produces nothing").
 *
 * This override is the macro-free equivalent of the embedded template's actual
 * message-rendering loop (extracted byte-for-byte from tokenizer.chat_template
 * in the GGUF). It uses the SAME turn markers the model was trained on —
 * `<|turn>{role}\n` to open a turn and `<turn|>` to close it (the closing
 * marker has no trailing newline; the next line's `{%-` strip handles
 * whitespace separation, and `<turn|>` tokenizes as a single special token
 * that absorbs surrounding whitespace). System messages are folded into the
 * first user turn via the `system_prefix` kwarg — Gemma 4 has no standalone
 * system role, matching Google's documented prompt structure
 * (https://ai.google.dev/gemma/docs/core/prompt-structure) and the embedded
 * template's own behavior.
 *
 * Multimodal note: image content parts flow through createChatCompletion
 * unchanged; wllama inserts `<|image|>` tokens at the projector boundary.
 *
 * TODO: remove this override once wllama ships a Jinja runtime that supports
 * the macros Gemma 4's embedded template requires.
 */
const GEMMA4_CHAT_TEMPLATE = `{%- for message in messages -%}
{%- if message.role == "system" -%}
{# Gemma 4 has no standalone system turn; fold into first user turn via system_prefix kwarg #}
{%- elif message.role == "user" -%}
<|turn>user
{{ system_prefix if system_prefix and loop.first else "" }}{{ message.content }}<turn|>
{%- elif message.role == "assistant" -%}
<|turn>model
{{ message.content }}<turn|>
{%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt -%}
<|turn>model
{%- endif -%}`;

/**
 * Detect whether a model id refers to a Gemma 4 variant whose embedded chat
 * template requires the macro-free override above. Keyed off the model id
 * (the directory name under /models/llm/) rather than runtime architecture
 * introspection, because the override must be injected at LOAD time before
 * the model metadata is available.
 */
function isGemma4Model(modelId: string | undefined): boolean {
  return !!modelId && modelId.startsWith('gemma-4');
}

function threadCount(): number {
  return navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, 4) : 2;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Our LLMMessage content (string | {type:'text'|'image', ...} parts) matches
 * wllama's chat-message content shape at runtime. Cast at this single boundary
 * because our union types `system` content more widely than wllama's.
 */
function toWllamaMessages(
  messages: LLMMessage[]
): Parameters<Wllama['createChatCompletion']>[0]['messages'] {
  return messages as unknown as Parameters<Wllama['createChatCompletion']>[0]['messages'];
}

/**
 * Extract the text of a system message (flattening content parts to text) if
 * one is present at the head of the messages array. Returns null when there
 * is no system message.
 */
function extractSystemText(messages: LLMMessage[]): string | null {
  if (messages.length === 0 || messages[0].role !== 'system') return null;
  const content = messages[0].content;
  if (typeof content === 'string') return content;
  // Flatten content parts to text, dropping image parts (system prompts are
  // text-only by construction in the orchestrator's buildMessages).
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

/**
 * Issue #40 RC2: translate our camelCase LLMGenerateOptions penalty fields into
 * wllama's SamplingParams names (penalty_*). Returns an empty object when no
 * penalty is set, so callers that pass no penalties get unchanged default
 * behavior (no penalty_last_n lookback window applied). When ANY penalty is set,
 * penalty_last_n: -1 enables full-context lookback — appropriate for this small
 * model / small context window.
 *
 * NOTE: wllama's createChatCompletion uses `penalty_repeat` / `penalty_freq` /
 * `penalty_present` (from SamplingParams), NOT the OpenAI-style
 * `repeat_penalty` / `frequency_penalty`. The latter exist only on
 * RawCompletionParams, which this service does not use. Getting this wrong
 * silently no-ops the anti-repetition fix.
 *
 * The return type is a NARROW record of only the penalty fields (not the whole
 * ChatCompletionParams) so spreading it into the createChatCompletion literal
 * does not widen the literal's `stream` property and trigger an overload error.
 */
type WllamaPenaltyParams = {
  penalty_repeat?: number;
  penalty_freq?: number;
  penalty_present?: number;
  penalty_last_n?: number;
};
function buildWllamaPenalties(options?: LLMGenerateOptions): WllamaPenaltyParams {
  const rp = options?.repeatPenalty;
  const fp = options?.frequencyPenalty;
  const pp = options?.presencePenalty;
  if (rp === undefined && fp === undefined && pp === undefined) {
    return {};
  }
  return {
    penalty_repeat: rp,
    penalty_freq: fp,
    penalty_present: pp,
    penalty_last_n: -1,
  };
}

/**
 * HEAD-probe a same-origin asset without downloading it, hardened against the
 * SPA-fallback false positive (Vite dev/preview serve index.html with HTTP 200
 * for any unmatched path). See `src/lib/models/probe.ts`.
 */
function isPresent(url: string): Promise<boolean> {
  return probeAsset(url);
}

/**
 * In-memory StorageBackend for wllama's CacheManager.
 *
 * wllama's default backend (OPFS) writes the full GGUF to the Origin Private
 * File System via FileSystemSyncAccessHandle. On systems with limited OPFS
 * quota, this fails with "No space available for this operation" — even with
 * cacheManager.clear() called first, because the write happens AFTER the clear
 * and the quota is genuinely too small for the 219MB GGUF.
 *
 * This backend stores the downloaded blobs in a Map in memory. The tradeoff:
 * no cross-session persistence (the model re-fetches each page load), but the
 * same-origin fetch is fast and avoids OPFS entirely. This is acceptable for a
 * browser-local app where the GGUF is already packaged same-origin.
 *
 * write() MUST fully drain the ReadableStream into a Blob — it is the sole
 * consumer of the download response body, and read() must return those bytes
 * for the model to load.
 */
export class InMemoryStorageBackend {
  private store = new Map<string, Blob>();

  isSupported(): boolean {
    return true;
  }

  async read(key: string): Promise<Blob | null> {
    return this.store.get(key) ?? null;
  }

  async write(key: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      this.store.set(key, new Blob(chunks as BlobPart[]));
    } finally {
      // PRR-001: always release the reader lock so a mid-stream error doesn't
      // leave the ReadableStream permanently locked.
      reader.releaseLock();
    }
  }

  async getSize(key: string): Promise<number> {
    const blob = this.store.get(key);
    return blob ? blob.size : -1;
  }

  async list(): Promise<Array<{ key: string; size: number }>> {
    return Array.from(this.store.entries()).map(([key, blob]) => ({ key, size: blob.size }));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class WllamaService implements LLMService {
  private static instance: WllamaService | null = null;
  private static teardownPromise: Promise<void> | null = null;

  private wllama: Wllama | null = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private disposed = false;
  private modelInfo: LLMModelInfo | null = null;
  /**
   * True when the loaded model's chat template was overridden at load time
   * (currently: Gemma 4 variants whose embedded macro template wllama can't
   * render). When true, system messages must be threaded via
   * chat_template_kwargs.system_prefix instead of as a separate message.
   */
  private chatTemplateOverridden = false;
  /** Tracks the in-flight generation so interrupt() can cancel it. */
  private activeAbort: AbortController | null = null;

  static getInstance(): WllamaService {
    if (WllamaService.instance === null) {
      WllamaService.instance = new WllamaService();
    }
    return WllamaService.instance;
  }

  static hasInstance(): boolean { return WllamaService.instance !== null; }

  private constructor() {}

  async initialize(
    modelId: string = LLM_MODEL_DIR,
    onProgress?: (progress: LLMProgress) => void
  ): Promise<void> {
    if (this.ready) return;
    if (this.initPromise !== null) return this.initPromise;
    if (WllamaService.teardownPromise) { await WllamaService.teardownPromise; }
    this.initPromise = this.doInitialize(modelId, onProgress);
    return this.initPromise;
  }

  private async doInitialize(
    modelId: string,
    onProgress?: (progress: LLMProgress) => void
  ): Promise<void> {
    const start = Date.now();
    try {
      // Fail fast with a clear, actionable message if the weights were never
      // packaged (build done without prepare-models / model not included),
      // instead of a cryptic load error deep inside wllama.
      const [ggufOk, mmprojOk] = await Promise.all([
        isPresent(LLM_GGUF_URL),
        isPresent(LLM_MMPROJ_URL),
      ]);
      if (!ggufOk || !mmprojOk) {
        const missing = [!ggufOk && LLM_GGUF_URL, !mmprojOk && LLM_MMPROJ_URL]
          .filter(Boolean)
          .join(', ');
        throw new Error(
          `Browser LLM not packaged — missing: ${missing}. ` +
            'Run `npm run prepare-models` with the model present, or use server mode. See PACKAGING.md.'
        );
      }

      // wllama uses AssetsPathConfig `default` VERBATIM as the wasm URL, so it
      // must be the full path to the .wasm file (not a directory).
      // Use an in-memory CacheManager to avoid OPFS — wllama's default backend
      // writes the full GGUF to OPFS, which fails with "No space available" on
      // systems with limited OPFS quota. The in-memory backend stores the
      // downloaded blobs in RAM; the model re-fetches from same-origin each
      // page load (fast, no persistence needed for a packaged offline app).
      this.wllama = new Wllama(
        { default: WLLAMA_WASM_FILE },
        { allowOffline: true, parallelDownloads: 3, suppressNativeLog: true,
          cacheManager: new CacheManager([new InMemoryStorageBackend()]) }
      );

      // Point the offline-compat fallback (used when the browser lacks
      // JSPI/Memory64) at locally packaged assets — otherwise wllama fetches
      // them from jsdelivr and breaks the offline guarantee.
      this.wllama.setCompat({ worker: WLLAMA_COMPAT_WORKER_URL, wasm: WLLAMA_COMPAT_WASM_URL });

      // Gemma 4 chat-template override: the GGUF's embedded template uses Jinja
      // macros wllama can't evaluate, which silently produces an empty prompt
      // (see GEMMA4_CHAT_TEMPLATE doc comment). When the staged model is a
      // Gemma 4 variant, inject a macro-free override + enable the Jinja
      // interpreter so wllama renders messages correctly. Track the override
      // so the generation path knows to thread system messages via kwargs.
      const needsTemplateOverride = isGemma4Model(modelId);
      this.chatTemplateOverridden = needsTemplateOverride;

      await this.wllama.loadModelFromUrl(
        // mmprojUrl loads the vision projector so the model can accept images.
        { url: LLM_GGUF_URL, mmprojUrl: LLM_MMPROJ_URL },
        {
          n_ctx: DEFAULT_N_CTX,
          n_threads: threadCount(),
          useCache: true,
          ...(needsTemplateOverride
            ? { chat_template: GEMMA4_CHAT_TEMPLATE, jinja: true }
            : {}),
          progressCallback: ({ loaded, total }) => {
            if (onProgress && total > 0) {
              onProgress({
                progress: loaded / total,
                timeElapsed: Date.now() - start,
                text: `Loading model… ${Math.round((loaded / total) * 100)}%`,
              });
            }
          },
        }
      );

      if (this.disposed) {
        throw new Error('WllamaService was disposed during initialization');
      }

      // Quantization label reflects the staged GGUF. The Gemma 4 E2B-it weights
      // are staged as Unsloth's QAT UD-Q4_K_XL (quantization-aware trained,
      // file_type=Q4_0 with dynamic tensor-precision bumps); see PACKAGING.md.
      // sizeBytes stays 0 here — actual size is computed by the model-download
      // layer from the staged file, not hardcoded.
      this.modelInfo = { modelId, quantization: 'UD-Q4_K_XL (QAT)', sizeBytes: 0, cached: true };
      this.ready = true;
    } catch (error) {
      await this.safeExit();
      this.initPromise = null;
      throw new Error(`Failed to initialize wllama model: ${errMessage(error)}`);
    }
  }

  /**
   * Build an abort controller for one generation. If the caller passes a signal,
   * we forward its abort to ours; either the caller's signal or interrupt() can
   * cancel the run. Returns a cleanup to detach the forwarding listener.
   */
  private beginGeneration(external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    // wllama runs a single sequence (n_parallel: 1); cancel any prior in-flight
    // generation so `interrupt()` always targets the current run.
    this.activeAbort?.abort();
    const controller = new AbortController();
    this.activeAbort = controller;

    if (external) {
      if (external.aborted) {
        controller.abort();
      } else {
        const onAbort = () => controller.abort();
        external.addEventListener('abort', onAbort, { once: true });
        return {
          signal: controller.signal,
          cleanup: () => {
            external.removeEventListener('abort', onAbort);
            if (this.activeAbort === controller) this.activeAbort = null;
          },
        };
      }
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        if (this.activeAbort === controller) this.activeAbort = null;
      },
    };
  }

  /**
   * Build the `messages` + optional `chat_template_kwargs` for a
   * createChatCompletion call. When the chat-template override is active
   * (Gemma 4), the system message is extracted from the messages array and
   * threaded via `chat_template_kwargs.system_prefix` (the override template
   * folds it into the first user turn). Without the override, messages pass
   * through unchanged so non-Gemma models keep their native system handling.
   */
  private buildChatArgs(messages: LLMMessage[]): {
    messages: Parameters<Wllama['createChatCompletion']>[0]['messages'];
    chatTemplateKwargs?: Record<string, unknown>;
  } {
    if (!this.chatTemplateOverridden) {
      return { messages: toWllamaMessages(messages) };
    }
    const systemText = extractSystemText(messages);
    if (systemText === null) {
      // No system message to fold — pass messages through unchanged.
      return { messages: toWllamaMessages(messages) };
    }
    // Strip the leading system message; thread its text as the kwarg the
    // override template prepends to the first user turn.
    return {
      messages: toWllamaMessages(messages.slice(1)),
      chatTemplateKwargs: { system_prefix: systemText },
    };
  }

  async *generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal }
  ): AsyncGenerator<string> {
    if (!this.isReady() || this.wllama === null) {
      throw new Error('WllamaService not initialized. Call initialize() first.');
    }
    const { signal, cleanup } = this.beginGeneration(options?.signal);
    try {
      const { messages: wllamaMessages, chatTemplateKwargs } = this.buildChatArgs(messages);
      const stream = await this.wllama.createChatCompletion({
        messages: wllamaMessages,
        stream: true,
        abortSignal: signal,
        max_tokens: options?.maxTokens,
        temp: options?.temperature,
        top_p: options?.topP,
        ...(chatTemplateKwargs ? { chat_template_kwargs: chatTemplateKwargs } : {}),
        // Issue #40 RC2: anti-repetition sampling params. wllama's chat path
        // (createChatCompletion) accepts the SamplingParams names (penalty_*),
        // NOT the OpenAI-style repeat_penalty/frequency_penalty — using the
        // wrong names silently no-ops the fix. penalty_last_n: -1 = full-context
        // lookback (small model, small context — no reason to window). Only set
        // the lookback when at least one penalty is supplied, so callers that
        // pass no penalties get unchanged default behavior.
        ...buildWllamaPenalties(options),
      });
      for await (const chunk of stream) {
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) yield content;
      }
    } finally {
      cleanup();
    }
  }

  async generateComplete(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal }
  ): Promise<string> {
    if (!this.isReady() || this.wllama === null) {
      throw new Error('WllamaService not initialized. Call initialize() first.');
    }
    const { signal, cleanup } = this.beginGeneration(options?.signal);
    try {
      const { messages: wllamaMessages, chatTemplateKwargs } = this.buildChatArgs(messages);
      const response = await this.wllama.createChatCompletion({
        messages: wllamaMessages,
        stream: false,
        abortSignal: signal,
        max_tokens: options?.maxTokens,
        temp: options?.temperature,
        top_p: options?.topP,
        ...(chatTemplateKwargs ? { chat_template_kwargs: chatTemplateKwargs } : {}),
        // Issue #40 RC2: see generate() above.
        ...buildWllamaPenalties(options),
      });
      return response.choices?.[0]?.message?.content ?? '';
    } finally {
      cleanup();
    }
  }

  getInferenceMode(): LLMInferenceMode {
    return 'wasm';
  }

  getModelInfo(): LLMModelInfo | null {
    return this.modelInfo ? { ...this.modelInfo } : null;
  }

  isReady(): boolean {
    return this.ready && this.wllama !== null;
  }

  /**
   * Whether the loaded model can accept image input (Phase 4 image upload).
   * False until a model with an mmproj projector is loaded.
   */
  supportsImages(): boolean {
    try {
      return this.isReady() && this.wllama!.supportInputModality('image');
    } catch {
      return false;
    }
  }

  interrupt(): void {
    this.activeAbort?.abort();
  }

  private async safeExit(): Promise<void> {
    if (this.wllama !== null) {
      try {
        await this.wllama.exit();
      } catch {
        // best-effort teardown
      }
      this.wllama = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.activeAbort?.abort();
    this.activeAbort = null;
    WllamaService.teardownPromise = this.safeExit().finally(() => { WllamaService.teardownPromise = null; });
    this.ready = false;
    this.initPromise = null;
    this.modelInfo = null;
    this.chatTemplateOverridden = false;
    WllamaService.instance = null;
  }
}

/** Convenience accessor for the wllama service singleton. */
export function getWllamaService(): WllamaService {
  return WllamaService.getInstance();
}
