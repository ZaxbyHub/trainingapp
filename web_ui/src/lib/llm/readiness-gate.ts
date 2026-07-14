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
import { WEBLLM_DEFAULT_MODEL_ID } from './web-llm-service';
import type { BrowserEngine } from '../../types/llm';

let readinessGateInitPromise: Promise<ReadinessResult | null> | null = null;
/**
 * Engine the IN-FLIGHT check is running for. Set the moment the promise is
 * created (not after it resolves) so concurrent callers for the SAME engine
 * share one in-flight promise instead of each spawning a full check. A prior
 * version keyed this on `lastReadinessEngine`, which stayed null until the
 * async check completed — making the dedup guard unreachable during in-flight
 * and spawning duplicate HEAD/adapter probes (issue #21 F7/F8).
 */
let readinessGateInitEngine: BrowserEngine | null = null;
let lastReadinessResult: ReadinessResult | null = null;
/** Engine the cached readiness result was computed for (cache is engine-specific). */
let lastReadinessEngine: BrowserEngine | null = null;
let webgpuAvailableCached = false;
const readinessGateInstance: { current: ModelReadinessGate | null } = { current: null };

/**
 * Readiness model id for each engine. Both branches read a single source of
 * truth so the readiness gate, the download flow, and the LLM services never
 * disagree on which model id an engine uses (a prior hardcoded id mismatch
 * made `isModelReady` unreachable for webllm — see issue #21 F3).
 */
function modelIdForEngine(engine: BrowserEngine): string {
  return engine === 'wllama' ? LLM_MODEL_DIR : WEBLLM_DEFAULT_MODEL_ID;
}

/** Snapshot of the last readiness check, for the hook's initial servicesReady state. */
export function getReadinessSnapshot(): { modelCached: boolean; webgpuAvailable: boolean } {
  return {
    modelCached: lastReadinessResult?.checks.modelCached ?? false,
    webgpuAvailable: webgpuAvailableCached,
  };
}

/**
 * Full last readiness result, for UI surfaces (e.g. the ChatPage model-block
 * overlay) that need to render the actual `failures`/`recommendations` rather
 * than a generic message. Returns null before the first check completes.
 */
export function getReadinessResultSnapshot(): ReadinessResult | null {
  return lastReadinessResult;
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
  readinessGateInitEngine = null;
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
  // Dedupe concurrent IN-FLIGHT checks for the SAME engine. The engine key is
  // set when the promise is created (below), so concurrent callers arriving
  // while the check is still running hit this branch and share the promise
  // instead of each spawning a full check. (issue #21 F7/F8)
  if (readinessGateInitPromise && readinessGateInitEngine === engine) {
    return readinessGateInitPromise;
  }

  // Tag the in-flight promise with its engine NOW (before any await) so the
  // dedup guard above can match concurrent same-engine callers.
  readinessGateInitEngine = engine;
  // Declared before the closure (and assigned after) rather than inline, so
  // the `finally` block's reference to `thisPromise` is a closure over an
  // already-assigned variable at the time it actually runs (after the first
  // await) — TS's control-flow analysis can't see that ordering if the
  // closure is created and invoked in the same `const` initializer.
  let thisPromise: Promise<ReadinessResult | null>;
  const run = async (): Promise<ReadinessResult | null> => {
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

      // Engine-aware "usable now": both engines require the hardware/memory
      // check to pass AND the model to be present. For webllm, `ready` also
      // encodes WebGPU availability — a previously-downloaded (cached) model
      // whose WebGPU support has since gone away (or whose memory is now
      // insufficient) must NOT report modelReady=true, or the hard-requirement
      // failure only surfaces as a runtime error at generate-time instead of
      // being caught by the model-blocked preflight overlay (issue #21).
      const modelReady = readinessResult.ready && readinessResult.checks.modelCached;

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
      // Only clear the module-level tracking if it still points to THIS
      // invocation's own promise. A later-arriving call for a different
      // engine may have already overwritten these vars to track its own
      // in-flight check (since the dedup guard above only matches same-engine
      // callers); nulling unconditionally here would clobber that later
      // call's tracking and let a third caller bypass dedup (issue #21).
      if (readinessGateInitPromise === thisPromise) {
        readinessGateInitPromise = null;
        readinessGateInitEngine = null;
      }
    }
  };

  thisPromise = run();
  readinessGateInitPromise = thisPromise;
  return thisPromise;
}
