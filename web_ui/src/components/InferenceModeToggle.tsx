/**
 * Inference mode toggle component - shows current mode and allows switching.
 * Displays status indicator (green/yellow/red) based on mode readiness.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useInferenceMode, type InferenceMode } from '../lib/inference';

export function InferenceModeToggle() {
  const {
    mode,
    isModelReady,
    isServerConnected,
    modeError,
    setMode,
    checkServerConnectivity,
  } = useInferenceMode();

  const [isChecking, setIsChecking] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleToggle = useCallback(async () => {
    const newMode: InferenceMode = mode === 'browser-local' ? 'api' : 'browser-local';
    setMode(newMode);

    // If switching to API mode, check connectivity
    if (newMode === 'api') {
      setIsChecking(true);
      await checkServerConnectivity();
      if (isMountedRef.current) {
        setIsChecking(false);
      }
    }
  }, [mode, setMode, checkServerConnectivity]);

  const getStatusColor = (): string => {
    if (mode === 'browser-local') {
      if (isModelReady) return '#22c55e'; // green
      return '#eab308'; // yellow - loading
    }
    // API mode
    if (isChecking) return '#eab308'; // yellow - checking
    if (isServerConnected) return '#22c55e'; // green
    if (modeError) return '#ef4444'; // red - error
    return '#eab308'; // yellow - not checked or checking
  };

  const getModeLabel = (): string => {
    if (mode === 'browser-local') return 'Local';
    return 'API';
  };

  const getTooltipText = (): string => {
    if (mode === 'browser-local') {
      if (isModelReady) return 'Browser-local mode (model ready)';
      return 'Browser-local mode (model loading...)';
    }
    if (isChecking) return 'API mode (checking connectivity...)';
    if (isServerConnected) return 'API mode (connected)';
    if (modeError) return `API mode (${modeError})`;
    return 'API mode (not connected)';
  };

  const statusColor = getStatusColor();

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
      {/* Status indicator dot */}
      <div
        title={getTooltipText()}
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: statusColor,
          transition: 'background-color 0.2s ease',
        }}
      />

      {/* Mode toggle button */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={isChecking}
        title={getTooltipText()}
        aria-pressed={mode === 'api'}
        aria-label={`Inference mode: ${mode}. Click to toggle.`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-xs)',
          padding: 'var(--spacing-xs) var(--spacing-sm)',
          backgroundColor: 'transparent',
          border: '1px solid var(--color-text-muted)',
          borderRadius: '4px',
          color: 'var(--color-text-muted)',
          fontSize: 'var(--font-size-caption)',
          fontFamily: 'var(--font-family)',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
      >
        <span style={{ fontWeight: 500 }}>{getModeLabel()}</span>
      </button>
    </div>
  );
}
