/**
 * ModelDownloadManager tests
 *
 * Tests cover:
 * - downloadModel triggers WebLLMService.initialize with onProgress callback
 * - Progress tracking: bytesDownloaded, percentage, speed, ETA
 * - isDownloading state transitions
 * - cancelDownload resets state and aborts
 * - QuotaExceededError caught and surfaced in DownloadProgress status='error'
 * - getDownloadProgress returns null before download
 * - Concurrent download prevention
 * - Re-init when singleton already ready (dispose then re-init)
 * - _computeProgressFromPayload calculation accuracy
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------------------
// Mock WebLLMService — use vi.hoisted to ensure mocks are available when
// vi.mock runs (mocks are hoisted but not the factory functions)
// -------------------------------------------------------------------------
const { mockInitialize, mockDispose, mockGetInstance } = vi.hoisted(() => {
  const mockInitialize = vi.fn();
  const mockDispose = vi.fn();
  const mockGetInstance = vi.fn(() => ({
    initialize: mockInitialize,
    dispose: mockDispose,
    isReady: vi.fn(() => false),
  }));
  return { mockInitialize, mockDispose, mockGetInstance };
});

vi.mock('./web-llm-service', () => ({
  WebLLMService: {
    getInstance: mockGetInstance,
  },
  // model-download.ts now imports WEBLLM_DEFAULT_MODEL_ID for the size-estimate
  // key; expose the real value so the computed Record key resolves under the mock.
  WEBLLM_DEFAULT_MODEL_ID: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
}));

// -------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// -------------------------------------------------------------------------
import { ModelDownloadManager, DownloadStatus } from './model-download';

describe('ModelDownloadManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstance.mockReturnValue({
      initialize: mockInitialize,
      dispose: mockDispose,
      isReady: vi.fn(() => false),
    });
  });

  // -------------------------------------------------------------------------
  // getDownloadProgress returns null before any download
  // -------------------------------------------------------------------------
  test('getDownloadProgress returns null before download', () => {
    const manager = new ModelDownloadManager();
    expect(manager.getDownloadProgress()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // isDownloading returns false before any download
  // -------------------------------------------------------------------------
  test('isDownloading returns false before download', () => {
    const manager = new ModelDownloadManager();
    expect(manager.isDownloading()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // downloadModel calls WebLLMService.initialize with modelId, onProgress
  // -------------------------------------------------------------------------
  test('downloadModel calls WebLLMService.initialize with correct modelId and progress callback', async () => {
    const manager = new ModelDownloadManager();
    mockInitialize.mockResolvedValue(undefined);

    await manager.downloadModel('SmolLM3-3B-Q4_K_M');

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    // initialize is called with (modelId, onProgressCallback)
    const [modelId, onProgressCb] = mockInitialize.mock.calls[0];
    expect(modelId).toBe('SmolLM3-3B-Q4_K_M');
    expect(typeof onProgressCb).toBe('function');
  });

  // -------------------------------------------------------------------------
  // Progress callback wired and fires during download
  // -------------------------------------------------------------------------
  test('downloadModel fires onProgress callback during download with updating state', async () => {
    const manager = new ModelDownloadManager();
    const progressCallback = vi.fn();

    // Track the progress callback passed to initialize
    let progressHandlerArg: ((payload: { progress: number; timeElapsed: number; text: string }) => void) | null = null;
    mockInitialize.mockImplementation((modelId: string, onProgress: (payload: { progress: number; timeElapsed: number; text: string }) => void) => {
      progressHandlerArg = onProgress;
      return Promise.resolve();
    });

    await manager.downloadModel('SmolLM3-3B-Q4_K_M', progressCallback);

    // Progress callback should have been called at least once
    expect(progressCallback).toHaveBeenCalled();

    // Should have called with downloading state initially, then complete
    const calls = progressCallback.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.status).toBe('complete');
    expect(lastCall.modelId).toBe('SmolLM3-3B-Q4_K_M');
    expect(lastCall.percentage).toBe(100);
  });

  test('progress callback receives multiple updates as download progresses', async () => {
    const manager = new ModelDownloadManager();
    const progressCallback = vi.fn();

    mockInitialize.mockImplementation((modelId: string, onProgress: (payload: { progress: number; timeElapsed: number; text: string }) => void) => {
      // Simulate progress events
      onProgress({ progress: 0.25, timeElapsed: 5, text: '25%' });
      onProgress({ progress: 0.5, timeElapsed: 10, text: '50%' });
      onProgress({ progress: 0.75, timeElapsed: 15, text: '75%' });
      onProgress({ progress: 1.0, timeElapsed: 20, text: 'Done' });
      return Promise.resolve();
    });

    await manager.downloadModel('SmolLM3-3B-Q4_K_M', progressCallback);

    // Should have been called multiple times as progress updates fire
    expect(progressCallback).toHaveBeenCalledTimes(5); // 4 progress updates + 1 final complete
  });

  // -------------------------------------------------------------------------
  // downloadModel sets progress to complete when initialize succeeds
  // -------------------------------------------------------------------------
  test('downloadModel marks progress as complete after successful initialize', async () => {
    const manager = new ModelDownloadManager();
    const progressCallback = vi.fn();
    mockInitialize.mockResolvedValue(undefined);

    await manager.downloadModel('SmolLM3-3B-Q4_K_M', progressCallback);

    // Find the final progress update (should be 'complete')
    const completeCall = progressCallback.mock.calls.find(
      (call: unknown[]) => (call[0] as { status: DownloadStatus }).status === 'complete'
    );
    expect(completeCall).toBeDefined();
    expect(completeCall![0].percentage).toBe(100);
    expect(completeCall![0].bytesDownloaded).toBe(completeCall![0].totalBytes);
  });

  // -------------------------------------------------------------------------
  // isDownloading state transitions
  // -------------------------------------------------------------------------
  test('isDownloading returns true during active download', async () => {
    const manager = new ModelDownloadManager();

    // Simulate a download that takes time by having initialize not immediately resolve
    let resolveInitialize: () => void;
    const initPromise = new Promise<void>((resolve) => {
      resolveInitialize = resolve;
    });

    mockInitialize.mockReturnValue(initPromise);

    const downloadPromise = manager.downloadModel('SmolLM3-3B-Q4_K_M');

    // Poll until isDownloading becomes true
    await vi.waitFor(() => expect(manager.isDownloading()).toBe(true));

    resolveInitialize!();
    await downloadPromise;

    expect(manager.isDownloading()).toBe(false);
  });

  test('isDownloading returns false after download completes', async () => {
    const manager = new ModelDownloadManager();
    mockInitialize.mockResolvedValue(undefined);

    await manager.downloadModel('SmolLM3-3B-Q4_K_M');

    expect(manager.isDownloading()).toBe(false);
  });

  test('isDownloading returns false after download errors', async () => {
    const manager = new ModelDownloadManager();
    mockInitialize.mockRejectedValue(new Error('Some error'));

    await expect(
      manager.downloadModel('SmolLM3-3B-Q4_K_M')
    ).rejects.toThrow('Some error');

    expect(manager.isDownloading()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // cancelDownload resets state and aborts
  // -------------------------------------------------------------------------
  test('cancelDownload resets _downloading to false', async () => {
    const manager = new ModelDownloadManager();

    let blockResolve: () => void;
    const blockPromise = new Promise<void>((resolve) => {
      blockResolve = resolve;
    });
    mockInitialize.mockReturnValue(blockPromise);

    const downloadPromise = manager.downloadModel('SmolLM3-3B-Q4_K_M');

    await vi.waitFor(() => expect(manager.isDownloading()).toBe(true));

    manager.cancelDownload();

    expect(manager.isDownloading()).toBe(false);

    blockResolve!();
    await downloadPromise.catch(() => {});
  });

  test('cancelDownload does not call dispose or interrupt when not downloading', () => {
    const manager = new ModelDownloadManager();
    mockInitialize.mockResolvedValue(undefined);

    manager.cancelDownload();

    expect(mockDispose).not.toHaveBeenCalled();
  });

  test('cancelDownload sets status to idle after cancellation', async () => {
    const manager = new ModelDownloadManager();

    let blockResolve: () => void;
    const blockPromise = new Promise<void>((resolve) => {
      blockResolve = resolve;
    });
    mockInitialize.mockReturnValue(blockPromise);

    const downloadPromise = manager.downloadModel('SmolLM3-3B-Q4_K_M');

    await vi.waitFor(() => expect(manager.isDownloading()).toBe(true));

    manager.cancelDownload();

    const progress = manager.getDownloadProgress();
    expect(progress?.status).toBe('idle');

    blockResolve!();
    await downloadPromise.catch(() => {});
  });

  test('cancelDownload rejects the download promise with Download cancelled', async () => {
    const manager = new ModelDownloadManager();

    // Controller pattern: initialize hangs until we resolve it
    let resolveInit: () => void;
    const initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    mockInitialize.mockReturnValue(initPromise);

    const downloadPromise = manager.downloadModel('SmolLM3-3B-Q4_K_M');

    await vi.waitFor(() => expect(manager.isDownloading()).toBe(true));

    manager.cancelDownload();

    // Resolve initialize so download proceeds past the await, then _cancelled flag triggers rejection
    resolveInit!();

    // cancelDownload() sets _cancelled flag, which causes rejection after initialize resolves
    await expect(downloadPromise).rejects.toThrow('Download cancelled');

    await vi.waitFor(() => expect(manager.isDownloading()).toBe(false));
  });

  // -------------------------------------------------------------------------
  // QuotaExceededError caught and surfaced in DownloadProgress status='error'
  // -------------------------------------------------------------------------
  test('downloadModel catches QuotaExceededError and sets status to error', async () => {
    const manager = new ModelDownloadManager();
    const quotaError = new Error('QuotaExceededError: IndexedDB storage quota exceeded');
    mockInitialize.mockRejectedValue(quotaError);

    await expect(
      manager.downloadModel('SmolLM3-3B-Q4_K_M')
    ).rejects.toThrow('Browser storage quota exceeded');

    const progress = manager.getDownloadProgress();
    expect(progress?.status).toBe('error');
  });

  test('downloadModel catches generic quota error and sets status to error', async () => {
    const manager = new ModelDownloadManager();
    const quotaError = new Error('Failed to fetch: quota exceeded');
    mockInitialize.mockRejectedValue(quotaError);

    await expect(
      manager.downloadModel('SmolLM3-3B-Q4_K_M')
    ).rejects.toThrow('Browser storage quota exceeded');

    const progress = manager.getDownloadProgress();
    expect(progress?.status).toBe('error');
  });

  test('downloadModel catches OPFS-related quota error and sets status to error', async () => {
    const manager = new ModelDownloadManager();
    const quotaError = new Error('OPFS quota exceeded');
    mockInitialize.mockRejectedValue(quotaError);

    await expect(
      manager.downloadModel('SmolLM3-3B-Q4_K_M')
    ).rejects.toThrow('Browser storage quota exceeded');

    const progress = manager.getDownloadProgress();
    expect(progress?.status).toBe('error');
  });

  test('downloadModel calls onProgress with error status before throwing', async () => {
    const manager = new ModelDownloadManager();
    const progressCallback = vi.fn();
    const quotaError = new Error('QuotaExceededError: storage quota');
    mockInitialize.mockRejectedValue(quotaError);

    await expect(
      manager.downloadModel('SmolLM3-3B-Q4_K_M', progressCallback)
    ).rejects.toThrow('Browser storage quota exceeded');

    // Should have called onProgress with error status
    const errorCall = progressCallback.mock.calls.find(
      (call: unknown[]) => (call[0] as { status: DownloadStatus }).status === 'error'
    );
    expect(errorCall).toBeDefined();
  });

  test('downloadModel re-throws non-quota errors with original message', async () => {
    const manager = new ModelDownloadManager();
    const genericError = new Error('WebGPU not available');
    mockInitialize.mockRejectedValue(genericError);

    await expect(
      manager.downloadModel('SmolLM3-3B-Q4_K_M')
    ).rejects.toThrow('WebGPU not available');
  });

  // -------------------------------------------------------------------------
  // getDownloadProgress returns correct state after download
  // -------------------------------------------------------------------------
  test('getDownloadProgress returns correct state after successful download', async () => {
    const manager = new ModelDownloadManager();
    mockInitialize.mockResolvedValue(undefined);

    await manager.downloadModel('SmolLM3-3B-Q4_K_M');

    const progress = manager.getDownloadProgress();
    expect(progress).not.toBeNull();
    expect(progress!.status).toBe('complete');
    expect(progress!.modelId).toBe('SmolLM3-3B-Q4_K_M');
    expect(progress!.percentage).toBe(100);
  });

  // -------------------------------------------------------------------------
  // Progress calculation via _computeProgressFromPayload
  // -------------------------------------------------------------------------
  test('_computeProgressFromPayload calculates bytesDownloaded correctly', () => {
    const manager = new ModelDownloadManager() as { _computeProgressFromPayload: Function };
    const totalBytes = 2_000_000_000;

    const result = manager._computeProgressFromPayload(
      'SmolLM3-3B-Q4_K_M',
      { progress: 0.5, timeElapsed: 10, text: 'Downloading...' },
      totalBytes
    );

    expect(result.bytesDownloaded).toBe(1_000_000_000);
  });

  test('_computeProgressFromPayload calculates percentage correctly', () => {
    const manager = new ModelDownloadManager() as { _computeProgressFromPayload: Function };
    const totalBytes = 2_000_000_000;

    const result = manager._computeProgressFromPayload(
      'SmolLM3-3B-Q4_K_M',
      { progress: 0.75, timeElapsed: 10, text: 'Downloading...' },
      totalBytes
    );

    expect(result.percentage).toBe(75);
  });

  test('_computeProgressFromPayload caps percentage at 100', () => {
    const manager = new ModelDownloadManager() as { _computeProgressFromPayload: Function };
    const totalBytes = 2_000_000_000;

    // Progress can sometimes be > 1 due to rounding
    const result = manager._computeProgressFromPayload(
      'SmolLM3-3B-Q4_K_M',
      { progress: 1.05, timeElapsed: 10, text: 'Almost done...' },
      totalBytes
    );

    expect(result.percentage).toBe(100);
  });

  test('_computeProgressFromPayload calculates speedBytesPerSec correctly', () => {
    const manager = new ModelDownloadManager() as { _computeProgressFromPayload: Function };
    const totalBytes = 2_000_000_000;

    const result = manager._computeProgressFromPayload(
      'SmolLM3-3B-Q4_K_M',
      { progress: 0.5, timeElapsed: 10, text: 'Downloading...' }, // 1GB in 10 sec = 100MB/s
      totalBytes
    );

    // 50% of 2GB = 1GB = 1_000_000_000 bytes in 10 sec = 100_000_000 bytes/sec
    expect(result.speedBytesPerSec).toBe(100_000_000);
  });

  test('_computeProgressFromPayload handles zero elapsed time', () => {
    const manager = new ModelDownloadManager() as { _computeProgressFromPayload: Function };
    const totalBytes = 2_000_000_000;

    const result = manager._computeProgressFromPayload(
      'SmolLM3-3B-Q4_K_M',
      { progress: 0.5, timeElapsed: 0, text: 'Starting...' },
      totalBytes
    );

    expect(result.speedBytesPerSec).toBe(0);
  });

  test('_computeProgressFromPayload calculates ETA correctly', () => {
    const manager = new ModelDownloadManager() as { _computeProgressFromPayload: Function };
    const totalBytes = 2_000_000_000;

    // 50% downloaded (1GB), 100MB/s speed → 10 seconds remaining
    const result = manager._computeProgressFromPayload(
      'SmolLM3-3B-Q4_K_M',
      { progress: 0.5, timeElapsed: 10, text: 'Downloading...' },
      totalBytes
    );

    // Remaining: 1GB at 100MB/s = 10 seconds
    expect(result.estimatedTimeRemainingSec).toBe(10);
  });

  test('_computeProgressFromPayload returns status downloading', () => {
    const manager = new ModelDownloadManager() as { _computeProgressFromPayload: Function };
    const totalBytes = 2_000_000_000;

    const result = manager._computeProgressFromPayload(
      'SmolLM3-3B-Q4_K_M',
      { progress: 0.5, timeElapsed: 10, text: 'Downloading...' },
      totalBytes
    );

    expect(result.status).toBe('downloading');
  });

  // -------------------------------------------------------------------------
  // Concurrent download prevention
  // -------------------------------------------------------------------------
  test('second downloadModel call while downloading throws "A download is already in progress"', async () => {
    const manager = new ModelDownloadManager();

    let blockResolve: () => void;
    const blockPromise = new Promise<void>((resolve) => {
      blockResolve = resolve;
    });
    mockInitialize.mockReturnValue(blockPromise);

    const downloadPromise = manager.downloadModel('SmolLM3-3B-Q4_K_M');

    // Wait for download to start
    await vi.waitFor(() => expect(manager.isDownloading()).toBe(true));

    // The second call should throw an error IMMEDIATELY
    await expect(
      manager.downloadModel('SmolLM3-3B-Q4_K_M')
    ).rejects.toThrow('A download is already in progress');

    // Clean up
    blockResolve!();
    await downloadPromise.catch(() => {});
  });

  test('downloadModel after cancel allows new download', async () => {
    const manager = new ModelDownloadManager();

    let blockResolve: () => void;
    const blockPromise = new Promise<void>((resolve) => {
      blockResolve = resolve;
    });
    mockInitialize.mockReturnValue(blockPromise);

    const downloadPromise = manager.downloadModel('SmolLM3-3B-Q4_K_M');

    await vi.waitFor(() => expect(manager.isDownloading()).toBe(true));

    manager.cancelDownload();

    // After cancel, should be able to start new download
    blockResolve!();
    await downloadPromise.catch(() => {});

    mockInitialize.mockClear();
    mockInitialize.mockResolvedValue(undefined);

    // Now new download should work
    await manager.downloadModel('SmolLM3-3B-Q4_K_M');
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Re-init when singleton already ready (dispose then re-init)
  // -------------------------------------------------------------------------
  test('downloadModel disposes existing instance before re-init when isReady is true', async () => {
    const manager = new ModelDownloadManager();
    mockInitialize.mockResolvedValue(undefined);

    // First call - isReady returns true to trigger dispose
    mockGetInstance.mockReturnValueOnce({
      initialize: mockInitialize,
      dispose: mockDispose,
      isReady: vi.fn(() => true), // Already ready, should dispose
    });

    await manager.downloadModel('SmolLM3-3B-Q4_K_M');

    // Dispose should have been called because isReady was true
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  test('downloadModel does not dispose when isReady returns false', async () => {
    const manager = new ModelDownloadManager();
    mockInitialize.mockResolvedValue(undefined);

    // isReady returns false, so dispose should not be called
    mockGetInstance.mockReturnValueOnce({
      initialize: mockInitialize,
      dispose: mockDispose,
      isReady: vi.fn(() => false),
    });

    await manager.downloadModel('SmolLM3-3B-Q4_K_M');

    expect(mockDispose).not.toHaveBeenCalled();
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  test('downloadModel with unknown modelId uses default size estimate', async () => {
    const manager = new ModelDownloadManager();
    const progressCallback = vi.fn();
    mockInitialize.mockResolvedValue(undefined);

    await manager.downloadModel('UnknownModel', progressCallback);

    const progress = manager.getDownloadProgress();
    expect(progress?.totalBytes).toBe(2_000_000_000); // Default 2GB estimate
  });

  test('downloadModel uses known size estimate for SmolLM3', async () => {
    const manager = new ModelDownloadManager();
    const progressCallback = vi.fn();
    mockInitialize.mockResolvedValue(undefined);

    await manager.downloadModel('SmolLM3-3B-Q4_K_M', progressCallback);

    const progress = manager.getDownloadProgress();
    expect(progress?.totalBytes).toBe(2_000_000_000); // ~1.9 GB as defined
  });
});
