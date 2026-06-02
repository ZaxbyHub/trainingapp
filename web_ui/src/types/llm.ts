/**
 * LLM types for browser-side inference via web-llm.
 */

/**
 * A single message in a conversation with the LLM.
 */
export type LLMMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

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
 */
export type LLMInferenceMode = 'webgpu';
