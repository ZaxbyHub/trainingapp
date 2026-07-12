/**
 * WebLLM Service — browser-side LLM inference with WebGPU.
 *
 * Supports Llama-3.2-3B-Instruct-q4f16_1-MLC (~1.9GB) and uses OPFS for model artifact caching.
 * WebGPU is the only supported backend; if unavailable, the service fails fast
 * with guidance to use server API mode (per FR-015).
 */

import type {
  LLMMessage,
  LLMGenerateOptions,
  LLMModelInfo,
  LLMInferenceMode,
  LLMService,
} from '@/types/llm';
import { messageContentToText } from '@/types/llm';

// Dynamic import to avoid loading the WebGPU machinery until needed.
// The API surface we're using:
//   CreateMLCEngine(modelId, { initProgressCallback }) → Promise<MLCEngine>
//   engine.chat.completions.create({ messages, stream?: boolean }) → ChatCompletion
//   For streaming: iterate ChatCompletion with `for await (...)`
//
// Note: @mlc-ai/web-llm v0.2.83+ exposes `CreateMLCEngine` as a named export.
// If the actual API differs, the TS compiler will surface the error and we
// can adjust. The CreateMLCEngine API has been verified and is in production use.
type InitProgressCallback = (progress: { progress: number; timeElapsed: number; text: string }) => void;

type CreateMLCEngineFn = (
  modelId: string,
  options?: {
    initProgressCallback?: InitProgressCallback;
    appConfig?: unknown;
  }
) => Promise<unknown>;

type MLCEngineChat = {
  completions: {
    create(options: {
      messages: Array<{ role: string; content: string }>;
      stream?: boolean;
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
      signal?: AbortSignal;
    }): AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }>;
  };
};

interface MLCEngine {
  chat: MLCEngineChat;
  interruptGenerate(): void;
  unload?(): Promise<void>;
}

let CreateMLCEngine: CreateMLCEngineFn | null = null;
let prebuiltMLCAppConfig: unknown = null;

const DEFAULT_MODEL_ID = 'Llama-3.2-3B-Instruct-q4f16_1-MLC';

const ALLOWED_MODEL_IDS: readonly string[] = [
  'Llama-3.2-3B-Instruct-q4f16_1-MLC',
  'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
];

/**
 * Singleton service for web-llm operations.
 */
export class WebLLMService implements LLMService {
  private static _instance: WebLLMService | null = null;
  private _engine: MLCEngine | null = null;
  private _modelInfo: LLMModelInfo | null = null;
  private _inferenceMode: LLMInferenceMode = 'webgpu';
  private _ready = false;

  private constructor() {}

  /**
   * Get the singleton instance.
   */
  static getInstance(): WebLLMService {
    if (!WebLLMService._instance) {
      WebLLMService._instance = new WebLLMService();
    }
    return WebLLMService._instance;
  }

