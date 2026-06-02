import { useState, useEffect, useRef, useCallback } from 'react';
import { getEmbeddingService } from '../lib/embeddings/embedding-service';
import { getVectorIndex } from '../lib/search/vector-index';
import { getKeywordIndex } from '../lib/search/keyword-index';
import { ModelReadinessGate } from '../lib/llm/model-readiness';
import { WebLLMService } from '../lib/llm/web-llm-service';

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

export const useServiceInitialization: UseServiceInitialization = ({
  setModelReady,
  setModelLoadingProgress,
}) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState('Initializing...');
  const [servicesReady, setServicesReady] = useState({
    embeddings: false,
    vectorIndex: false,
    keywordIndex: false,
    modelCached: false,
    webgpuAvailable: false,
  });

  const isMountedRef = useRef(true);
  const initializationStartedRef = useRef(false);
  const readinessGateRef = useRef<ModelReadinessGate | null>(null);

  const initializeServices = useCallback(async () => {
    if (initializationStartedRef.current) {
      return;
    }
    initializationStartedRef.current = true;

    // Step 1: Initialize search services (lightweight, fast)
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize search services';
      setInitError(message);
      // Continue with other services even if these fail
    }

    if (isMountedRef.current) {
      setModelLoadingProgress(30);
    }

    // Step 2: Load embedding model (heavy, ~130MB ONNX)
    setCurrentStep('Loading embedding model...');

    try {
      const embeddingService = getEmbeddingService();
      await embeddingService.initialize();
      if (!isMountedRef.current) return;

      setServicesReady(prev => ({
        ...prev,
        embeddings: embeddingService.isReady(),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load embedding model';
      setInitError(prev => prev ? `${prev}; ${message}` : message);
      // Continue with model readiness check even if embedding fails
    }

    if (isMountedRef.current) {
      setModelLoadingProgress(70);
    }

    // Step 3: Check model readiness (WebGPU + model cache)
    setCurrentStep('Checking model readiness...');

    try {
      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;

      setServicesReady(prev => ({
        ...prev,
        webgpuAvailable: hasWebGPU,
      }));

      readinessGateRef.current = new ModelReadinessGate();
      const result = await readinessGateRef.current.checkReadiness('SmolLM3-3B-Q4_K_M');

      if (!isMountedRef.current) return;

      setServicesReady(prev => ({
        ...prev,
        modelCached: result.checks.modelCached,
      }));

      // Model is "ready" if it's already cached (no download needed)
      setModelReady(result.checks.modelCached);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check model readiness';
      setInitError(prev => prev ? `${prev}; ${message}` : message);
      // Don't block app startup for this
    }

    if (isMountedRef.current) {
      setModelLoadingProgress(100);
    }

    if (isMountedRef.current) {
      setIsInitialized(true);
    }
  }, [setModelReady, setModelLoadingProgress]);

  useEffect(() => {
    isMountedRef.current = true;

    initializeServices();

    return () => {
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
      }
    };
  }, [initializeServices]);

  return {
    isInitialized,
    initError,
    currentStep,
    servicesReady,
  };
};
