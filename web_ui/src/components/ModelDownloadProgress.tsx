/**
 * ModelDownloadProgress — Displays download progress bar, speed, ETA,
 * error state for quota exceeded, and a cancel button.
 */

import React from 'react';

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
 * Progress bar track styles using design tokens.
 */
const progressTrackStyle: React.CSSProperties = {
  width: '100%',
  height: '8px',
  backgroundColor: 'var(--color-bubble-system)',
  borderRadius: '4px',
  overflow: 'hidden',
};

/**
 * Progress bar fill styles — width driven by percentage.
 */
function progressFillStyle(percentage: number): React.CSSProperties {
  const isComplete = percentage >= 100;
  return {
    width: `${Math.min(100, percentage)}%`,
    height: '100%',
    backgroundColor: isComplete ? 'var(--color-primary)' : 'var(--color-primary)',
    transition: 'width 0.3s ease',
    borderRadius: '4px',
  };
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

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--spacing-md)',
    padding: 'var(--spacing-card-pad)',
    backgroundColor: 'var(--color-bubble-assistant)',
    borderRadius: '8px',
    border: isError ? '1px solid var(--color-danger)' : '1px solid transparent',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: 'var(--font-size-body)',
    color: 'var(--color-text-on-bubble-assistant)',
  };

  const modelNameStyle: React.CSSProperties = {
    fontWeight: 600,
    fontSize: 'var(--font-size-h3)',
  };

  const statusTextStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-caption)',
    color: isComplete
      ? 'var(--color-primary)'
      : isError
        ? 'var(--color-danger)'
        : 'var(--color-text-muted)',
    fontWeight: isComplete ? 600 : 400,
  };

  const statsRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 'var(--font-size-caption)',
    color: 'var(--color-text-muted)',
  };

  const errorBannerStyle: React.CSSProperties = {
    padding: 'var(--spacing-md)',
    backgroundColor: 'rgba(211, 47, 47, 0.1)',
    borderRadius: '4px',
    color: 'var(--color-danger)',
    fontSize: 'var(--font-size-body)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-sm)',
  };

  const cancelButtonStyle: React.CSSProperties = {
    padding: 'var(--spacing-sm) var(--spacing-lg)',
    backgroundColor: 'var(--color-danger)',
    color: 'var(--color-text-on-primary)',
    border: 'none',
    borderRadius: '4px',
    fontSize: 'var(--font-size-body)',
    cursor: 'pointer',
    fontFamily: 'var(--font-family)',
    transition: 'background-color 0.15s ease',
  };

  const cancelButtonHoverStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-danger-hover)',
  };

  const [cancelHovered, setCancelHovered] = React.useState(false);

  return (
    <div style={containerStyle} role="region" aria-label="Model download progress">
      {/* Header: model name + status */}
      <div style={headerStyle}>
        <span style={modelNameStyle}>{progress.modelId}</span>
        <span style={statusTextStyle}>
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
          style={progressTrackStyle}
        >
          <div style={progressFillStyle(progress.percentage)} />
        </div>
      )}

      {/* Speed + ETA stats */}
      {!isComplete && !isError && (
        <div style={statsRowStyle}>
          <span>{formatSpeed(progress.speedBytesPerSec)}</span>
          <span>ETA: {formatETA(progress.estimatedTimeRemainingSec)}</span>
        </div>
      )}

      {/* Quota error banner */}
      {isQuotaError && (
        <div style={errorBannerStyle} role="alert">
          <span>
            Storage quota exceeded. Please free up browser storage space and reload the page.
          </span>
        </div>
      )}

      {/* Generic error state */}
      {progress.status === 'error' && !isQuotaError && (
        <div style={errorBannerStyle} role="alert">
          <span>Download failed. Please try again.</span>
        </div>
      )}

      {/* Cancel button — only while downloading */}
      {isDownloading && onCancel && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            style={cancelHovered ? { ...cancelButtonStyle, ...cancelButtonHoverStyle } : cancelButtonStyle}
            onClick={onCancel}
            onMouseEnter={() => setCancelHovered(true)}
            onMouseLeave={() => setCancelHovered(false)}
            aria-label="Cancel model download"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
