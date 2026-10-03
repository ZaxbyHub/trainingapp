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
    modelLoadingProgress,
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

  // Honest state (review F3): "Loading…" only while a load is actually running.
  // modelLoadingProgress is strictly between 0 and 100 exactly while a load reports
  // progress (the same signal ChatPage's composer indicator uses); otherwise a model
  // that is not ready is simply not loaded (weights absent, not cached, or never
  // requested), and saying "Loading…" would be a lie.
  const loadInProgress = modelLoadingProgress > 0 && modelLoadingProgress < 100;

  type StatusTone = 'ok' | 'pending' | 'error';
  /** word === null: no visible word (the page already shows the state). */
  const getStatus = (): { tone: StatusTone; word: string | null } => {
    if (mode === 'browser-local') {
      if (isModelReady) return { tone: 'ok', word: 'Ready' };
      return loadInProgress ? { tone: 'pending', word: 'Loading…' } : { tone: 'pending', word: 'Not ready' };
    }
    // API mode
    if (isChecking) return { tone: 'pending', word: 'Checking…' };
    if (isServerConnected) return { tone: 'ok', word: 'Connected' };
    // Review F8: ChatPage already shows a "Server not connected" pill in this state,
    // so the toggle does not repeat it visibly (the hidden sentence still reads it).
    return { tone: modeError ? 'error' : 'pending', word: null };
  };

  const getModeLabel = (): string => {
    // U7b: plain-English labels instead of 'Local'/'API' jargon.
    if (mode === 'browser-local') return 'On this computer';
    return 'Desktop backend';
  };

  const getTooltipText = (): string => {
    if (mode === 'browser-local') {
      if (isModelReady) return 'In this window (model ready)';
      if (loadInProgress) return `In this window (model loading, ${Math.round(modelLoadingProgress)}%)`;
      return 'In this window (model not loaded)';
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
      <span className="chat-mode__status" title={getTooltipText()} data-testid="inference-mode-status">
        {status.word}
        <span className="ui-visually-hidden">{status.word ? ' ' : ''}({getTooltipText()})</span>
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
        // WCAG 2.5.3 (review F8): the accessible name contains the visible label.
        aria-label={`Inference mode: ${getModeLabel()}. Click to toggle.`}
      >
        {getModeLabel()}
      </Button>
    </div>
  );
}
