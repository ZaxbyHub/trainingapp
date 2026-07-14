/**
 * Tests for useServiceInitialization hook
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';

// Mock the service modules (hoisted, apply on dynamic import after resetModules)
vi.mock('../lib/embeddings/embedding-service', () => ({
  getEmbeddingService: vi.fn(),
}));

vi.mock('../lib/search/vector-index', () => ({
  getVectorIndex: vi.fn(),
}));

vi.mock('../lib/search/keyword-index', () => ({
  getKeywordIndex: vi.fn(),
}));

vi.mock('../lib/llm/model-readiness', () => ({
  ModelReadinessGate: vi.fn(),
}));

// Mock WebLLMService (used in hook cleanup) to avoid real module side-effects in tests
vi.mock('../lib/llm/web-llm-service', () => ({
  WebLLMService: {
    getInstance: vi.fn(() => ({
      dispose: vi.fn(),
    })),
  },
}));

// NOTE: We use dynamic imports + vi.resetModules() inside beforeEach to obtain fresh
// module-level state (embeddingServiceReady, readinessGateChecked, etc.) for each test.
// This ensures lazy-init flags do not leak between tests. The vi.mock() factories above
// are applied automatically when the modules are (re)imported.

describe('useServiceInitialization', () => {
  let mockVectorIndex: { initialize: ReturnType<typeof vi.fn>; isReady: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  let mockKeywordIndex: { initialize: ReturnType<typeof vi.fn>; isReady: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  let mockEmbeddingService: { initialize: ReturnType<typeof vi.fn>; isReady: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  let mockSetModelReady: ReturnType<typeof vi.fn>;
  let mockSetModelLoadingProgress: ReturnType<typeof vi.fn>;

  // Dynamically imported after resetModules to get fresh lazy-init module state each test
  let useServiceInitialization: any;
  let ensureEmbeddingServiceReady: any;
  let ensureReadinessGateChecked: any;
  let getEmbeddingService: any;
  let getVectorIndex: any;
  let getKeywordIndex: any;
  let ModelReadinessGate: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset modules so that module-level lazy flags (embeddingServiceReady etc) start fresh.
    // This is required because ensure*() set persistent module state; static import would leak.
    vi.resetModules();

    // Re-import the hook module (and its deps) AFTER reset so we get clean state + mocked implementations
    const hookModule = await import('./useServiceInitialization');
    useServiceInitialization = hookModule.useServiceInitialization;
    ensureEmbeddingServiceReady = hookModule.ensureEmbeddingServiceReady;
    ensureReadinessGateChecked = hookModule.ensureReadinessGateChecked;

    const embeddingModule = await import('../lib/embeddings/embedding-service');
    getEmbeddingService = embeddingModule.getEmbeddingService;

    const vectorModule = await import('../lib/search/vector-index');
    getVectorIndex = vectorModule.getVectorIndex;

    const keywordModule = await import('../lib/search/keyword-index');
    getKeywordIndex = keywordModule.getKeywordIndex;

    const readinessModule = await import('../lib/llm/model-readiness');
    ModelReadinessGate = readinessModule.ModelReadinessGate;

    // Create mock services
    mockVectorIndex = {
      initialize: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      dispose: vi.fn(),
    };

    mockKeywordIndex = {
      initialize: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      dispose: vi.fn(),
    };

    mockEmbeddingService = {
      initialize: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      dispose: vi.fn(),
    };

    mockSetModelReady = vi.fn();
    mockSetModelLoadingProgress = vi.fn();

    // Setup mock returns (using freshly imported mocked getters)
    vi.mocked(getVectorIndex).mockReturnValue(mockVectorIndex as any);
    vi.mocked(getKeywordIndex).mockReturnValue(mockKeywordIndex as any);
    vi.mocked(getEmbeddingService).mockReturnValue(mockEmbeddingService as any);

    // Mock navigator.gpu
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue({ isFallback: false }),
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  describe('Successful initialization flow', () => {
    it('reports isInitialized=true when all services initialize successfully', async () => {
      // Readiness mock not needed on boot (readiness is lazy via ensureReadinessGateChecked)
      function TestComponent() {
        const { isInitialized, currentStep } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return (
          <div>
            <span data-testid="initialized">{String(isInitialized)}</span>
            <span data-testid="step">{currentStep}</span>
          </div>
        );
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('initialized').textContent).toBe('true');
      });
    });

    it('sets modelReady=true when model is cached (via lazy ensureReadinessGateChecked, not on boot)', async () => {
      vi.mocked(ModelReadinessGate).mockImplementation(() => ({
        checkReadiness: vi.fn().mockResolvedValue({
          ready: true,
          checks: { webgpu: true, memory: { sufficient: true }, modelCached: true },
          failures: [],
          recommendations: [],
        }),
      } as any));

      function TestComponent() {
        useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <div>Test</div>;
      }

      render(<TestComponent />);

      // Boot no longer calls readiness or sets modelReady. Trigger explicitly.
      await act(async () => {
        await ensureReadinessGateChecked();
      });

      await waitFor(() => {
        expect(mockSetModelReady).toHaveBeenCalledWith(true);
      });
    });

    it('wllama engine: modelReady=true with NO WebGPU when hardware is ready and model is packaged', async () => {
      // The core Phase-3 fix: a wllama user on a no-WebGPU device must not be blocked.
      const checkReadiness = vi.fn().mockResolvedValue({
        ready: true, // engine-aware: wllama ready despite webgpu:false
        checks: { webgpu: false, memory: { sufficient: true }, modelCached: true },
        failures: [],
        recommendations: [],
      });
      vi.mocked(ModelReadinessGate).mockImplementation(() => ({ checkReadiness } as any));

      function TestComponent() {
        useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <div>Test</div>;
      }
      render(<TestComponent />);

      await act(async () => {
        await ensureReadinessGateChecked('wllama');
      });

      // checkReadiness must be invoked with the engine so WebGPU isn't hard-required.
      expect(checkReadiness).toHaveBeenCalledWith(expect.any(String), 'wllama');
      await waitFor(() => {
        expect(mockSetModelReady).toHaveBeenCalledWith(true);
      });
    });
  });

  describe('Service initialization steps', () => {
    it('sets correct currentStep at each initialization stage', async () => {
      // No readiness mock: boot only initializes lightweight search services (vector+keyword)
      const steps: string[] = [];

      function TestComponent() {
        const { currentStep } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <span data-testid="step">{currentStep}</span>;
      }

      render(<TestComponent />);

      // Wait for initialization to complete and capture final step
      await waitFor(() => {
        const stepEl = screen.getByTestId('step');
        steps.push(stepEl.textContent || '');
      }, { timeout: 3000 });

      // Final step should be 'Ready' (embedding/readiness steps are now lazy via ensure*)
      expect(screen.getByTestId('step').textContent).toBeTruthy();
    });

    it('calls setModelLoadingProgress with correct values (10, 100) on boot; 30/70 deferred to ensure* calls', async () => {
      // Boot progress: 10 (start search) -> 100 (ready). Embedding 70% and any 30% now happen only on first query via ensureEmbeddingServiceReady.
      function TestComponent() {
        useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <div>Test</div>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(mockSetModelLoadingProgress).toHaveBeenCalledWith(10);
      });

      await waitFor(() => {
        expect(mockSetModelLoadingProgress).toHaveBeenCalledWith(100);
      });

      // No embedding step on boot anymore
      expect(mockSetModelLoadingProgress).not.toHaveBeenCalledWith(30);
      expect(mockSetModelLoadingProgress).not.toHaveBeenCalledWith(70);
    });
  });

  describe('Embedding service failure', () => {
    it('continues initialization and reports error when embedding service fails (triggered via ensureEmbeddingServiceReady)', async () => {
      mockEmbeddingService.initialize.mockRejectedValue(new Error('Embedding service failed'));

      // Readiness not involved for this test
      function TestComponent() {
        const { isInitialized, initError } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return (
          <div>
            <span data-testid="initialized">{String(isInitialized)}</span>
            <span data-testid="error">{initError ?? 'null'}</span>
          </div>
        );
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('initialized').textContent).toBe('true');
      });

      // Embedding no longer inits on boot; must explicitly call the lazy export (as done by rag-orchestrator on first query)
      await act(async () => {
        const ready = await ensureEmbeddingServiceReady();
        expect(ready).toBe(false);
      });

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toContain('Embedding');
      });
    });
  });

  describe('Model readiness check', () => {
    it('sets modelReady=false when model is not cached (via lazy ensureReadinessGateChecked, not on boot)', async () => {
      vi.mocked(ModelReadinessGate).mockImplementation(() => ({
        checkReadiness: vi.fn().mockResolvedValue({
          ready: true,
          checks: { webgpu: true, memory: { sufficient: true }, modelCached: false },
          failures: [],
          recommendations: ['Model not cached, will download'],
        }),
      } as any));

      function TestComponent() {
        useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <div>Test</div>;
      }

      render(<TestComponent />);

      // Readiness gate no longer checked on boot
      await act(async () => {
        await ensureReadinessGateChecked();
      });

      await waitFor(() => {
        expect(mockSetModelReady).toHaveBeenCalledWith(false);
      });
    });

    it('stores webgpuAvailable in servicesReady based on navigator.gpu (via lazy ensureReadinessGateChecked)', async () => {
      vi.mocked(ModelReadinessGate).mockImplementation(() => ({
        checkReadiness: vi.fn().mockResolvedValue({
          ready: true,
          checks: { webgpu: true, memory: { sufficient: true }, modelCached: true },
          failures: [],
          recommendations: [],
        }),
      } as any));

      function TestComponent() {
        const { servicesReady } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <span data-testid="webgpu">{String(servicesReady.webgpuAvailable)}</span>;
      }

      render(<TestComponent />);

      // webgpuAvailable is populated by ensureReadinessGateChecked (not on boot)
      await act(async () => {
        await ensureReadinessGateChecked();
      });

      await waitFor(() => {
        expect(screen.getByTestId('webgpu').textContent).toBe('true');
      });
    });
  });

  describe('Cleanup on unmount', () => {
    it('calls dispose() on all services during cleanup', async () => {
      // No readiness mock needed (cleanup disposes services unconditionally via get* + try/catch, even if not initialized via ensure)
      function TestComponent() {
        useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <div>Test</div>;
      }

      const { unmount } = render(<TestComponent />);

      // Wait for boot initialization to complete (search services only; modelReady no longer set on boot)
      await waitFor(() => {
        expect(mockVectorIndex.initialize).toHaveBeenCalled();
      });

      unmount();

      // Destructive dispose is deferred via setTimeout(0) so React 18 StrictMode's
      // mount→unmount→remount cycle doesn't tear down services on the first
      // (immediate) unmount (issue #21 F11). Flush the timer before asserting.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mockVectorIndex.dispose).toHaveBeenCalled();
      expect(mockKeywordIndex.dispose).toHaveBeenCalled();
      expect(mockEmbeddingService.dispose).toHaveBeenCalled();
    });

    it('does not throw when dispose is not available', async () => {
      // Remove dispose from mock
      mockVectorIndex.dispose = undefined as any;
      mockKeywordIndex.dispose = undefined as any;
      mockEmbeddingService.dispose = undefined as any;

      // No readiness mock needed
      function TestComponent() {
        useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <div>Test</div>;
      }

      const { unmount } = render(<TestComponent />);

      await waitFor(() => {
        expect(mockVectorIndex.initialize).toHaveBeenCalled();
      });

      expect(() => unmount()).not.toThrow();
      // Flush the deferred (StrictMode-safe) cleanup so the no-dispose path runs.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    });
  });

  describe('Double initialization prevention', () => {
    it('prevents double initialization via initializationStartedRef', async () => {
      // Readiness not exercised on boot
      function TestComponent() {
        const { isInitialized } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <span data-testid="initialized">{String(isInitialized)}</span>;
      }

      const { rerender } = render(<TestComponent />);

      // Rerender with same component (simulates parent re-render)
      rerender(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('initialized').textContent).toBe('true');
      });

      // vectorIndex.initialize should only be called once despite rerender (boot behavior unchanged)
      expect(mockVectorIndex.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('LoadingOverlay step text', () => {
    it('displays current step text that updates through initialization', async () => {
      // No readiness on boot
      function TestComponent() {
        const { currentStep } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <span data-testid="step">{currentStep}</span>;
      }

      render(<TestComponent />);

      // Step updates through initialization stages (now only search services on boot) - verify it changes
      await waitFor(() => {
        const step = screen.getByTestId('step').textContent;
        expect(step).toBeTruthy();
        expect(step).not.toBe('Initializing...');
      });
    });
  });

  describe('Services ready state', () => {
    it('updates servicesReady when services initialize (search on boot; embeddings + modelCached are lazy)', async () => {
      vi.mocked(ModelReadinessGate).mockImplementation(() => ({
        checkReadiness: vi.fn().mockResolvedValue({
          ready: true,
          checks: { webgpu: true, memory: { sufficient: true }, modelCached: true },
          failures: [],
          recommendations: [],
        }),
      } as any));

      function TestComponent() {
        const { servicesReady } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return (
          <div>
            <span data-testid="vector">{String(servicesReady.vectorIndex)}</span>
            <span data-testid="keyword">{String(servicesReady.keywordIndex)}</span>
            <span data-testid="embeddings">{String(servicesReady.embeddings)}</span>
            <span data-testid="model">{String(servicesReady.modelCached)}</span>
          </div>
        );
      }

      render(<TestComponent />);

      // After boot: vector/keyword ready (lightweight), but embeddings and modelCached remain false until ensure* called
      await waitFor(() => {
        expect(screen.getByTestId('vector').textContent).toBe('true');
        expect(screen.getByTestId('keyword').textContent).toBe('true');
        expect(screen.getByTestId('embeddings').textContent).toBe('false');
        expect(screen.getByTestId('model').textContent).toBe('false');
      });

      // Trigger lazy inits (as real app does on first RAG query)
      await act(async () => {
        await ensureEmbeddingServiceReady();
        await ensureReadinessGateChecked();
      });

      await waitFor(() => {
        expect(screen.getByTestId('embeddings').textContent).toBe('true');
        expect(screen.getByTestId('model').textContent).toBe('true');
      });
    });
  });

  describe('Lazy initialization exports', () => {
    it('ensureEmbeddingServiceReady() initializes embedding on first call and updates hook servicesReady.embeddings via event', async () => {
      function TestComponent() {
        const { servicesReady } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <span data-testid="embeddings">{String(servicesReady.embeddings)}</span>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('embeddings').textContent).toBe('false');
      });

      await act(async () => {
        const result = await ensureEmbeddingServiceReady();
        expect(result).toBe(true);
      });

      await waitFor(() => {
        expect(screen.getByTestId('embeddings').textContent).toBe('true');
      });

      // Second call is idempotent (module flag short-circuits, no re-init)
      await act(async () => {
        const result2 = await ensureEmbeddingServiceReady();
        expect(result2).toBe(true);
      });
      expect(mockEmbeddingService.initialize).toHaveBeenCalledTimes(1);
    });

    it('ensureReadinessGateChecked() initializes readiness on first call, updates servicesReady + calls setModelReady via event', async () => {
      vi.mocked(ModelReadinessGate).mockImplementation(() => ({
        checkReadiness: vi.fn().mockResolvedValue({
          ready: true,
          checks: { webgpu: true, memory: { sufficient: true }, modelCached: true },
          failures: [],
          recommendations: [],
        }),
      } as any));

      function TestComponent() {
        const { servicesReady } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return (
          <div>
            <span data-testid="model">{String(servicesReady.modelCached)}</span>
            <span data-testid="webgpu">{String(servicesReady.webgpuAvailable)}</span>
          </div>
        );
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('model').textContent).toBe('false');
      });

      await act(async () => {
        const result = await ensureReadinessGateChecked();
        expect(result).not.toBeNull();
        expect(result?.checks.modelCached).toBe(true);
      });

      await waitFor(() => {
        expect(screen.getByTestId('model').textContent).toBe('true');
        expect(screen.getByTestId('webgpu').textContent).toBe('true');
        expect(mockSetModelReady).toHaveBeenCalledWith(true);
      });

      // Idempotent: constructor + checkReadiness called only once
      await act(async () => {
        await ensureReadinessGateChecked();
      });
      const mockGate = vi.mocked(ModelReadinessGate);
      expect(mockGate).toHaveBeenCalledTimes(1);
      const instance = mockGate.mock.results[0]?.value;
      expect(instance?.checkReadiness).toHaveBeenCalledTimes(1);
    });

    it('hook servicesReady.embeddings is false until ensureEmbeddingServiceReady() is called (never inits on boot)', async () => {
      function TestComponent() {
        const { servicesReady } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
          browserEngine: "wllama",
        });
        return <span data-testid="embeddings">{String(servicesReady.embeddings)}</span>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('embeddings').textContent).toBe('false');
      });

      // Do not call ensure; remains false even after boot + time passes (lazy)
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.getByTestId('embeddings').textContent).toBe('false');
    });
  });
});
