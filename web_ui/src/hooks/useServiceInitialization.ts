import { useState, useEffect, useRef, useCallback } from 'react';
import type { BrowserEngine } from '../types/llm';
import { getEmbeddingService } from '../lib/embeddings/embedding-service';
import { getVectorIndex } from '../lib/search/vector-index';
import { getKeywordIndex } from '../lib/search/keyword-index';
import { type ModelReadinessGate, type ReadinessResult } from '../lib/llm/model-readiness';
import { WebLLMService } from '../lib/llm/web-llm-service';
import {
  ensureReadinessGateChecked,
  getReadinessSnapshot,
  getReadinessGateInstance,
  applyReadinessFromEvent,
} from '../lib/llm/readiness-gate';

// The readiness trigger lives in a light module (no heavy search/edgevec imports)
// so light consumers can import it; re-export it for existing callers.
export { ensureReadinessGateChecked };

// Module-level mutable state for lazy initialization support.
let embeddingServiceReady = false;
let embeddingServiceInitPromise: Promise<boolean> | null = null;
/**
 * Module-level slot for the StrictMode-deferred destructive-cleanup timer.
 * Kept at module scope (not a per-instance ref) so a NEW mount of the hook can
 * cancel a dispose scheduled by a previous instance's unmount — closing the
 * real-unmount+rapid-remount race where a per-instance ref would be null on
 * the new instance and the old timer would fire and tear down shared
 * singletons the new instance is using. (PR #28 PRR-004)
 */
let strictModeDisposeTimer: ReturnType<typeof setTimeout> | null = null;

export interface ServiceInitializationState {
  isInitialized: boolean;
  initError: string | null;
  currentStep: string;
  servicesReady: {
    embeddings: boolean;
    vectorIndex: boolean;
    keywordIndex: boolean;
    modelCached: boolean;
    webgpuAvailable: boolean;
  };
}

export interface UseServiceInitializationOptions {
  setModelReady: (ready: boolean) => void;
  setModelLoadingProgress: (progress: number) => void;
  /** Current browser engine — used to filter readiness events so a stale event
   *  from engine A can't overwrite the readiness state for engine B (issue #21 F7/F8). */
  browserEngine: BrowserEngine;
}

export interface UseServiceInitialization {
  (options: UseServiceInitializationOptions): ServiceInitializationState;
}

/**
 * Ensures the embedding service (heavy ~130MB ONNX) is initialized.
 * Safe to call multiple times; delegates to service's own idempotent initialize().
 * Call this from query paths (e.g. rag-orchestrator) before first encode().
 * Dispatches 'embedding-service-ready' event so mounted hooks can update servicesReady state.
 */
export async function ensureEmbeddingServiceReady(): Promise<boolean> {
  if (embeddingServiceReady) {
    return true;
  }

  if (embeddingServiceInitPromise) {
    return embeddingServiceInitPromise;
  }

  embeddingServiceInitPromise = (async () => {
    try {
      const embeddingService = getEmbeddingService();
      await embeddingService.initialize();
      embeddingServiceReady = embeddingService.isReady();

      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('embedding-service-ready', {
            detail: { ready: embeddingServiceReady },
          })
        );
      }

      return embeddingServiceReady;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load embedding model';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('embedding-service-error', {
            detail: { message },
          })
        );
      }
      return false;
    } finally {
      embeddingServiceInitPromise = null;
    }
  })();

  return embeddingServiceInitPromise;
}

