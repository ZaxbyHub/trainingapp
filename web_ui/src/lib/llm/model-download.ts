/**
 * Model Download Manager — wraps WebLLMService with progress tracking,
 * speed/ETA calculation, and storage quota error handling.
 */

import { WebLLMService } from './web-llm-service';

export type DownloadStatus = 'idle' | 'downloading' | 'complete' | 'error';

export interface DownloadProgress {
  modelId: string;
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
  speedBytesPerSec: number;
  estimatedTimeRemainingSec: number;
  status: DownloadStatus;
}

/**
 * Maps web-llm's progress callback format to our unified DownloadProgress.
 * web-llm reports progress as a 0-1 fraction, totalBytes is an estimate
 * based on known model sizes since web-llm doesn't expose it directly.
 */
interface WebLLMProgressPayload {
  progress: number;
  timeElapsed: number;
  text: string;
}

/**
 * Default model sizes in bytes for ETA calculation when model is not cached.
 * These are approximate sizes for the Q4_K_M quantization variants.
 */
const MODEL_SIZE_ESTIMATES: Record<string, number> = {
  'SmolLM3-3B-Q4_K_M': 2_000_000_000, // ~1.9 GB
};

/**
 * Get estimated total bytes for a model, falling back to 2GB if unknown.
 */
function getEstimatedModelBytes(modelId: string): number {
  return MODEL_SIZE_ESTIMATES[modelId] ?? 2_000_000_000;
}

/**
 * ModelDownloadManager — tracks download state, computes speed and ETA,
 * surfaces quota errors, and provides cancellation.
 *
 * Note: CreateMLCEngine does not support aborting model initialization.
 * When cancel is called during download, the download state is reset to 'idle'
 * and the promise is rejected. The user should navigate away; the in-progress
 * download will continue in the background but will be discarded on next init.
 */
export class ModelDownloadManager {
  private _currentProgress: DownloadProgress | null = null;
  private _downloading = false;
  private _cancelled = false;

  /**
   * Start downloading a model via WebLLMService.
   *
   * @param modelId   Model identifier string.
   * @param onProgress Optional callback fired on each progress update.
   * @returns Promise that resolves when download is complete.
   * @throws Error with message if quota exceeded or WebGPU unavailable,
   *         or if a download is already in progress.
   */
  async downloadModel(
    modelId: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<void> {
    // Guard: prevent concurrent downloads
    if (this._downloading) {
      throw new Error('A download is already in progress');
    }

    this._downloading = true;
    this._cancelled = false;

    // Initialize progress state
    const totalBytes = getEstimatedModelBytes(modelId);
    this._currentProgress = {
      modelId,
      bytesDownloaded: 0,
      totalBytes,
      percentage: 0,
      speedBytesPerSec: 0,
      estimatedTimeRemainingSec: 0,
      status: 'downloading',
    };

    // Create progress handler that wires web-llm callback to our progress tracker
    const progressHandler = (payload: WebLLMProgressPayload) => {
      if (this._currentProgress?.status !== 'downloading') return;
      const partial = this._computeProgressFromPayload(modelId, payload, totalBytes);
      this._currentProgress = {
        ...this._currentProgress,
        ...partial,
      };
      onProgress?.(this._currentProgress);
    };

    try {
      // If already initialized, dispose first so we can re-init with new model
      const instance = WebLLMService.getInstance();
      if (instance.isReady()) {
        instance.dispose();
        // Small delay to allow cleanup before re-init
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      await instance.initialize(modelId, progressHandler);

      if (this._cancelled) {
        throw new Error('Download cancelled');
      }

      // If we reach here without error and progress indicates completion,
      // mark as complete. WebLLMService.initialize() may return quickly
      // if the model is already cached.
      if (this._currentProgress.status === 'downloading') {
        this._currentProgress = {
          ...this._currentProgress,
          bytesDownloaded: totalBytes,
          percentage: 100,
          speedBytesPerSec: 0,
          estimatedTimeRemainingSec: 0,
          status: 'complete',
        };
        onProgress?.(this._currentProgress);
      }
    } catch (err: unknown) {
      this._currentProgress = {
        ...(this._currentProgress ?? {
          modelId,
          bytesDownloaded: 0,
          totalBytes,
          percentage: 0,
          speedBytesPerSec: 0,
          estimatedTimeRemainingSec: 0,
        }),
        status: this._cancelled ? 'idle' : 'error',
      };

      // Re-throw quota errors so callers can surface them specifically
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('quota') ||
        message.includes('QuotaExceededError') ||
        message.includes('IndexedDB') ||
        message.includes('OPFS')
      ) {
        const quotaError = new Error(
          'Browser storage quota exceeded while downloading the model. ' +
          'Please free up space in your browser\'s IndexedDB/OPFS storage and reload.'
        );
        onProgress?.(this._currentProgress);
        throw quotaError;
      }

      onProgress?.(this._currentProgress);
      throw err;
    } finally {
      this._downloading = false;
      this._cancelled = false;
    }
  }

  /**
   * Returns the most recent download progress snapshot, or null if no
   * download has been initiated.
   */
  getDownloadProgress(): DownloadProgress | null {
    return this._currentProgress;
  }

  /**
   * @returns true if a download is currently in progress.
   */
  isDownloading(): boolean {
    return this._currentProgress?.status === 'downloading';
  }

  /**
   * Cancel the in-progress download.
   *
   * Note: CreateMLCEngine does not support aborting model initialization.
   * This cancels the download promise and resets state to 'idle'. The
   * in-progress network download will continue in the browser but the
   * promise will be rejected. The user should navigate away.
   */
  cancelDownload(): void {
    if (this._currentProgress?.status === 'downloading') {
      this._currentProgress = {
        ...this._currentProgress,
        status: 'idle',
        estimatedTimeRemainingSec: 0,
      };
    }
    this._cancelled = true;
  }

  /**
   * Parse web-llm progress callback data and compute speed + ETA.
   *
   * @param modelId   Model being downloaded.
   * @param payload   Progress payload from web-llm initProgressCallback.
   * @param totalBytes Estimated total bytes for this model.
   * @returns Updated partial progress fields.
   */
  /* package */ _computeProgressFromPayload(
    modelId: string,
    payload: WebLLMProgressPayload,
    totalBytes: number
  ): Omit<DownloadProgress, 'modelId'> {
    const elapsedSec = payload.timeElapsed;
    const bytesDownloaded = Math.floor(payload.progress * totalBytes);
    const percentage = Math.min(100, Math.round(payload.progress * 100));

    // Speed: bytes downloaded / elapsed time
    const speedBytesPerSec = elapsedSec > 0
      ? Math.round(bytesDownloaded / elapsedSec)
      : 0;

    // ETA: remaining bytes / speed
    const remainingBytes = totalBytes - bytesDownloaded;
    const estimatedTimeRemainingSec = speedBytesPerSec > 0
      ? Math.round(remainingBytes / speedBytesPerSec)
      : 0;

    return {
      bytesDownloaded,
      totalBytes,
      percentage,
      speedBytesPerSec,
      estimatedTimeRemainingSec,
      status: 'downloading',
    };
  }
}
