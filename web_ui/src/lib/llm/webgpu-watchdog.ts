/**
 * WebGPU Context Loss Detection and Recovery Watchdog.
 *
 * FR-015: Graceful degradation when hardware unavailable.
 *
 * WebGPU contexts can be lost when:
 *   - User switches browser tabs
 *   - GPU overheats
 *   - Driver crashes
 *   - System runs out of GPU memory
 *
 * When the context is lost, the MLCEngine becomes invalid and must be
 * re-initialized. This watchdog monitors the GPUDevice for context loss
 * and fires a callback so the service layer can recover.
 *
 * The watchdog itself does NOT re-initialize — it only detects and notifies.
 * Recovery is handled by the callback (typically createRecoveryHandler).
 */

import { WebLLMService } from './web-llm-service';
import { ModelReadinessGate } from './model-readiness';

/**
 * Information about a detected context loss event.
 */
export interface ContextLossInfo {
  /** Human-readable reason for the context loss. */
  reason: string;
  /** Unix timestamp (ms) when the loss was detected. */
  timestamp: number;
  /** True if generation was in progress when context was lost. */
  wasGenerating: boolean;
}

/**
 * WebGPUWatchdog — monitors a GPUDevice for context loss events.
 *
 * Implements one-shot detection: after a context loss is detected,
 * monitoring stops automatically. The caller must create a new watchdog
 * instance if re-monitoring is needed after recovery.
 *
 * Usage:
 *   const watchdog = new WebGPUWatchdog();
 *   watchdog.start(device, (reason) => {
 *     console.error('WebGPU context lost:', reason);
 *     // Trigger recovery
 *   });
 *
 *   // Later, when done (React useEffect cleanup example):
 *   watchdog.dispose();
 *
 * Always pair start() with dispose() in a useEffect cleanup function.
 */
export class WebGPUWatchdog {
  private _device: GPUDevice | null = null;
  private _onContextLost: ((reason: string) => void) | null = null;
  private _isGeneratingCallback: (() => boolean) | null = null;
  private _monitoring = false;
  private _lastLoss: ContextLossInfo | null = null;
  private _lostEventHandler: ((event: Event) => void) | null = null;

  /**
   * Starts monitoring the given GPUDevice for context loss.
   *
   * @param device   The GPUDevice to monitor. Must be a valid, alive device.
   * @param onContextLost  Callback invoked when context loss is detected.
   *                      Receives the reason string as argument.
   * @param isGenerating  Optional callback that returns true if generation is in progress.
   */
  start(device: GPUDevice, onContextLost: (reason: string) => void, isGenerating?: () => boolean): void {
    if (this._monitoring) {
      console.warn('[WebGPUWatchdog] Already monitoring. Call stop() first.');
      return;
    }

    if (!device) {
      console.error('[WebGPUWatchdog] Cannot start: device is null.');
      return;
    }

    this._device = device;
    this._onContextLost = onContextLost;
    this._isGeneratingCallback = isGenerating ?? null;
    this._monitoring = true;

    // Primary detection: GPUDevice.lost promise (标准的 WebGPU 上下文丢失检测)
    this._device.lost.then(
      (info: GPUDeviceLostInfo) => {
        const reason = info.message || 'Unknown context loss reason';
        this._handleContextLoss(reason);
      },
      (err: unknown) => {
        // The promise should never reject, but defensive handling:
        const reason = err instanceof Error ? err.message : String(err);
        this._handleContextLoss(`Lost promise rejected: ${reason}`);
      }
    );

    // Secondary detection: device.lost event (某些浏览器会触发此事件)
    // Some browsers fire 'lost' on the device object itself in addition to
    // resolving the .lost promise. We listen once and immediately detach to
    // avoid duplicate callbacks.
    this._lostEventHandler = (event: Event) => {
      // TypeScript doesn't have perfect typing for this event; treat it generically.
      const reason = `device.lost event: ${(event as GPUDeviceLostInfo).message ?? 'unknown'}`;
      this._handleContextLoss(reason);
    };
    this._device.addEventListener('lost', this._lostEventHandler);

    console.info('[WebGPUWatchdog] Started monitoring for context loss');
  }