export const useServiceInitialization: UseServiceInitialization = ({
  setModelReady,
  setModelLoadingProgress,
  browserEngine,
}) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState('Initializing...');
  const [servicesReady, setServicesReady] = useState({
    embeddings: embeddingServiceReady,
    vectorIndex: false,
    keywordIndex: false,
    modelCached: getReadinessSnapshot().modelCached,
    webgpuAvailable: getReadinessSnapshot().webgpuAvailable,
  });

  const isMountedRef = useRef(true);
  const initializationStartedRef = useRef(false);
  const readinessGateRef = useRef<ModelReadinessGate | null>(null);
  // Mirror of the current browser engine so the (once-registered) readiness
  // event listener can discard stale events from a previous engine selection.
  const currentEngineRef = useRef<BrowserEngine>(browserEngine);
  useEffect(() => {
    currentEngineRef.current = browserEngine;
  }, [browserEngine]);

  const initializeServices = useCallback(async () => {
    if (initializationStartedRef.current) {
      return;
    }
    initializationStartedRef.current = true;

    // Step 1 only: lightweight search services on boot (fast, <100ms).
    // Embedding model and readiness gate are deferred to first use via ensure*() exports.
    setCurrentStep('Initializing search services...');
    setModelLoadingProgress(10);

    try {
      const vectorIndex = getVectorIndex();
      const keywordIndex = getKeywordIndex();

      await vectorIndex.initialize();
      if (!isMountedRef.current) return;

      await keywordIndex.initialize();
      if (!isMountedRef.current) return;

      setServicesReady(prev => ({
        ...prev,
        vectorIndex: true,
        keywordIndex: true,
      }));

      readinessGateRef.current = getReadinessGateInstance();

      if (isMountedRef.current) {
        setCurrentStep('Ready');
        setModelLoadingProgress(100);
        setIsInitialized(true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize search services';
      setInitError(message);
      if (isMountedRef.current) {
        setCurrentStep('Ready (with init errors)');
        setModelLoadingProgress(100);
        setIsInitialized(true);
      }
    }
  }, [setModelReady, setModelLoadingProgress]);

  useEffect(() => {
    isMountedRef.current = true;

    // StrictMode remount (or a real remount) cancels any deferred destructive
    // cleanup scheduled by a previous instance's unmount, so shared singletons
    // are NOT torn down while a new instance is actively using them. The slot
    // is module-level so a new instance can cancel a prior instance's timer.
    // (issue #21 F11, PR #28 PRR-004)
    if (strictModeDisposeTimer !== null) {
      clearTimeout(strictModeDisposeTimer);
      strictModeDisposeTimer = null;
    }

    // Sync from module in case ensure*() was invoked by other code prior to this mount
    readinessGateRef.current = getReadinessGateInstance();

    // Register listeners for lazy init notifications. When ensureEmbeddingServiceReady()
    // or ensureReadinessGateChecked() are called (from rag-orchestrator etc on first query),
    // these update the local servicesReady snapshot and invoke setModelReady so that
    // inference context reflects the deferred readiness without requiring boot-time blocking.
    const handleEmbeddingReady = (event: Event) => {
      if (!isMountedRef.current) return;
      const custom = event as CustomEvent<{ ready: boolean }>;
      const ready = !!custom.detail?.ready;
      embeddingServiceReady = ready;
      setServicesReady(prev => ({ ...prev, embeddings: ready }));
    };

    const handleEmbeddingError = (event: Event) => {
      if (!isMountedRef.current) return;
      const custom = event as CustomEvent<{ message: string }>;
      const message = custom.detail?.message || 'Failed to load embedding model';
      setInitError(prev => (prev ? `${prev}; ${message}` : message));
    };

    const handleReadinessChecked = (event: Event) => {
      if (!isMountedRef.current) return;
      const custom = event as CustomEvent<{
        result?: ReadinessResult;
        hasWebGPU?: boolean;
        modelReady?: boolean;
        engine?: BrowserEngine;
      }>;
      const detail = custom.detail || {};
      // Discard events whose engine doesn't match the current selection so a
      // late-resolving check from engine A can't clobber the readiness state set
      // for engine B after a rapid switch (issue #21 F7/F8).
      if (detail.engine !== undefined && detail.engine !== currentEngineRef.current) {
        return;
      }
      const readinessResult = detail.result;
      const hasWebGPU = detail.hasWebGPU ?? getReadinessSnapshot().webgpuAvailable;

      // Keep the shared readiness cache in sync with observed events.
      applyReadinessFromEvent(readinessResult, hasWebGPU);
      readinessGateRef.current = getReadinessGateInstance();

      setServicesReady(prev => ({
        ...prev,
        webgpuAvailable: hasWebGPU,
        modelCached: readinessResult?.checks?.modelCached ?? false,
      }));

      // Prefer the engine-aware "usable now" flag computed by the gate; fall back
      // to modelCached for older/error events that don't carry it.
      if (typeof setModelReady === 'function') {
        setModelReady(detail.modelReady ?? readinessResult?.checks?.modelCached ?? false);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('embedding-service-ready', handleEmbeddingReady as EventListener);
      window.addEventListener('embedding-service-error', handleEmbeddingError as EventListener);
      window.addEventListener('readiness-gate-checked', handleReadinessChecked as EventListener);
    }

    initializeServices();

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('embedding-service-ready', handleEmbeddingReady as EventListener);
        window.removeEventListener('embedding-service-error', handleEmbeddingError as EventListener);
        window.removeEventListener('readiness-gate-checked', handleReadinessChecked as EventListener);
      }

      isMountedRef.current = false;

      // StrictMode-safe destructive cleanup. React 18 StrictMode in dev mounts →
      // unmounts → remounts a component once to surface side-effect bugs. The
      // destructive dispose below must NOT run during that first (immediate)
      // unmount, or it races init on the real mount and can leave the app with
      // torn-down services. Defer it a tick; if the effect re-runs (StrictMode
      // remount) within that window, cancel the dispose. Only a genuine, final
      // unmount proceeds past the timer. (issue #21 F11)
      if (strictModeDisposeTimer !== null) {
        clearTimeout(strictModeDisposeTimer);
        strictModeDisposeTimer = null;
      }
      strictModeDisposeTimer = setTimeout(() => {
        strictModeDisposeTimer = null;
        // Reset the init guard only on a real unmount so a StrictMode remount
        // re-runs initializeServices cleanly.
        initializationStartedRef.current = false;

        // Cleanup: dispose services if they have dispose method (reverse dependency order)
        try {
          const webllmService = WebLLMService.getInstance();
          if (typeof webllmService.dispose === 'function') {
            webllmService.dispose();
          }
        } catch {
          // Service may not be initialized, ignore
        }

        try {
          const embeddingService = getEmbeddingService();
          if (typeof embeddingService.dispose === 'function') {
            embeddingService.dispose();
          }
        } catch {
          // Service may not be initialized, ignore
        }

        try {
          const keywordIndex = getKeywordIndex();
          if (typeof keywordIndex.dispose === 'function') {
            keywordIndex.dispose();
          }
        } catch {
          // Service may not be initialized, ignore
        }

        try {
          const vectorIndex = getVectorIndex();
          if (typeof vectorIndex.dispose === 'function') {
            vectorIndex.dispose();
          }
        } catch {
          // Service may not be initialized, ignore
        }

        if (readinessGateRef.current) {
          readinessGateRef.current = null;
        }
      }, 0);
    };
  }, [initializeServices, setModelReady]);

  return {
    isInitialized,
    initError,
    currentStep,
    servicesReady,
  };
};
