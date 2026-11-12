/**
 * Inference mode status (chat header) - displays a status dot plus a status
 * word (never color alone; Lumen phase 5) based on mode readiness. Rendered
 * only inside the desktop app.
 *
 * #265 (AC6, decision comment 6825525627): this used to be a mode-flip button
 * ('On this computer' <-> 'Desktop backend'). The desktop package deliberately
 * ships no browser-LLM weights, so browser-local is not a runnable target
 * inside Electron and flipping to it was a one-click dead end; the control is
 * now a NON-FLIPPING STATUS indicator (no button). Run-location changes are
 * made in Settings, whose run-location card no longer offers browser-local.
 */

import { useInferenceMode } from '../lib/inference';
import { isElectron } from '../lib/desktop-session';
import '../pages/chat.css';

export function InferenceModeToggle() {
  const { mode, isModelReady, modelLoadingProgress, isServerConnected, modeError } = useInferenceMode();

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
    // API mode: connectivity is checked by InferenceModeContext (proactively
    // on boot into api mode, and on demand elsewhere); this control only
    // reports the result.
    if (isServerConnected) return { tone: 'ok', word: 'Connected' };
    // Review F8: ChatPage already shows a "Server not connected" pill in this state,
    // so the toggle does not repeat it visibly (the hidden sentence still reads it).
    return { tone: modeError ? 'error' : 'pending', word: null };
  };

  const getTooltipText = (): string => {
    if (mode === 'browser-local') {
      if (isModelReady) return 'In this window (model ready)';
      if (loadInProgress) return `In this window (model loading, ${Math.round(modelLoadingProgress)}%)`;
      return 'In this window (model not loaded)';
    }
    if (isServerConnected) return 'Desktop backend (connected)';
    if (modeError) return `Desktop backend (${modeError})`;
    return 'Desktop backend (not connected)';
  };

  const status = getStatus();

  // Rendered only inside the desktop app (settings-wiring-honesty: the
  // browser app has no API-server mode, and its `serverUrl` is always empty;
  // there is nothing to report). In Electron this renders the non-flipping
  // STATUS — never null — even before the per-launch serverUrl is seeded: the
  // honest word for an unseeded backend is "not connected", which the hidden
  // sentence reads (#265 AC6).
  if (!isElectron()) {
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
    </div>
  );
}
