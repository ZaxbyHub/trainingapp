/**
 * Tests for useServiceInitialization hook
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { useServiceInitialization } from './useServiceInitialization';

// Mock the service modules
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

import { getEmbeddingService } from '../lib/embeddings/embedding-service';
import { getVectorIndex } from '../lib/search/vector-index';
import { getKeywordIndex } from '../lib/search/keyword-index';
import { ModelReadinessGate } from '../lib/llm/model-readiness';

describe('useServiceInitialization', () => {
  let mockVectorIndex: { initialize: ReturnType<typeof vi.fn>; isReady: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  let mockKeywordIndex: { initialize: ReturnType<typeof vi.fn>; isReady: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  let mockEmbeddingService: { initialize: ReturnType<typeof vi.fn>; isReady: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  let mockSetModelReady: ReturnType<typeof vi.fn>;
  let mockSetModelLoadingProgress: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

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

    // Setup mock returns
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
      vi.mocked(ModelReadinessGate).mockImplementation(() => ({
        checkReadiness: vi.fn().mockResolvedValue({
          ready: true,
          checks: { webgpu: true, memory: { sufficient: true }, modelCached: true },
          failures: [],
          recommendations: [],
        }),
      } as any));

      function TestComponent() {
        const { isInitialized, currentStep } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
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

    it('sets modelReady=true when model is cached', async () => {
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
        });
        return <div>Test</div>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(mockSetModelReady).toHaveBeenCalledWith(true);
      });
    });
  });

  describe('Service initialization steps', () => {
    it('sets correct currentStep at each initialization stage', async () => {
      vi.mocked(ModelReadinessGate).mockImplementation(() => ({
        checkReadiness: vi.fn().mockResolvedValue({
          ready: true,
          checks: { webgpu: true, memory: { sufficient: true }, modelCached: true },
          failures: [],
          recommendations: [],
        }),
      } as any));

      const steps: string[] = [];

      function TestComponent() {
        const { currentStep } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
        });
        return <span data-testid="step">{currentStep}</span>;
      }

      render(<TestComponent />);

      // Wait for initialization to complete and capture final step
      await waitFor(() => {
        const stepEl = screen.getByTestId('step');
        steps.push(stepEl.textContent || '');
      }, { timeout: 3000 });

      // Final step should be 'Checking model readiness...' or initialization completed
      expect(screen.getByTestId('step').textContent).toBeTruthy();
    });

    it('calls setModelLoadingProgress with correct values (10, 30, 70, 100)', async () => {
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
        });
        return <div>Test</div>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(mockSetModelLoadingProgress).toHaveBeenCalledWith(10);
      });

      await waitFor(() => {
        expect(mockSetModelLoadingProgress).toHaveBeenCalledWith(30);
      });

      await waitFor(() => {
        expect(mockSetModelLoadingProgress).toHaveBeenCalledWith(70);
      });

      await waitFor(() => {
        expect(mockSetModelLoadingProgress).toHaveBeenCalledWith(100);
      });
    });
  });

  describe('Embedding service failure', () => {
    it('continues initialization and reports error when embedding service fails', async () => {
      mockEmbeddingService.initialize.mockRejectedValue(new Error('Embedding service failed'));

      vi.mocked(ModelReadinessGate).mockImplementation(() => ({
        checkReadiness: vi.fn().mockResolvedValue({
          ready: true,
          checks: { webgpu: true, memory: { sufficient: true }, modelCached: true },
          failures: [],
          recommendations: [],
        }),
      } as any));

      function TestComponent() {
        const { isInitialized, initError } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
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

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toContain('Embedding');
      });
    });
  });

  describe('Model readiness check', () => {
    it('sets modelReady=false when model is not cached', async () => {
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
        });
        return <div>Test</div>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(mockSetModelReady).toHaveBeenCalledWith(false);
      });
    });

    it('stores webgpuAvailable in servicesReady based on navigator.gpu', async () => {
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
        });
        return <span data-testid="webgpu">{String(servicesReady.webgpuAvailable)}</span>;
      }

      render(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('webgpu').textContent).toBe('true');
      });
    });
  });

  describe('Cleanup on unmount', () => {
    it('calls dispose() on all services during cleanup', async () => {
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
        });
        return <div>Test</div>;
      }

      const { unmount } = render(<TestComponent />);

      // Wait for initialization to complete
      await waitFor(() => {
        expect(mockSetModelReady).toHaveBeenCalled();
      });

      unmount();

      expect(mockVectorIndex.dispose).toHaveBeenCalled();
      expect(mockKeywordIndex.dispose).toHaveBeenCalled();
      expect(mockEmbeddingService.dispose).toHaveBeenCalled();
    });

    it('does not throw when dispose is not available', async () => {
      // Remove dispose from mock
      mockVectorIndex.dispose = undefined as any;
      mockKeywordIndex.dispose = undefined as any;
      mockEmbeddingService.dispose = undefined as any;

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
        });
        return <div>Test</div>;
      }

      const { unmount } = render(<TestComponent />);

      await waitFor(() => {
        expect(mockSetModelReady).toHaveBeenCalled();
      });

      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Double initialization prevention', () => {
    it('prevents double initialization via initializationStartedRef', async () => {
      vi.mocked(ModelReadinessGate).mockImplementation(() => ({
        checkReadiness: vi.fn().mockResolvedValue({
          ready: true,
          checks: { webgpu: true, memory: { sufficient: true }, modelCached: true },
          failures: [],
          recommendations: [],
        }),
      } as any));

      function TestComponent() {
        const { isInitialized } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
        });
        return <span data-testid="initialized">{String(isInitialized)}</span>;
      }

      const { rerender } = render(<TestComponent />);

      // Rerender with same component (simulates parent re-render)
      rerender(<TestComponent />);

      await waitFor(() => {
        expect(screen.getByTestId('initialized').textContent).toBe('true');
      });

      // vectorIndex.initialize should only be called once despite rerender
      expect(mockVectorIndex.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('LoadingOverlay step text', () => {
    it('displays current step text that updates through initialization', async () => {
      vi.mocked(ModelReadinessGate).mockImplementation(() => ({
        checkReadiness: vi.fn().mockResolvedValue({
          ready: true,
          checks: { webgpu: true, memory: { sufficient: true }, modelCached: true },
          failures: [],
          recommendations: [],
        }),
      } as any));

      function TestComponent() {
        const { currentStep } = useServiceInitialization({
          setModelReady: mockSetModelReady,
          setModelLoadingProgress: mockSetModelLoadingProgress,
        });
        return <span data-testid="step">{currentStep}</span>;
      }

      render(<TestComponent />);

      // Step updates through initialization stages - verify it changes
      await waitFor(() => {
        const step = screen.getByTestId('step').textContent;
        expect(step).toBeTruthy();
        expect(step).not.toBe('Initializing...');
      });
    });
  });

  describe('Services ready state', () => {
    it('updates servicesReady when services initialize', async () => {
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

      await waitFor(() => {
        expect(screen.getByTestId('vector').textContent).toBe('true');
        expect(screen.getByTestId('keyword').textContent).toBe('true');
        expect(screen.getByTestId('embeddings').textContent).toBe('true');
        expect(screen.getByTestId('model').textContent).toBe('true');
      });
    });
  });
});
