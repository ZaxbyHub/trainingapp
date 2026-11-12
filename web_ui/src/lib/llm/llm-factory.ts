/**
 * LLM engine factory — picks the concrete browser engine behind the shared
 * `LLMService` contract so the rest of the app stays engine-agnostic.
 *
 * - 'wllama' (default): the bundled LFM2 model via llama.cpp WASM — WebGPU
 *   when the browser exposes a usable navigator.gpu, CPU/SIMD otherwise;
 *   text-only (#156).
 * - 'webllm': WebLLM (MLC), faster when WebGPU is usable, text-only here.
 *   Selectable only in plain dev builds (engine-visibility.ts, #265); a
 *   'webllm' request that reaches the factory while it is hidden is served by
 *   wllama, so a stale persisted preference can never reach the Llama download.
 */

import type { BrowserEngine, LLMService } from '../../types/llm';
import { WebLLMService } from './web-llm-service';
import { WllamaService } from './wllama-service';
import { INFERENCE_MODE_KEY } from '../storage/persisted-keys';
import { WEBLLM_VISIBLE } from './engine-visibility';

/** Default browser engine — wllama, for robustness on hardware without WebGPU. */
export const DEFAULT_BROWSER_ENGINE: BrowserEngine = 'wllama';

/**
 * Return the LLMService singleton for the given engine. #265 (A3-iii): the
 * factory boundary normalizes a hidden 'webllm' to wllama.
 */
export function getLLMService(engine: BrowserEngine = DEFAULT_BROWSER_ENGINE): LLMService {
  return engine === 'webllm' && WEBLLM_VISIBLE
    ? WebLLMService.getInstance()
    : WllamaService.getInstance();
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
    const raw = localStorage.getItem(INFERENCE_MODE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { browserEngine?: BrowserEngine };
      if (parsed.browserEngine === 'webllm' || parsed.browserEngine === 'wllama') {
        // #265 (A3-ii): a persisted 'webllm' that outlives a switch to a
        // packaged/offline build normalizes to wllama here too.
        return parsed.browserEngine === 'webllm' && !WEBLLM_VISIBLE ? 'wllama' : parsed.browserEngine;
      }
    }
  } catch {
    // storage unavailable / malformed -> default
  }
  return DEFAULT_BROWSER_ENGINE;
}
