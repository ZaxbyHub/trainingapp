/**
 * WebLLM Service — browser-side LLM inference with WebGPU.
 *
 * Supports Llama-3.2-3B-Instruct-q4f16_1-MLC (~1.9GB) and uses the Cache Storage API
 * (`caches.open('webllm/model')`, web-llm's default cacheType) for model artifact caching.
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
import { WebGPUWatchdog, createRecoveryHandler } from './webgpu-watchdog';

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

/**
 * Single source of truth for the WebLLM engine's default model id.
 *
 * The readiness gate's `modelIdForEngine('webllm')`, the Settings "Download
 * Model" flow, and `WebLLMService.initialize` must all agree on this value —
 * a mismatch makes `isModelReady` unreachable (the gate probes one id while the
 * service/download path uses another). Exported so every consumer reads the
 * same constant instead of hardcoding a string that can drift.
 */
export const WEBLLM_DEFAULT_MODEL_ID = 'Llama-3.2-3B-Instruct-q4f16_1-MLC';

const DEFAULT_MODEL_ID = WEBLLM_DEFAULT_MODEL_ID;

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
  /**
   * In-flight init guard so concurrent first-time calls share ONE initialize()
   * run (mirrors WllamaService's initPromise pattern). Without it, two near-
   * simultaneous callers could each reach CreateMLCEngine and create two
   * engines. (issue #21 F11)
   */
  private _initPromise: Promise<void> | null = null;
  /** WebGPU context-loss watchdog; started after init, disposed on teardown. */
  private _watchdog: WebGPUWatchdog | null = null;
  /**
   * Monotonic generation counter, bumped by dispose(). WebLLMService keeps its
   * singleton alive after dispose (dispose() only resets state — see
   * llm-factory.ts's disposeBrowserEngine), so an in-flight _startWatchdog()
   * call that is still awaiting adapter.requestDevice() when dispose() runs
   * must not resurrect a watchdog on the now-disposed instance.
   * _startWatchdog captures the generation before awaiting and bails out if
   * it has since changed. (issue #21 F-WATCHDOG)
   */
  private _generation = 0;

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
   * Detect whether WebGPU is available via navigator.gpu, returning the adapter
   * when it is. The adapter is returned (not discarded) so a sibling monitoring
   * GPUDevice can be created from the SAME adapter for the WebGPU watchdog — a
   * driver crash / OOM / tab-backgrounding kill affects every device on the
   * adapter, so monitoring a sibling catches the real-world context-loss cases
   * without needing access to WebLLM's internal device. (issue #21 F11)
   */
  private async _detectWebGPU(): Promise<{ available: boolean; adapter?: GPUAdapter }> {
    try {
      if (!navigator.gpu) {
        console.info('[WebLLM] WebGPU not available (navigator.gpu missing)');
        return { available: false };
      }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        console.info('[WebLLM] WebGPU requestAdapter returned null — WebGPU unavailable');
        return { available: false };
      }

      // Reject software-renderer adapters (SwiftShader, llvmpipe) that work
      // but provide unusably slow performance for ML inference (FR-005).
      // The current WebGPU spec exposes adapter info via the `adapter.info`
      // property (a GPUAdapterInfo); the old `requestAdapterInfo()` method was
      // removed from @webgpu/types. Fall back best-effort via try/catch for
      // browsers that don't expose `info`. (issue #21 F11)
      try {
        const adapterWithInfo = adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string } };
        // Explicit capability check: `info` was only added to the spec/types
        // in mid-2024, so browsers older than that expose no `info` property
        // at all. Without this check the vendor/architecture below silently
        // become empty strings and the software-GPU-rejection check
        // silently no-ops with no visible signal in diagnostics.
        if (!('info' in adapterWithInfo) || adapterWithInfo.info === undefined) {
          console.warn(
            '[WebLLM] adapter.info is unavailable in this browser (pre-mid-2024 WebGPU implementation); ' +
            'cannot check for a software-renderer adapter (SwiftShader/llvmpipe). Proceeding best-effort — ' +
            'a software GPU may be used without being rejected.'
          );
        } else {
          const info = adapterWithInfo.info;
          const vendor = (info.vendor || '').toLowerCase();
          const architecture = (info.architecture || '').toLowerCase();
          if (vendor.includes('mesa') || architecture.includes('llvmpipe') || architecture.includes('swiftshader')) {
            console.warn('[WebLLM] Rejected software-renderer adapter:', { vendor, architecture });
            return { available: false };
          }
        }
      } catch (err) {
        console.warn('[WebLLM] adapter.info check failed unexpectedly, proceeding best-effort:', err);
      }

      console.info('[WebLLM] WebGPU adapter detected');
      return { available: true, adapter };
    } catch (err) {
      console.warn('[WebLLM] WebGPU detection failed:', err);
      return { available: false };
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

    // In-flight guard: concurrent first-time callers share one init run instead
    // of each creating an engine. (issue #21 F11)
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = this._doInitialize(modelId, onProgress);
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  private async _doInitialize(
    modelId: string,
    onProgress?: InitProgressCallback
  ): Promise<void> {
    console.info(`[WebLLM] Initializing with model: ${modelId}`);

    // 1. Detect backend — only WebGPU is supported
    const detection = await this._detectWebGPU();
    if (!detection.available) {
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

      // 5. Start the WebGPU context-loss watchdog against a sibling device on
      // the SAME adapter we just probed. A driver crash / GPU OOM / tab
      // backgrounding kill affects every device on the adapter, so this catches
      // the real-world loss cases and triggers recovery via createRecoveryHandler
      // (dispose + re-init, or surface a switch-to-server error). (issue #21 F11)
      await this._startWatchdog(detection.adapter);
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

    // S7: web-llm's `signal` field on chat.completions.create is inert at
    // runtime (it is not honored by the MLCEngine streaming loop). The REAL
    // cancellation primitive is engine.interruptGenerate(), invoked via the
    // service's interrupt() — but the orchestrator/RAG path only has the
    // AbortSignal. Wire an abort listener here so aborting the signal (from
    // ChatPage.cancelActiveStream → abortController.abort()) actually stops
    // the WebGPU generation. Mirrors the wllama path's abort-forwarding.
    const onAbort = () => {
      try {
        this._engine?.interruptGenerate();
      } catch (err) {
        console.warn('[WebLLM] interruptGenerate on abort failed', err);
      }
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort);
    }

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
        if (signal.aborted) {
          // interruptGenerate() causes the async iterator to end/throw; break
          // defensively if it hasn't yet.
          break;
        }
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
    } finally {
      signal.removeEventListener('abort', onAbort);
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
    // Bump the generation so any _startWatchdog() call still awaiting
    // adapter.requestDevice() from a prior generation discards its result
    // instead of resurrecting a watchdog on this now-disposed instance.
    // (issue #21 F-WATCHDOG)
    this._generation++;

    // Stop the context-loss watchdog before tearing down the engine.
    this._watchdog?.dispose();
    this._watchdog = null;

    if (this._engine?.unload) {
      // unload is async; fire and forget in dispose path
      this._engine.unload().catch((err) => {
        console.warn('[WebLLM] Model unload warning:', err);
      });
    }
    this._engine = null;
    this._modelInfo = null;
    this._ready = false;
    this._initPromise = null;
    this._inferenceMode = 'webgpu';
    console.info('[WebLLM] Service disposed');
  }

  /**
   * Start the WebGPU context-loss watchdog on a sibling device from the given
   * adapter. `adapter.requestDevice()` is ASYNC in the WebGPU spec (returns a
   * Promise<GPUDevice>), so this method is async and awaited. The watchdog is
   * one-shot (it stops itself after the first loss), so re-init creates a fresh
   * one. Failures here are non-fatal — best-effort monitoring is strictly
   * better than none. (issue #21 F11)
   */
  private async _startWatchdog(adapter?: GPUAdapter): Promise<void> {
    if (!adapter) return;
    // Snapshot the generation before the async requestDevice() gap so we can
    // detect a concurrent dispose() when it resolves. (issue #21 F-WATCHDOG)
    const generation = this._generation;
    try {
      const device = await adapter.requestDevice();
      if (!device) {
        console.info('[WebLLM] Watchdog: requestDevice returned null, skipping.');
        return;
      }
      // dispose() may have run while requestDevice() was in flight. The
      // singleton survives dispose() (only its state is reset — see
      // llm-factory.ts), so without this guard we'd unconditionally assign a
      // fresh, started watchdog (with its recovery handler) onto an instance
      // nobody thinks is live anymore. Discard the just-created device instead.
      if (generation !== this._generation) {
        console.info('[WebLLM] Watchdog: service was disposed while requestDevice() was pending, discarding device.');
        device.destroy();
        return;
      }
      this._watchdog = new WebGPUWatchdog();
      this._watchdog.start(
        device,
        createRecoveryHandler(this),
        () => this._ready // isGenerating proxy: any in-flight generation has _ready true
      );
    } catch (err) {
      console.warn('[WebLLM] Watchdog start failed (non-fatal):', err);
    }
  }
}
