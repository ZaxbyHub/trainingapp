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

import { Wllama } from '@wllama/wllama';
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

/** Context window. LFM2-VL handles long context; 4096 is a safe default for RAM. */
const DEFAULT_N_CTX = 4096;

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

/** HEAD-probe a same-origin asset without downloading it. */
async function isPresent(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { method: 'HEAD' })).ok;
  } catch {
    return false;
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
      this.wllama = new Wllama(
        { default: WLLAMA_WASM_FILE },
        { allowOffline: true, parallelDownloads: 3, suppressNativeLog: true }
      );

      // Point the offline-compat fallback (used when the browser lacks
      // JSPI/Memory64) at locally packaged assets — otherwise wllama fetches
      // them from jsdelivr and breaks the offline guarantee.
      this.wllama.setCompat({ worker: WLLAMA_COMPAT_WORKER_URL, wasm: WLLAMA_COMPAT_WASM_URL });

      await this.wllama.loadModelFromUrl(
        // mmprojUrl loads the vision projector so the model can accept images.
        { url: LLM_GGUF_URL, mmprojUrl: LLM_MMPROJ_URL },
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
      const response = await this.wllama.createChatCompletion({
        messages: toWllamaMessages(messages),
        stream: false,
        abortSignal: signal,
        max_tokens: options?.maxTokens,
        temp: options?.temperature,
        top_p: options?.topP,
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
    WllamaService.instance = null;
  }
}

/** Convenience accessor for the wllama service singleton. */
export function getWllamaService(): WllamaService {
  return WllamaService.getInstance();
}
