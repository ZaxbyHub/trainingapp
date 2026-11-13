/**
 * Engine capability detection + recommendation.
 *
 * The two browser engines have very different hardware needs:
 *   - WebLLM  → requires usable WebGPU (fails hard without it); downloads its
 *               Llama weights from the internet, so it is selectable only in
 *               plain dev builds (engine-visibility.ts, #265).
 *   - wllama  → runs the bundled LFM2 model (text-only); uses WebGPU when the
 *               browser exposes a usable navigator.gpu and falls back to
 *               CPU/WASM otherwise; benefits from cross-origin isolation
 *               (threads).
 *
 * On the target hardware (12th-gen i5 + Iris Xe) WebGPU is often unavailable, so a
 * naive "WebGPU required" gate would wrongly block all browser inference. This
 * module detects real capabilities and recommends an engine + mode, with a simple
 * green/yellow/red suitability tier the UI can show.
 */

import type { BrowserEngine } from '../../types/llm';
import { getMemoryBudget } from '../embeddings/memory-aware';
import { isElectron } from '../desktop-session';
import { WEBLLM_VISIBLE } from './engine-visibility';
import { isWllamaWebGPUAccelerated } from './wllama-acceleration';

export type CapabilityTier = 'green' | 'yellow' | 'red';
export type MemoryTier = 'HIGH' | 'MEDIUM' | 'LOW';

export interface EngineCapability {
  /** A usable WebGPU adapter is available (required by WebLLM). */
  webgpu: boolean;
  /** Cross-origin isolated → SharedArrayBuffer/threads available (wllama multi-thread). */
  crossOriginIsolated: boolean;
  /** WebAssembly is available (required by wllama and ORT). */
  wasm: boolean;
  /** Best-effort available memory in MB (after browser overhead). */
  availableMB: number;
  /** Coarse memory classification. */
  memoryTier: MemoryTier;
  /** Logical CPU cores (navigator.hardwareConcurrency). */
  cores: number;
  /** Engine we recommend given the detected capabilities. */
  recommendedEngine: BrowserEngine;
  /**
   * Inference mode we recommend. 'api' (the desktop backend) only inside the
   * desktop app; the browser app has no API-server mode, so a device that
   * cannot run browser inference is pointed at an external model ('external',
   * Settings → Model & connection).
   */
  recommendedMode: 'browser-local' | 'api' | 'external';
  /** Overall browser-inference suitability for this device. */
  tier: CapabilityTier;
  /** Human-readable reasons backing the recommendation. */
  reasons: string[];
}

function memoryTierFor(availableMB: number): MemoryTier {
  if (availableMB >= 8192) return 'HIGH';
  if (availableMB >= 4096) return 'MEDIUM';
  return 'LOW';
}

/** Live WebGPU adapter probe (more reliable than feature-presence alone). */
async function probeWebGPU(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

function isCrossOriginIsolated(): boolean {
  // crossOriginIsolated is the canonical signal for SharedArrayBuffer/threads.
  if (typeof globalThis !== 'undefined' && typeof globalThis.crossOriginIsolated === 'boolean') {
    return globalThis.crossOriginIsolated;
  }
  return typeof SharedArrayBuffer !== 'undefined';
}

/**
 * Detect capabilities and compute an engine/mode recommendation + tier.
 *
 * Recommendation logic (deliberately simple and explainable; the
 * recommendation is computed among VISIBLE engines only, #265 plan A3-iv —
 * WebLLM is never recommended where it is hidden, while the raw `webgpu`
 * hardware result is retained either way):
 *   - No WASM at all                       → red, recommend server (api).
 *   - WebGPU available, WebLLM visible     → WebLLM is the fast path (green).
 *   - WebGPU available, WebLLM hidden      → wllama (green; it can use WebGPU).
 *   - No WebGPU, WASM + threads + ≥MEDIUM  → wllama, green.
 *   - No WebGPU, WASM but no threads or LOW → wllama, yellow (works, slower).
 */
export async function detectEngineCapability(): Promise<EngineCapability> {
  const wasm = typeof WebAssembly !== 'undefined';
  const webgpu = await probeWebGPU();
  const coi = isCrossOriginIsolated();
  const { availableMB } = getMemoryBudget();
  const memoryTier = memoryTierFor(availableMB);
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 0;

  const reasons: string[] = [];
  let recommendedEngine: BrowserEngine;
  let recommendedMode: EngineCapability['recommendedMode'];
  let tier: CapabilityTier;

  if (!wasm) {
    recommendedEngine = 'wllama';
    recommendedMode = isElectron() ? 'api' : 'external';
    tier = 'red';
    reasons.push(
      isElectron()
        ? 'WebAssembly is unavailable; the built-in model cannot run in this window — run it in the desktop backend (Settings → Model & connection).'
        : 'WebAssembly is unavailable; browser inference is not supported — use the desktop app or an external model server (Settings → Model & connection).'
    );
  } else if (webgpu) {
    if (WEBLLM_VISIBLE) {
      recommendedEngine = 'webllm';
      recommendedMode = 'browser-local';
      tier = 'green';
      reasons.push('WebGPU is available — WebLLM offers the fastest local inference.');
      reasons.push('wllama runs the bundled LFM2 model offline (text-only) if you prefer no download.');
    } else {
      // #265 (A3-iv): WebLLM is hidden in packaged/offline builds; among the
      // visible engines wllama is the recommendation. INT-1: the WebGPU
      // reason is reconciled with the wllama acceleration TRUTH via the
      // shared probe — navigator.gpu presence alone does not make wllama
      // WebGPU-accelerated (Firefox without JSPI: wllama disables WebGPU
      // there), so the copy must not claim it does.
      recommendedEngine = 'wllama';
      recommendedMode = 'browser-local';
      tier = 'green';
      if (isWllamaWebGPUAccelerated()) {
        reasons.push('WebGPU is available — wllama can run the bundled model on it.');
      } else {
        reasons.push('WebGPU is present, but the bundled model runs on CPU/WASM in this browser.');
      }
    }
  } else {
    // No WebGPU → wllama is the only viable browser engine.
    recommendedEngine = 'wllama';
    recommendedMode = 'browser-local';
    reasons.push('WebGPU is unavailable — wllama runs on the CPU and is recommended.');
    if (coi && memoryTier !== 'LOW') {
      tier = 'green';
      reasons.push('Multi-threading is enabled and memory is sufficient.');
    } else {
      tier = 'yellow';
      if (!coi) {
        reasons.push('Cross-origin isolation is off; wllama runs single-threaded (slower).');
      }
      if (memoryTier === 'LOW') {
        reasons.push('Low available memory; consider a smaller model, the desktop app, or an external model server.');
      }
    }
  }

  return {
    webgpu,
    crossOriginIsolated: coi,
    wasm,
    availableMB,
    memoryTier,
    cores,
    recommendedEngine,
    recommendedMode,
    tier,
    reasons,
  };
}