  /**
   * Stops monitoring and removes all listeners.
   *
   * After stop(), the watchdog is inert. Create a new instance to monitor
   * a freshly created device.
   *
   * Note: prefer dispose() for new code — it's an alias with documentation emphasizing the resource-management contract.
   */
  stop(): void {
    if (!this._monitoring) {
      return;
    }

    this._device?.removeEventListener('lost', this._lostEventHandler);
    this._monitoring = false;
    this._device = null;
    this._onContextLost = null;
    this._isGeneratingCallback = null;
    this._lostEventHandler = null;

    console.info('[WebGPUWatchdog] Stopped monitoring');
  }

  /**
   * Releases all watchdog resources. Equivalent to stop(), but use this
   * name when wiring into React useEffect cleanup, IDisposable patterns,
   * or any other resource-management idiom.
   *
   * After dispose(), the watchdog is inert. The GPUDevice listener is
   * removed, the lost-promise closure is released, and all internal
   * references are nulled.
   *
   * IMPORTANT: Callers MUST invoke dispose() when finished with the
   * watchdog (e.g., in a useEffect cleanup function). Failure to do so
   * will leak the GPU device's 'lost' event listener.
   */
  dispose(): void {
    this.stop();
  }

  /**
   * @returns True if start() has been called and stop() has not been called yet.
   */
  isMonitoring(): boolean {
    return this._monitoring;
  }

  /**
   * @returns The last context loss record, or null if no loss has been detected.
   */
  getLastContextLoss(): ContextLossInfo | null {
    return this._lastLoss;
  }

  /**
   * Internal handler called when context loss is detected.
   * Records the loss info, notifies the callback, and stops monitoring.
   */
  private _handleContextLoss(reason: string): void {
    // Guard against double-firing (both promise and event may trigger)
    if (!this._monitoring) {
      return;
    }

    const wasGenerating = this._isGeneratingCallback?.() ?? false;

    this._lastLoss = {
      reason,
      timestamp: Date.now(),
      wasGenerating,
    };

    console.error(`[WebGPUWatchdog] Context lost: ${reason}`);

    // Notify the callback so recovery can be initiated
    // Handle both sync and async callbacks
    try {
      const result = this._onContextLost?.(reason);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error('[WebGPUWatchdog] Recovery handler error:', err);
        });
      }
    } catch (err) {
      console.error('[WebGPUWatchdog] Callback threw:', err);
    }

    // One-shot: stop monitoring after first loss
    this.stop();
  }
}

/**
 * Creates a recovery handler bound to a specific WebLLMService instance.
 *
 * The handler:
 *   1. Disposes the current WebLLMService instance.
 *   2. Re-checks WebGPU availability via ModelReadinessGate.
 *   3. If WebGPU available: re-initializes with the same model.
 *   4. If WebGPU unavailable: surfaces an error guiding the user to
 *      switch to server API mode (per FR-015).
 *
 * @param service  The WebLLMService instance to recover.
 * @returns A callback suitable for passing to WebGPUWatchdog.start().
 *
 * Usage:
 *   const watchdog = new WebGPUWatchdog();
 *   const handler = createRecoveryHandler(WebLLMService.getInstance());
 *   watchdog.start(device, handler);
 */
export function createRecoveryHandler(service: WebLLMService): (reason: string) => void {
  return async (reason: string): Promise<void> => {
    console.error('[WebGPUWatchdog] Recovery triggered. Context loss reason:', reason);

    // Step 1: Dispose the invalidated service
    const modelId = service.getModelInfo()?.modelId ?? 'SmolLM3-3B-Q4_K_M';
    console.info(`[WebGPUWatchdog] Disposing service (model: ${modelId})`);
    service.dispose();

    // Step 2: Re-check WebGPU availability
    const gate = new ModelReadinessGate();
    const webgpuAvailable = await gate.checkWebGPU();

    if (!webgpuAvailable) {
      console.error(
        '[WebGPUWatchdog] WebGPU unavailable after context loss. ' +
        'User must switch to server API mode (FR-015).'
      );
      // Surface a user-facing error. In a real app this would be shown via toast/alert.
      throw new Error(
        'WebGPU context was lost and is no longer available. ' +
        'Please switch to server API mode for LLM inference.'
      );
    }

    // Step 3: Re-initialize with the same model
    console.info(`[WebGPUWatchdog] WebGPU available. Re-initializing model: ${modelId}`);
    try {
      await service.initialize(modelId);
      console.info('[WebGPUWatchdog] Recovery complete. Service re-initialized.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[WebGPUWatchdog] Re-initialization failed:', msg);
      throw new Error(
        `WebGPU recovery failed: ${msg}. ` +
        'Please switch to server API mode for LLM inference.'
      );
    }
  };
}
