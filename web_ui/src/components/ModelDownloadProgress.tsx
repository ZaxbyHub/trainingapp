/**
 * ModelDownloadProgress — Displays download progress bar, speed, ETA,
 * error state for quota exceeded, and a cancel button.
 *
 * Lumen phase 4: built on the ui/ classes and primitives (ui-progress, Banner,
 * Button); Lumen tokens only (components/settings-hygiene.test.ts).
 */

import React from 'react';
import { Banner, Button } from '../ui';
import './settings.css';

export interface ModelDownloadProgressProps {
  /** Current download progress state */
  progress: {
    modelId: string;
    percentage: number;
    speedBytesPerSec: number;
    estimatedTimeRemainingSec: number;
    status: 'idle' | 'downloading' | 'complete' | 'error';
  } | null;
  /** Called when the user clicks cancel */
  onCancel?: () => void;
  /** Whether the quota exceeded error is shown */
  isQuotaError?: boolean;
}

/**
 * Format bytes per second as MB/s with one decimal place.
 */
function formatSpeed(bytesPerSec: number): string {
  const mbPerSec = bytesPerSec / (1024 * 1024);
  return `${mbPerSec.toFixed(1)} MB/s`;
}

/**
 * Format seconds as "Xm Ys" or "Xs" for ETA display.
 */
function formatETA(seconds: number): string {
  if (seconds <= 0) return 'Calculating…';
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * ModelDownloadProgress component.
 *
 * Displays:
 * - Model name
 * - Progress bar with ARIA attributes for accessibility
 * - Percentage complete
 * - Download speed (MB/s)
 * - Estimated time remaining
 * - Error banner for quota exceeded
 * - Cancel button (only while downloading)
 */
export function ModelDownloadProgress({
  progress,
  onCancel,
  isQuotaError = false,
}: ModelDownloadProgressProps): React.ReactElement | null {
  if (!progress || progress.status === 'idle') {
    return null;
  }

  const isDownloading = progress.status === 'downloading';
  const isComplete = progress.status === 'complete';
  const isError = progress.status === 'error' || isQuotaError;
  const statusTone = isComplete ? 'settings-tone--accent settings-strong' : isError ? 'settings-tone--danger' : '';

  return (
    <div
      className={`settings-download${isError ? ' settings-download--error' : ''}`}
      role="region"
      aria-label="Model download progress"
    >
      {/* Header: model name + status */}
      <div className="settings-download__head">
        <span className="settings-download__name">{progress.modelId}</span>
        <span className={`settings-text ${statusTone}`.trim()}>
          {isComplete ? 'Complete' : isError ? 'Error' : `${progress.percentage}%`}
        </span>
      </div>

      {/* Progress bar with ARIA — hidden on quota error since error banner is shown */}
      {!isQuotaError && (
        <div
          role="progressbar"
          aria-valuenow={progress.percentage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Download progress for ${progress.modelId}: ${progress.percentage}%`}
          className="ui-progress"
        >
          <div className="ui-progress__fill" style={{ width: `${Math.min(100, progress.percentage)}%` }} />
        </div>
      )}

      {/* Speed + ETA stats */}
      {!isComplete && !isError && (
        <div className="settings-download__stats">
          <span>{formatSpeed(progress.speedBytesPerSec)}</span>
          <span>ETA: {formatETA(progress.estimatedTimeRemainingSec)}</span>
        </div>
      )}

      {/* Quota error banner (Banner tone danger renders role="alert") */}
      {isQuotaError && (
        <Banner tone="danger">
          Storage quota exceeded. Please free up browser storage space and reload the page.
        </Banner>
      )}

      {/* Generic error state */}
      {progress.status === 'error' && !isQuotaError && (
        <Banner tone="danger">Download failed. Please try again.</Banner>
      )}

      {/* Cancel button — only while downloading */}
      {isDownloading && onCancel && (
        <div className="settings-download__actions">
          <Button variant="secondary" size="sm" onClick={onCancel} aria-label="Cancel model download">
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
