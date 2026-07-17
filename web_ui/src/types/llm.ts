/**
 * LLM types for browser-side inference via web-llm.
 */

/**
 * A single message in a conversation with the LLM.
 *
 * `content` is either plain text or, for multimodal models (wllama + mmproj),
 * an ordered list of text/image parts. Image data is a raw ArrayBuffer, matching
 * wllama's chat-completion content shape.
 */
export type LLMTextPart = { type: 'text'; text: string };
export type LLMImagePart = { type: 'image'; data: ArrayBuffer };
export type LLMContentPart = LLMTextPart | LLMImagePart;

export type LLMMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMContentPart[];
};

/**
 * Flatten message content to plain text, dropping any image parts.
 * Used by text-only engines (WebLLM) which cannot consume images.
 */
export function messageContentToText(content: string | LLMContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is LLMTextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * Options for text generation.
 */
export type LLMGenerateOptions = {
  /** Maximum number of tokens to generate. */
  maxTokens?: number;
  /** Sampling temperature (higher = more creative). */
  temperature?: number;
  /** Nucleus sampling probability threshold. */
  topP?: number;
  /** Whether to stream tokens as they are generated. */
  stream?: boolean;
};

/**
 * Information about a loaded LLM model.
 */
export type LLMModelInfo = {
  /** The model identifier string used by web-llm. */
  modelId: string;
  /** Quantization format (e.g., 'Q4_K_M'). */
  quantization: string;
  /** Model size in bytes. */
  sizeBytes: number;
  /** Whether the model is cached in OPFS. */
  cached: boolean;
};

/**
 * The active inference backend.
 * - 'webgpu': WebLLM (MLC) — fast when WebGPU is available.
 * - 'wasm':   wllama (llama.cpp WASM) — CPU/SIMD, no WebGPU required.
 */
export type LLMInferenceMode = 'webgpu' | 'wasm';

/**
 * Which browser inference engine to use for local generation.
 * Defaults to 'wllama' (robust on hardware without usable WebGPU, and the
 * multimodal-capable path via LFM2.5-VL + mmproj).
 */
export type BrowserEngine = 'wllama' | 'webllm';

/** Progress payload reported during model load/initialization. */
export type LLMProgress = {
  /** Fraction complete in [0, 1]. */
  progress: number;
  /** Milliseconds elapsed since load started. */
  timeElapsed: number;
  /** Human-readable status text. */
  text: string;
};

/**
 * Shared contract implemented by every browser LLM engine (WebLLM, wllama).
 *
 * This is the seam that lets the rest of the app stay engine-agnostic: the RAG
 * orchestrator consumes only this interface, and a factory picks the concrete
 * engine from the user's preference. New engines must match this exactly.
 */
export interface LLMService {
  /** Load/prepare the model. `onProgress` reports download/init progress. */
  initialize(modelId?: string, onProgress?: (progress: LLMProgress) => void): Promise<void>;
  /** Stream generated tokens as they are produced. */
  generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal }
  ): AsyncGenerator<string>;
  /** Generate the full response (non-streaming). */
  generateComplete(
    messages: LLMMessage[],
    options?: LLMGenerateOptions & { signal?: AbortSignal }
  ): Promise<string>;
  /** The backend this engine runs on. */
  getInferenceMode(): LLMInferenceMode;
  /** Metadata about the loaded model, or null if not loaded. */
  getModelInfo(): LLMModelInfo | null;
  /** True when the model is loaded and ready to generate. */
  isReady(): boolean;
  /** Interrupt an in-progress generation. */
  interrupt(): void;
  /** U8c: true when the loaded model accepts image inputs (multimodal).
   *  Optional — WebLLMService returns false; WllamaService consults
   *  wllama.supportInputModality('image'). */
  supportsImages?(): boolean;
  /** Release resources held by the engine. */
  dispose(): void;
}
