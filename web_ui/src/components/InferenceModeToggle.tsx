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
    serverUrl,
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
    // U7b: plain-English labels instead of 'Local'/'API' jargon.
    if (mode === 'browser-local') return 'On this computer';
    return 'Company server';
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

  // U7b air-gap safety: the toggle is a one-click flip to API mode, so only
  // render it when an API server is actually configured. When `serverUrl` is
  // empty the app is browser-local only and the toggle would be a dead control
  // (and a confusing "Company server" affordance) — hide it and let the parent
  // layout collapse the slot.
  if (!serverUrl) {
    return null;
  }

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

      {/* U7b: visible mode label next to the dot, so the current mode is
          legible without hovering for the tooltip. */}
      <span
        aria-label={getTooltipText()}
        style={{
          fontSize: 'var(--font-size-caption)',
          fontFamily: 'var(--font-family)',
          color: 'var(--color-text-muted)',
          whiteSpace: 'nowrap',
        }}
      >
        {getModeLabel()}
      </span>

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
