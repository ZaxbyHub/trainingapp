/**
 * Inference mode toggle component - shows current mode and allows switching.
 * Displays a status dot plus a status word (never color alone; Lumen phase 5)
 * based on mode readiness. Rendered only inside the desktop app.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useInferenceMode, type InferenceMode } from '../lib/inference';
import { isElectron } from '../lib/desktop-session';
import { Button } from '../ui';
import '../pages/chat.css';

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

  type StatusTone = 'ok' | 'pending' | 'error';
  const getStatus = (): { tone: StatusTone; word: string } => {
    if (mode === 'browser-local') {
      return isModelReady ? { tone: 'ok', word: 'Ready' } : { tone: 'pending', word: 'Loading…' };
    }
    // API mode
    if (isChecking) return { tone: 'pending', word: 'Checking…' };
    if (isServerConnected) return { tone: 'ok', word: 'Connected' };
    if (modeError) return { tone: 'error', word: 'Error' };
    return { tone: 'pending', word: 'Not connected' };
  };

  const getModeLabel = (): string => {
    // U7b: plain-English labels instead of 'Local'/'API' jargon.
    if (mode === 'browser-local') return 'On this computer';
    return 'Desktop backend';
  };

  const getTooltipText = (): string => {
    if (mode === 'browser-local') {
      if (isModelReady) return 'Browser-local mode (model ready)';
      return 'Browser-local mode (model loading...)';
    }
    if (isChecking) return 'Desktop backend (checking connectivity...)';
    if (isServerConnected) return 'Desktop backend (connected)';
    if (modeError) return `Desktop backend (${modeError})`;
    return 'Desktop backend (not connected)';
  };

  const status = getStatus();

  // U7b air-gap safety: the toggle is a one-click flip to API mode, so only
  // render it when the desktop app's built-in backend is the target
  // (settings-wiring-honesty: the browser app has no API-server mode, and its
  // `serverUrl` is always empty). Otherwise the toggle would be a dead control
  // — hide it and let the parent layout collapse the slot.
  if (!isElectron() || !serverUrl) {
    return null;
  }

  return (
    <div className="chat-mode">
      {/* Status indicator dot (decorative; the status word carries the state) */}
      <span
        title={getTooltipText()}
        aria-hidden="true"
        className={`chat-mode__dot chat-mode__dot--${status.tone}`}
        data-status={status.tone}
      />

      {/* U7b: the current state is legible without hovering for the tooltip.
          The full tooltip sentence is exposed as visually hidden text (aria-label
          is not allowed on a role-less span). */}
      <span className="chat-mode__status" title={getTooltipText()}>
        {status.word}
        <span className="ui-visually-hidden"> ({getTooltipText()})</span>
      </span>

      {/* Mode toggle button: its visible label is the current mode. */}
      <Button
        size="sm"
        variant="secondary"
        onClick={handleToggle}
        disabled={isChecking}
        aria-disabled={isChecking || undefined}
        title={getTooltipText()}
        aria-pressed={mode === 'api'}
        aria-label={`Inference mode: ${mode}. Click to toggle.`}
      >
        {getModeLabel()}
      </Button>
    </div>
  );
}
