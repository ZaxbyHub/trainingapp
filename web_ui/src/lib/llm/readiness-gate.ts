/**
 * Browser-LLM readiness trigger — extracted from useServiceInitialization so it
 * can be imported by light consumers (e.g. ChatPage) WITHOUT pulling in the heavy
 * search/embedding/edgevec modules the hook also imports.
 *
 * Owns the module-level readiness cache and dispatches the 'readiness-gate-checked'
 * event that the hook listens to in order to drive `isModelReady`.
 */

import { ModelReadinessGate, type ReadinessResult } from './model-readiness';
import { getPreferredBrowserEngine } from './llm-factory';
import { LLM_MODEL_DIR } from '../models/model-manifest';
import type { BrowserEngine } from '../../types/llm';

let readinessGateInitPromise: Promise<ReadinessResult | null> | null = null;
let lastReadinessResult: ReadinessResult | null = null;
/** Engine the cached readiness result was computed for (cache is engine-specific). */
let lastReadinessEngine: BrowserEngine | null = null;
let webgpuAvailableCached = false;
const readinessGateInstance: { current: ModelReadinessGate | null } = { current: null };

/** Readiness model id for each engine (wllama loads the packaged LFM2-VL GGUF). */
function modelIdForEngine(engine: BrowserEngine): string {
  return engine === 'wllama' ? LLM_MODEL_DIR : 'SmolLM3-3B-Q4_K_M';
}

/** Snapshot of the last readiness check, for the hook's initial servicesReady state. */
export function getReadinessSnapshot(): { modelCached: boolean; webgpuAvailable: boolean } {
  return {
    modelCached: lastReadinessResult?.checks.modelCached ?? false,
    webgpuAvailable: webgpuAvailableCached,
  };
}

export function getReadinessGateInstance(): ModelReadinessGate | null {
  return readinessGateInstance.current;
}

/** Update the cache from an observed event (used by the hook's listener). */
export function applyReadinessFromEvent(result: ReadinessResult | undefined, hasWebGPU: boolean): void {
  if (result) lastReadinessResult = result;
  webgpuAvailableCached = hasWebGPU;
}

/** Reset cached readiness state (test/teardown). */
export function resetReadinessCache(): void {
  readinessGateInitPromise = null;
  lastReadinessResult = null;
  lastReadinessEngine = null;
  webgpuAvailableCached = false;
  readinessGateInstance.current = null;
}

/**
 * Ensure the model readiness gate has been checked for the given (or preferred)
 * engine. Safe to call repeatedly; caches per engine and re-evaluates on change.
 * Dispatches 'readiness-gate-checked' so hooks can update servicesReady + call
 * setModelReady engine-awarely.
 */
export async function ensureReadinessGateChecked(
  engineArg?: BrowserEngine
): Promise<ReadinessResult | null> {
  const engine = engineArg ?? getPreferredBrowserEngine();

  // Cache is engine-specific: a different engine must be re-evaluated (e.g. wllama
  // does not need WebGPU, webllm does).
  if (lastReadinessResult && lastReadinessEngine === engine) {
    return lastReadinessResult;
  }
  if (readinessGateInitPromise && lastReadinessEngine === engine) {
    return readinessGateInitPromise;
  }

  readinessGateInitPromise = (async () => {
    try {
      readinessGateInstance.current = new ModelReadinessGate();
      const readinessResult = await readinessGateInstance.current.checkReadiness(
        modelIdForEngine(engine),
        engine
      );

      // Use the real adapter-probe result (not mere navigator.gpu presence).
      const hasWebGPU = readinessResult.checks.webgpu;
      webgpuAvailableCached = hasWebGPU;

      lastReadinessResult = readinessResult;
      lastReadinessEngine = engine;

      // Engine-aware "usable now": webllm needs the model downloaded; wllama needs
      // the hardware to be ready AND the packaged GGUF present (it loads lazily).
      const modelReady =
        engine === 'wllama'
          ? readinessResult.ready && readinessResult.checks.modelCached
          : readinessResult.checks.modelCached;

      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('readiness-gate-checked', {
            detail: { result: readinessResult, hasWebGPU, engine, modelReady },
          })
        );
      }

      return readinessResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check model readiness';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('readiness-gate-error', { detail: { message } })
        );
      }
      // Notify with a fallback that matches the success-path event contract:
      // include `engine` and `modelReady` (the fields the success path emits and
      // the hook reads) so listeners don't get `undefined` for them on error.
      // `result` stays a partial — consumers optional-chain into result.checks.
      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('readiness-gate-checked', {
            detail: {
              result: { checks: { modelCached: false } },
              hasWebGPU,
              engine,
              modelReady: false,
            },
          })
        );
      }
      return null;
    } finally {
      readinessGateInitPromise = null;
    }
  })();

  return readinessGateInitPromise;
}
