/**
 * WebGPU Watchdog tests
 *
 * Tests context loss detection, one-shot behavior, and recovery handler.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebGPUWatchdog, createRecoveryHandler } from './webgpu-watchdog';
import type { ContextLossInfo } from './webgpu-watchdog';

// ---------------------------------------------------------------------------
// Mock GPUDevice — must be declared before any imports that use WebGPU types
// ---------------------------------------------------------------------------

interface MockGPUDeviceLostInfo {
  message: string;
}

function createMockGPUDevice(overrides: {
  lostPromise?: Promise<MockGPUDeviceLostInfo>;
  alreadyLost?: boolean;
  lostEventHandler?: (event: Event) => void;
} = {}) {
  const {
    lostPromise = Promise.reject(new Error('lost promise never resolved in test')),
    alreadyLost = false,
    lostEventHandler,
  } = overrides;

  return {
    lost: lostPromise,
    addEventListener: vi.fn((event: string, handler: (event: Event) => void) => {
      if (event === 'lost') {
        // Store handler so tests can manually trigger it
        lostEventHandler;
      }
    }),
    removeEventListener: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Mock @mlc-ai/web-llm — required for createRecoveryHandler via WebLLMService
// ---------------------------------------------------------------------------

const mockCreateMLCEngine = vi.fn();

vi.mock('@mlc-ai/web-llm', () => ({
  CreateMLCEngine: mockCreateMLCEngine,
}));

// ---------------------------------------------------------------------------
// Mock navigator.gpu — controlled per-test for checkWebGPU behavior
// ---------------------------------------------------------------------------

const mockGpuAdapter = {
  requestDevice: vi.fn().mockResolvedValue({}),
};
const mockNvgpu = {
  requestAdapter: vi.fn().mockResolvedValue(mockGpuAdapter),
};

Object.defineProperty(global, 'navigator', {
  value: { gpu: mockNvgpu },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Import WebLLMService after mocks
// ---------------------------------------------------------------------------

import { WebLLMService } from './web-llm-service';

// ---------------------------------------------------------------------------
// Helper: create a fully-resolved lost promise
// ---------------------------------------------------------------------------

function createResolvedLostPromise(message: string): Promise<{ message: string }> {
  return Promise.resolve({ message });
}

// ---------------------------------------------------------------------------
// Helper: create a mock engine
// ---------------------------------------------------------------------------

function createMockEngine(overrides = {}) {
  return {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
    interruptGenerate: vi.fn(),
    unload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('WebGPUWatchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNvgpu.requestAdapter.mockReset();
    mockNvgpu.requestAdapter.mockResolvedValue(mockGpuAdapter);

    // Reset singleton
    WebLLMService.getInstance().dispose();
  });

  afterEach(() => {
    // Clean up any pending watchers
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // start() — basic lifecycle
  // -------------------------------------------------------------------------

  test('start() begins monitoring (isMonitoring=true)', () => {
    const device = createMockGPUDevice();
    const watchdog = new WebGPUWatchdog();

    expect(watchdog.isMonitoring()).toBe(false);
    watchdog.start(device, vi.fn());
    expect(watchdog.isMonitoring()).toBe(true);
  });

  test('start() is idempotent when called twice without stop', () => {
    const device = createMockGPUDevice();
    const watchdog = new WebGPUWatchdog();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    watchdog.start(device, vi.fn());
    expect(watchdog.isMonitoring()).toBe(true);

    // Second start should warn and be no-op
    watchdog.start(device, vi.fn());
    expect(consoleSpy).toHaveBeenCalledWith(
      '[WebGPUWatchdog] Already monitoring. Call stop() first.'
    );
  });

  test('start() returns early when device is null', () => {
    const watchdog = new WebGPUWatchdog();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    watchdog.start(null as unknown as GPUDevice, vi.fn());

    expect(watchdog.isMonitoring()).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith('[WebGPUWatchdog] Cannot start: device is null.');
  });

  test('start() with isGenerating callback registers it', () => {
    const device = createMockGPUDevice();
    const watchdog = new WebGPUWatchdog();
    const isGenerating = vi.fn(() => true);

    watchdog.start(device, vi.fn(), isGenerating);
    expect(watchdog.isMonitoring()).toBe(true);
  });

  test('start() without isGenerating callback works (undefined)', () => {
    const device = createMockGPUDevice();
    const watchdog = new WebGPUWatchdog();

    watchdog.start(device, vi.fn());
    expect(watchdog.isMonitoring()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  test('stop() stops monitoring (isMonitoring=false)', () => {
    const device = createMockGPUDevice();
    const watchdog = new WebGPUWatchdog();

    watchdog.start(device, vi.fn());
    expect(watchdog.isMonitoring()).toBe(true);

    watchdog.stop();
    expect(watchdog.isMonitoring()).toBe(false);
  });

  test('stop() is safe when not monitoring', () => {
    const watchdog = new WebGPUWatchdog();
    expect(() => watchdog.stop()).not.toThrow();
  });

  test('stop() removes event listener', () => {
    const device = createMockGPUDevice();
    const watchdog = new WebGPUWatchdog();

    watchdog.start(device, vi.fn());
    watchdog.stop();

    expect(device.removeEventListener).toHaveBeenCalledWith('lost', expect.any(Function));
  });

  test('stop() clears _device and _onContextLost', () => {
    const device = createMockGPUDevice();
    const watchdog = new WebGPUWatchdog();
    const callback = vi.fn();

    watchdog.start(device, callback);
    watchdog.stop();

    // Calling stop again is safe (idempotent)
    watchdog.stop();
    expect(watchdog.isMonitoring()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // getLastContextLoss()
  // -------------------------------------------------------------------------

  test('getLastContextLoss() returns null before any loss', () => {
    const device = createMockGPUDevice();
    const watchdog = new WebGPUWatchdog();

    watchdog.start(device, vi.fn());
    expect(watchdog.getLastContextLoss()).toBeNull();
  });

  test('getLastContextLoss() returns info after loss', async () => {
    const device = createMockGPUDevice({
      lostPromise: createResolvedLostPromise('GPU hung'),
    });
    const watchdog = new WebGPUWatchdog();
    const callback = vi.fn();

    watchdog.start(device, callback);

    // Wait for promise to resolve
    await vi.waitFor(() => {
      // promise resolves
    });

    const lossInfo = watchdog.getLastContextLoss();
    expect(lossInfo).not.toBeNull();
    expect(lossInfo!.reason).toBe('GPU hung');
    expect(lossInfo!.timestamp).toBeGreaterThan(0);
    expect(lossInfo!.wasGenerating).toBe(false);
  });

  test('getLastContextLoss() wasGenerating is true when isGenerating callback returns true', async () => {
    const device = createMockGPUDevice({
      lostPromise: createResolvedLostPromise('context lost during render'),
    });
    const watchdog = new WebGPUWatchdog();
    const isGenerating = vi.fn(() => true);

    watchdog.start(device, vi.fn(), isGenerating);

    await vi.waitFor(() => {
      // resolved
    });

    const lossInfo = watchdog.getLastContextLoss();
    expect(lossInfo!.wasGenerating).toBe(true);
  });

  test('getLastContextLoss() wasGenerating is false when isGenerating callback returns false', async () => {
    const device = createMockGPUDevice({
      lostPromise: createResolvedLostPromise('context lost during render'),
    });
    const watchdog = new WebGPUWatchdog();
    const isGenerating = vi.fn(() => false);

    watchdog.start(device, vi.fn(), isGenerating);

    await vi.waitFor(() => {
      // resolved
    });

    const lossInfo = watchdog.getLastContextLoss();
    expect(lossInfo!.wasGenerating).toBe(false);
  });

  test('getLastContextLoss() wasGenerating defaults to false when no isGenerating callback', async () => {
    const device = createMockGPUDevice({
      lostPromise: createResolvedLostPromise('context lost during render'),
    });
    const watchdog = new WebGPUWatchdog();

    watchdog.start(device, vi.fn());

    await vi.waitFor(() => {
      // resolved
    });

    const lossInfo = watchdog.getLastContextLoss();
    expect(lossInfo!.wasGenerating).toBe(false);
  });

  // -------------------------------------------------------------------------
  // GPUDevice.lost promise triggers callback
  // -------------------------------------------------------------------------

  test('GPUDevice.lost promise resolves → onContextLost called with reason', async () => {
    const device = createMockGPUDevice({
      lostPromise: createResolvedLostPromise('Driver crashed'),
    });
    const watchdog = new WebGPUWatchdog();
    const callback = vi.fn();

    watchdog.start(device, callback);

    await vi.waitFor(() => {
      // Wait until callback was called
      if (!callback.mock.calls.length) throw new Error('Not yet');
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('Driver crashed');
  });

  test('lost promise rejection is handled gracefully', async () => {
    const device = createMockGPUDevice({
      lostPromise: Promise.reject(new Error('Promise rejected unexpectedly')),
    });
    const watchdog = new WebGPUWatchdog();
    const callback = vi.fn();

    watchdog.start(device, callback);

    // Should not throw — error is caught internally
    await vi.waitFor(() => {
      if (!callback.mock.calls.length) throw new Error('Not yet');
    });

    expect(callback).toHaveBeenCalled();
    // Error message is prefixed
    expect(callback.mock.calls[0][0]).toContain('Promise rejected unexpectedly');
  });

  // -------------------------------------------------------------------------
  // One-shot behavior: monitoring stops after first context loss
  // -------------------------------------------------------------------------

  test('One-shot: after context loss, monitoring stops automatically', async () => {
    const device = createMockGPUDevice({
      lostPromise: createResolvedLostPromise('Context lost'),
    });
    const watchdog = new WebGPUWatchdog();

    watchdog.start(device, vi.fn());
    expect(watchdog.isMonitoring()).toBe(true);

    await vi.waitFor(() => {
      if (watchdog.isMonitoring()) throw new Error('Still monitoring');
    });

    expect(watchdog.isMonitoring()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Edge case: start called when device is already lost
  // -------------------------------------------------------------------------

  test('Edge case: start with already-lost device resolves lost promise immediately', async () => {
    // Simulate a device whose lost promise resolves right away
    const device = createMockGPUDevice({
      lostPromise: Promise.resolve({ message: 'Already lost at start' }),
    });
    const watchdog = new WebGPUWatchdog();
    const callback = vi.fn();

    watchdog.start(device, callback);

    // The promise resolves immediately; callback should fire
    await vi.waitFor(() => {
      if (!callback.mock.calls.length) throw new Error('Not yet');
    });

    expect(callback).toHaveBeenCalledWith('Already lost at start');
    expect(watchdog.isMonitoring()).toBe(false); // one-shot stops it
  });

  test('Edge case: double context loss is guarded (only first fires)', async () => {
    let resolveLost: (info: { message: string }) => null = () => null;
    const lostPromise = new Promise<{ message: string }>((resolve) => {
      resolveLost = resolve;
    });

    const device = createMockGPUDevice({ lostPromise });
    const watchdog = new WebGPUWatchdog();
    const callback = vi.fn();

    watchdog.start(device, callback);

    // Resolve once
    resolveLost!({ message: 'First loss' });

    await vi.waitFor(() => {
      if (!callback.mock.calls.length) throw new Error('Not yet');
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(watchdog.isMonitoring()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Callback throwing is caught and logged
  // -------------------------------------------------------------------------

  test('callback throwing does not propagate', async () => {
    const device = createMockGPUDevice({
      lostPromise: createResolvedLostPromise('Lost'),
    });
    const watchdog = new WebGPUWatchdog();
    const callback = vi.fn().mockImplementation(() => {
      throw new Error('Callback error');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    watchdog.start(device, callback);

    await vi.waitFor(() => {
      if (!callback.mock.calls.length) throw new Error('Not yet');
    });

    // Should have caught and logged the error
    expect(consoleSpy).toHaveBeenCalledWith(
      '[WebGPUWatchdog] Callback threw:',
      expect.any(Error)
    );
  });

  // -------------------------------------------------------------------------
  // Async recovery handler is caught properly
  // -------------------------------------------------------------------------

  test('async callback rejection is caught and logged', async () => {
    const device = createMockGPUDevice({
      lostPromise: createResolvedLostPromise('Lost'),
    });
    const watchdog = new WebGPUWatchdog();
    const asyncCallback = vi.fn().mockImplementation(async () => {
      throw new Error('Async callback error');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    watchdog.start(device, asyncCallback);

    await vi.waitFor(() => {
      if (!asyncCallback.mock.calls.length) throw new Error('Not yet');
    });

    // Should have caught and logged the async error
    expect(consoleSpy).toHaveBeenCalledWith(
      '[WebGPUWatchdog] Recovery handler error:',
      expect.any(Error)
    );
  });
});

// ---------------------------------------------------------------------------
// createRecoveryHandler
// Note: Uses the real ModelReadinessGate.checkWebGPU() controlled via
// navigator.gpu.requestAdapter mock.
// ---------------------------------------------------------------------------

describe('createRecoveryHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNvgpu.requestAdapter.mockReset();
    mockNvgpu.requestAdapter.mockResolvedValue(mockGpuAdapter);

    WebLLMService.getInstance().dispose();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('createRecoveryHandler disposes service and checks WebGPU', async () => {
    const service = WebLLMService.getInstance();
    const disposeSpy = vi.spyOn(service, 'dispose');

    const handler = createRecoveryHandler(service);

    await handler('GPU context lost');

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    // checkWebGPU was called via navigator.gpu.requestAdapter
    expect(mockNvgpu.requestAdapter).toHaveBeenCalled();
  });

  test('createRecoveryHandler re-initializes service when WebGPU is available', async () => {
    // WebGPU available (requestAdapter returns non-null adapter)
    mockNvgpu.requestAdapter.mockResolvedValue(mockGpuAdapter);

    // Set up mock engine for re-init
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    vi.spyOn(service, 'dispose');
    const initSpy = vi.spyOn(service, 'initialize').mockResolvedValue(undefined);

    const handler = createRecoveryHandler(service);

    await handler('Context lost');

    expect(initSpy).toHaveBeenCalledWith('SmolLM3-3B-Q4_K_M');
  });

  test('createRecoveryHandler throws if WebGPU unavailable after loss', async () => {
    // WebGPU unavailable (requestAdapter returns null)
    mockNvgpu.requestAdapter.mockResolvedValue(null);

    const service = WebLLMService.getInstance();
    const handler = createRecoveryHandler(service);

    await expect(handler('GPU unavailable')).rejects.toThrow(
      'WebGPU context was lost and is no longer available'
    );
  });

  test('createRecoveryHandler surfaces friendly error for WebGPU unavailability', async () => {
    // WebGPU unavailable (requestAdapter returns null)
    mockNvgpu.requestAdapter.mockResolvedValue(null);

    const service = WebLLMService.getInstance();
    const handler = createRecoveryHandler(service);

    await expect(handler('Tab switched')).rejects.toThrow(
      'Please switch to server API mode'
    );
  });

  test('createRecoveryHandler re-throws re-initialization failure with context', async () => {
    // WebGPU available
    mockNvgpu.requestAdapter.mockResolvedValue(mockGpuAdapter);

    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    vi.spyOn(service, 'initialize').mockRejectedValue(new Error('Model load failed'));

    const handler = createRecoveryHandler(service);

    await expect(handler('Context lost')).rejects.toThrow('WebGPU recovery failed');
    await expect(handler('Context lost')).rejects.toThrow('Model load failed');
  });

  test('createRecoveryHandler preserves modelId from service.getModelInfo()', async () => {
    // WebGPU available
    mockNvgpu.requestAdapter.mockResolvedValue(mockGpuAdapter);

    // Set a known modelId via initialize
    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    await service.initialize('MyCustomModel-Q4');
    vi.spyOn(service, 'initialize').mockResolvedValue(undefined);

    const handler = createRecoveryHandler(service);
    await handler('Context lost');

    // Should have re-initialized with the same model
    expect(service.initialize).toHaveBeenCalledWith('MyCustomModel-Q4');
  });

  test('createRecoveryHandler defaults to SmolLM3-3B-Q4_K_M when modelId is null', async () => {
    // WebGPU available
    mockNvgpu.requestAdapter.mockResolvedValue(mockGpuAdapter);

    const mockEngine = createMockEngine();
    mockCreateMLCEngine.mockResolvedValue(mockEngine);

    const service = WebLLMService.getInstance();
    vi.spyOn(service, 'initialize').mockResolvedValue(undefined);

    const handler = createRecoveryHandler(service);
    await handler('Context lost');

    expect(service.initialize).toHaveBeenCalledWith('SmolLM3-3B-Q4_K_M');
  });

  test('createRecoveryHandler throws when WebGPU requestAdapter throws', async () => {
    // WebGPU throws during requestAdapter
    mockNvgpu.requestAdapter.mockRejectedValue(new Error('GPU error'));

    const service = WebLLMService.getInstance();
    const handler = createRecoveryHandler(service);

    await expect(handler('Context lost')).rejects.toThrow(
      'WebGPU context was lost and is no longer available'
    );
  });
});
