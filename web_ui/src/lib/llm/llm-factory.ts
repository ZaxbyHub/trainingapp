/**
 * LLM engine factory — picks the concrete browser engine behind the shared
 * `LLMService` contract so the rest of the app stays engine-agnostic.
 *
 * - 'wllama' (default): llama.cpp WASM, CPU/SIMD, no WebGPU, multimodal-capable.
 * - 'webllm': WebLLM (MLC), faster when WebGPU is usable, text-only here.
 */

import type { BrowserEngine, LLMService } from '../../types/llm';
import { WebLLMService } from './web-llm-service';
import { WllamaService } from './wllama-service';

/** Default browser engine — wllama, for robustness on hardware without WebGPU. */
export const DEFAULT_BROWSER_ENGINE: BrowserEngine = 'wllama';

const STORAGE_KEY = 'inference-mode';

/**
 * Return the LLMService singleton for the given engine.
 */
export function getLLMService(engine: BrowserEngine = DEFAULT_BROWSER_ENGINE): LLMService {
  return engine === 'webllm' ? WebLLMService.getInstance() : WllamaService.getInstance();
}

/** Dispose the singleton for the given engine if it has been initialized. */
export function disposeBrowserEngine(engine: BrowserEngine): void {
  try {
    if (engine === 'wllama') {
      // WllamaService.dispose() nulls its singleton; only dispose if it exists
      if (WllamaService.hasInstance()) {
        WllamaService.getInstance().dispose();
      }
    } else {
      // WebLLMService keeps its singleton alive after dispose (just resets state)
      WebLLMService.getInstance().dispose();
    }
  } catch {
    // Service may not be initialized, ignore
  }
}

/**
 * Read the user's persisted browser-engine preference (written by
 * InferenceModeContext). Falls back to the default for non-React callers (e.g.
 * the RAG orchestrator) and when storage is unavailable or malformed.
 */
export function getPreferredBrowserEngine(): BrowserEngine {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { browserEngine?: BrowserEngine };
      if (parsed.browserEngine === 'webllm' || parsed.browserEngine === 'wllama') {
        return parsed.browserEngine;
      }
    }
  } catch {
    // storage unavailable / malformed -> default
  }
  return DEFAULT_BROWSER_ENGINE;
}
