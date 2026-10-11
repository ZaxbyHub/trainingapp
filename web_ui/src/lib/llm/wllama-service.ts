/**
 * Browser LLM engine backed by wllama (llama.cpp compiled to WASM).
 *
 * Why this exists: the target hardware (12th-gen i5 + Iris Xe) frequently lacks
 * usable WebGPU, which the WebLLM engine hard-requires. wllama runs on CPU via
 * WASM SIMD + threads, loads the SAME GGUF family as the desktop app, and is
 * therefore the primary, most-robust browser engine.
 *
 * Issue #156: the packaged model is LiquidAI LFM2-1.2B-RAG — TEXT-ONLY. The
 * previous model's mmproj multimodal surface (image attachments,
 * supportsImages, the mmproj load option) was removed with the model swap;
 * the browser LLM no longer accepts image input. LFM2's embedded chat
 * template is used AS-IS (no Gemma-era macro-free override: LFM2's template
 * renders fine under wllama's Jinja subset).
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
  LLM_MODEL_DIR,
} from '../models/model-manifest';
import { probeAsset } from '../models/probe';
import { filterDeclineSentences } from './decline-filter';

/** Context window. LFM2-1.2B-RAG supports up to 32K; 8192 is a safe default
 *  that leaves ample RAM for weights + KV cache on 8 GB target boxes. */
export const DEFAULT_N_CTX = 8192;

function threadCount(): number {
  return navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, 4) : 2;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Our LLMMessage shape (string content) is passed through to wllama's
 * chat-message shape at runtime. Cast at this single boundary because our
 * `system` role union is wider than wllama's own message typing.
 */
function toWllamaMessages(
  messages: LLMMessage[]
): Parameters<Wllama['createChatCompletion']>[0]['messages'] {
  return messages as unknown as Parameters<Wllama['createChatCompletion']>[0]['messages'];
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
 * and the quota is genuinely too small for the GGUF.
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
      const ggufOk = await isPresent(LLM_GGUF_URL);
      if (!ggufOk) {
        throw new Error(
          `Browser LLM not packaged — missing: ${LLM_GGUF_URL}. ` +
            'Run `npm run prepare-models` with the model present, or use the desktop app or an external model server (Settings → Model & connection). See PACKAGING.md.'
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

      // LFM2-1.2B-RAG (issue #156): the model is loaded with its EMBEDDED
      // chat template as-is — no chat_template override, no jinja flag. (The
      // previous Gemma 4 needed a macro-free override because wllama's Jinja
      // subset could not evaluate its embedded template's macros; LFM2's
      // template renders correctly without help.)
      await this.wllama.loadModelFromUrl(
        { url: LLM_GGUF_URL },
        {
          n_ctx: DEFAULT_N_CTX,
          n_threads: threadCount(),
          useCache: true,
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

      this.modelInfo = { modelId, quantization: 'Q4_K_M', sizeBytes: 0, cached: true };
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

  async *generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal }
  ): AsyncGenerator<string> {
    if (!this.isReady() || this.wllama === null) {
      throw new Error('WllamaService not initialized. Call initialize() first.');
    }
    const { signal, cleanup } = this.beginGeneration(options?.signal);
    try {
      const stream = await this.wllama.createChatCompletion({
        messages: toWllamaMessages(messages),
        stream: true,
        abortSignal: signal,
        max_tokens: options?.maxTokens,
        temp: options?.temperature,
        top_p: options?.topP,
        // Issue #40 RC2: anti-repetition sampling params. wllama's chat path
        // (createChatCompletion) accepts the SamplingParams names (penalty_*),
        // NOT the OpenAI-style repeat_penalty/frequency_penalty — using the
        // wrong names silently no-ops the fix. penalty_last_n: -1 = full-context
        // lookback (small model, small context — no reason to window). Only set
        // the lookback when at least one penalty is supplied, so callers that
        // pass no penalties get unchanged default behavior.
        ...buildWllamaPenalties(options),
      });
      // #156 decline filter (browser twin of desktop llama-engine.ts): the
      // LFM 1.2B models append trained-in "did you forget to include/attach
      // the document?" sentences when declining. The filter is scoped to
      // decline-shaped answers (a marker sentence must already be present),
      // so answerable answers pass through byte-identical.
      //
      // Emission discipline (4.5 review finding, twin of the desktop fix):
      // wllama streams per token, so emission happens only through the last
      // DECIDED sentence terminator (removal decisions are sentence-local and
      // stable once a sentence completes) and the remainder is flushed when
      // the stream ends — no artefact word ever surfaces, no offset splice.
      let accumulated = '';
      let emitted = '';
      for await (const chunk of stream) {
        const content = chunk.choices?.[0]?.delta?.content;
        if (!content) continue;
        accumulated += content;
        const settled = /[.!?](?=[^.!?\n]*$)/.exec(accumulated);
        if (settled === null) continue;
        const candidate = filterDeclineSentences(accumulated.slice(0, settled.index + 1));
        if (candidate.length > emitted.length) {
          yield candidate.slice(emitted.length);
          emitted = candidate;
        }
      }
      const finalVisible = filterDeclineSentences(accumulated);
      if (finalVisible.length > emitted.length) {
        yield finalVisible.slice(emitted.length);
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
      const response = await this.wllama.createChatCompletion({
        messages: toWllamaMessages(messages),
        stream: false,
        abortSignal: signal,
        max_tokens: options?.maxTokens,
        temp: options?.temperature,
        top_p: options?.topP,
        // Issue #40 RC2: see generate() above.
        ...buildWllamaPenalties(options),
      });
      // #156 decline filter (see generate() above): applied to the completed
      // answer text, mirroring the desktop engine's non-streaming path.
      return filterDeclineSentences(response.choices?.[0]?.message?.content ?? '');
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
    WllamaService.instance = null;
  }
}

/** Convenience accessor for the wllama service singleton. */
export function getWllamaService(): WllamaService {
  return WllamaService.getInstance();
}
