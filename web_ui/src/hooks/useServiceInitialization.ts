import { useState, useEffect, useRef, useCallback } from 'react';
import { getEmbeddingService } from '../lib/embeddings/embedding-service';
import { getVectorIndex } from '../lib/search/vector-index';
import { getKeywordIndex } from '../lib/search/keyword-index';
import { ModelReadinessGate, type ReadinessResult } from '../lib/llm/model-readiness';
import { WebLLMService } from '../lib/llm/web-llm-service';

// Module-level mutable state for lazy initialization support.
// Allows external callers to trigger heavy service init on first use (e.g. first RAG query)
// and allows hook instances to observe readiness changes via events + initial snapshot.
let embeddingServiceReady = false;
let embeddingServiceInitPromise: Promise<boolean> | null = null;
let readinessGateInitPromise: Promise<ReadinessResult | null> | null = null;
let lastReadinessResult: ReadinessResult | null = null;
let webgpuAvailableCached = false;
const readinessGateInstance: { current: ModelReadinessGate | null } = { current: null };

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

/**
 * Ensures the model readiness gate has been checked (WebGPU + cache for LLM).
 * Safe to call multiple times; caches result.
 * Call before first LLM inference that requires browser mode.
 * Dispatches 'readiness-gate-checked' so hooks can update servicesReady + call setModelReady.
 */
export async function ensureReadinessGateChecked(): Promise<ReadinessResult | null> {
  if (lastReadinessResult) {
    return lastReadinessResult;
  }

  if (readinessGateInitPromise) {
    return readinessGateInitPromise;
  }

  readinessGateInitPromise = (async () => {
    try {
      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
      webgpuAvailableCached = hasWebGPU;

      readinessGateInstance.current = new ModelReadinessGate();
      const readinessResult = await readinessGateInstance.current.checkReadiness('SmolLM3-3B-Q4_K_M');

      lastReadinessResult = readinessResult;

      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('readiness-gate-checked', {
            detail: { result: readinessResult, hasWebGPU },
          })
        );
      }

      return readinessResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check model readiness';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('readiness-gate-error', {
            detail: { message },
          })
        );
      }
      // Notify with fallback so listeners can still update webgpu/modelCached=false
      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('readiness-gate-checked', {
            detail: { result: { checks: { modelCached: false } }, hasWebGPU },
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

export const useServiceInitialization: UseServiceInitialization = ({
  setModelReady,
  setModelLoadingProgress,
}) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState('Initializing...');
  const [servicesReady, setServicesReady] = useState({
    embeddings: embeddingServiceReady,
    vectorIndex: false,
    keywordIndex: false,
    modelCached: lastReadinessResult?.checks.modelCached ?? false,
    webgpuAvailable: webgpuAvailableCached,
  });

  const isMountedRef = useRef(true);
  const initializationStartedRef = useRef(false);
  const readinessGateRef = useRef<ModelReadinessGate | null>(null);

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

      readinessGateRef.current = readinessGateInstance.current;

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

    // Sync from module in case ensure*() was invoked by other code prior to this mount
    readinessGateRef.current = readinessGateInstance.current;

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
      const custom = event as CustomEvent<{ result?: ReadinessResult; hasWebGPU?: boolean }>;
      const detail = custom.detail || {};
      const readinessResult = detail.result;
      const hasWebGPU = detail.hasWebGPU ?? webgpuAvailableCached;

      if (readinessResult) {
        lastReadinessResult = readinessResult;
      }
      webgpuAvailableCached = hasWebGPU;
      readinessGateRef.current = readinessGateInstance.current;

      setServicesReady(prev => ({
        ...prev,
        webgpuAvailable: hasWebGPU,
        modelCached: readinessResult?.checks?.modelCached ?? false,
      }));

      if (typeof setModelReady === 'function') {
        setModelReady(readinessResult?.checks?.modelCached ?? false);
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

      if (readinessGateRef.current && typeof readinessGateRef.current.dispose === 'function') {
        readinessGateRef.current.dispose();
        readinessGateRef.current = null;
        readinessGateInstance.current = null;
      }
    };
  }, [initializeServices, setModelReady]);

  return {
    isInitialized,
    initError,
    currentStep,
    servicesReady,
  };
};