  /**
   * Detect whether WebGPU is available via navigator.gpu.
   */
  private async _detectWebGPU(): Promise<boolean> {
    try {
      if (!navigator.gpu) {
        console.info('[WebLLM] WebGPU not available (navigator.gpu missing)');
        return false;
      }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        console.info('[WebLLM] WebGPU requestAdapter returned null — WebGPU unavailable');
        return false;
      }

      // Reject software-renderer adapters (SwiftShader, llvmpipe) that work
      // but provide unusably slow performance for ML inference (FR-005)
      try {
        // `requestAdapterInfo()` was removed from strict @webgpu/types but is
        // still present in shipping browsers (and the try/catch below already
        // guards browsers that lack it). Cast to preserve the existing runtime
        // behavior without changing the call.
        const adapterInfo = await (adapter as GPUAdapter & {
          requestAdapterInfo(): Promise<{ vendor?: string; architecture?: string }>;
        }).requestAdapterInfo();
        const vendor = (adapterInfo.vendor || '').toLowerCase();
        const architecture = (adapterInfo.architecture || '').toLowerCase();
        if (vendor.includes('mesa') || architecture.includes('llvmpipe') || architecture.includes('swiftshader')) {
          console.warn('[WebLLM] Rejected software-renderer adapter:', { vendor, architecture });
          return false;
        }
      } catch {
        // adapter.requestAdapterInfo() may not be available in all browsers;
        // if we can't check, proceed with the adapter (best-effort)
        console.info('[WebLLM] adapter.requestAdapterInfo() unavailable, proceeding best-effort');
      }

      console.info('[WebLLM] WebGPU adapter detected');
      return true;
    } catch (err) {
      console.warn('[WebLLM] WebGPU detection failed:', err);
      return false;
    }
  }

  /**
   * Load the CreateMLCEngine factory (delayed import to keep initial bundle small).
   */
  private async _loadEngineFactory(): Promise<void> {
    if (CreateMLCEngine) return;
    const mod = await import('@mlc-ai/web-llm');
    // CreateMLCEngine is the documented factory in v0.2.83+ (API verified and in production use)
    CreateMLCEngine = (mod as unknown as { CreateMLCEngine: CreateMLCEngineFn }).CreateMLCEngine;
    prebuiltMLCAppConfig = (mod as unknown as { prebuiltAppConfig: unknown }).prebuiltAppConfig;
    if (!CreateMLCEngine) {
      throw new Error(
        '@mlc-ai/web-llm does not export CreateMLCEngine. ' +
        'Check that the installed version (^0.2.83) matches the expected API.'
      );
    }
  }

  /**
   * Initialize the service and load the model.
   *
   * @param modelId  Model identifier string. Defaults to Llama-3.2-3B-Instruct-q4f16_1-MLC.
   *                 The web-llm model ID must match a model published on
   *                 https://mlc.ai/web-llm/#model-list so the CDN can locate weights.
   * @param onProgress Optional progress callback forwarded to CreateMLCEngine's
   *                   initProgressCallback. Receives web-llm's progress payload.
   */
  async initialize(
    modelId: string = DEFAULT_MODEL_ID,
    onProgress?: InitProgressCallback
  ): Promise<void> {
    if (!ALLOWED_MODEL_IDS.includes(modelId)) {
      throw new Error(`Unknown modelId: "${modelId}". Allowed: ${ALLOWED_MODEL_IDS.join(', ')}`);
    }

    if (this._ready) {
      console.warn('[WebLLM] Already initialized');
      return;
    }

    console.info(`[WebLLM] Initializing with model: ${modelId}`);

    // 1. Detect backend — only WebGPU is supported
    const useWebGPU = await this._detectWebGPU();
    if (!useWebGPU) {
      throw new Error(
        'WebGPU is not available in this browser. ' +
        'Please switch to server API mode for LLM inference (per FR-015).'
      );
    }
    this._inferenceMode = 'webgpu';
    console.info(`[WebLLM] Using inference mode: ${this._inferenceMode}`);

    // 2. Load engine factory (dynamic import)
    await this._loadEngineFactory();

    // 3. Create engine with progress reporting
    let wasDownloading = false;
    try {
      this._engine = (await CreateMLCEngine!(modelId, {
        initProgressCallback: onProgress ?? ((progress: { progress: number; timeElapsed: number; text: string }) => {
          // Track if model is being downloaded (progress < 1 means downloading, not cached)
          if (progress.progress < 1.0) {
            wasDownloading = true;
          }
          const pct = (progress.progress * 100).toFixed(1);
          console.info(`[WebLLM] Loading: ${pct}% — ${progress.text}`);
        }),
        appConfig: prebuiltMLCAppConfig ?? undefined,
      })) as MLCEngine;

      // 4. Extract model info
      // web-llm doesn't expose a direct `.getModelInfo()` API, so we record
      // what we know at load time and report it back.
      // cached = true only if we never saw download progress (model already in OPFS)
      const cached = !wasDownloading;
      this._modelInfo = {
        modelId,
        quantization: modelId.toLowerCase().includes('q4') ? 'q4f16_1' : 'unknown',
        sizeBytes: 0, // web-llm doesn't expose artifact size directly
        cached,
      };

      this._ready = true;
      console.info(`[WebLLM] Model "${modelId}" loaded successfully`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      // Handle storage quota errors gracefully
      if (msg.includes('quota') || msg.includes('QuotaExceededError') || msg.includes('IndexedDB')) {
        console.error('[WebLLM] Storage quota exceeded. Try clearing browser cache and reloading.');
        throw new Error(
          'Browser storage quota exceeded while downloading the model. ' +
          'Please free up space in your browser\'s IndexedDB/OPFS storage and reload.'
        );
      }

      // Handle WebGPU not available error specifically
      const isWebGPUNotAvailable =
        err instanceof Error && (err as unknown as { name?: string }).name === 'WebGPUNotAvailableError';

      if (isWebGPUNotAvailable) {
        console.error('[WebLLM] WebGPU not available:', msg);
        throw new Error(
          'WebGPU is not available in this browser. ' +
          'Please switch to server API mode for LLM inference (per FR-015).'
        );
      }

      console.error('[WebLLM] Model initialization failed:', msg);
      throw new Error(`WebLLM initialization failed: ${msg}`);
    }
  }

  /**
   * Generate a stream of text tokens from a conversation.
   *
   * @param messages  Conversation history including system, user, and assistant messages.
   * @param options  Generation options (stream is ignored here — streaming is always on).
   * @yields        Each generated token as a string.
   */
  async *generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal }
  ): AsyncGenerator<string> {
    if (!this._engine || !this._ready) {
      throw new Error('WebLLMService not initialized. Call initialize() first.');
    }

    const signal = options?.signal ?? new AbortController().signal;

    try {
      const completion = await this._engine.chat.completions.create({
        messages: messages.map((m) => ({ role: m.role, content: messageContentToText(m.content) })),
        stream: true,
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
        top_p: options?.topP,
        signal,
      });

      for await (const chunk of completion) {
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.info('[WebLLM] Generation interrupted');
        throw err;
      }
      throw err;
    }
  }

  /**
   * Generate a complete response (non-streaming).
   *
   * @param messages  Conversation history.
   * @param options   Generation options.
   * @returns         The full generated text.
   */
  async generateComplete(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal }
  ): Promise<string> {
    if (!this._engine || !this._ready) {
      throw new Error('WebLLMService not initialized. Call initialize() first.');
    }

    const completion = await this._engine.chat.completions.create({
      messages: messages.map((m) => ({ role: m.role, content: messageContentToText(m.content) })),
      stream: false,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
      top_p: options?.topP,
      signal: options?.signal,
    });

    // Non-streaming: collect the single complete response
    const choice = (completion as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0];
    return choice?.message?.content ?? '';
  }

  /**
   * Interrupt any in-progress generation.
   */
  interrupt(): void {
    this._engine?.interruptGenerate();
    console.info('[WebLLM] Generation interrupt requested');
  }

  /**
   * @returns Which backend is currently active.
   */
  getInferenceMode(): LLMInferenceMode {
    return this._inferenceMode;
  }

  /**
   * @returns Model metadata, or null if not yet loaded.
   */
  getModelInfo(): LLMModelInfo | null {
    return this._modelInfo;
  }

  /**
   * @returns True if initialize() has completed successfully.
   */
  isReady(): boolean {
    return this._ready;
  }

  /**
   * Release model resources and reset the service.
   */
  dispose(): void {
    if (this._engine?.unload) {
      // unload is async; fire and forget in dispose path
      this._engine.unload().catch((err) => {
        console.warn('[WebLLM] Model unload warning:', err);
      });
    }
    this._engine = null;
    this._modelInfo = null;
    this._ready = false;
    this._inferenceMode = 'webgpu';
    console.info('[WebLLM] Service disposed');
  }
}
