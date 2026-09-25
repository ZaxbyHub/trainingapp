/**
 * StreamingIndicator - Animated typing indicator for streaming responses.
 * Displays "Generating" text with a blinking cursor, or static "Generating..." for reduced motion.
 */

import React, { useEffect, useState } from 'react';

interface StreamingIndicatorProps {
  isVisible: boolean;
  /** U1: when a model load is in progress, render a determinate progress bar
   *  instead of the indeterminate "Generating" cursor so a multi-minute cold
   *  load on first send is visible. Optional. */
  modelLoadProgress?: number;
  /** U1: human-readable label for the model-load stage. wllama supplies this. */
  modelLoadLabel?: string;
  /** #133: epoch-ms timestamp of the send that is still awaiting its FIRST
   *  token. After a short grace period the indicator switches to an explicit
   *  "preparing the local AI model" state (spinner + elapsed seconds + a
   *  note that other tabs remain usable) so a minutes-long desktop cold
   *  start never looks like a generic hang or a stuck "Generating". */
  awaitingFirstTokenSince?: number;
}

/** After this long with zero tokens, the desktop cold-load explanation
 *  kicks in (a normal warm send streams its first token well inside it). */
const COLD_START_HINT_AFTER_MS = 8_000;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/** #133: cold-load state — spinner + elapsed counter + the operator-facing
 *  explanation (first launch loads a multi-GB model; other tabs stay
 *  usable). Reduced-motion renders without the spin animation. */
function ColdLoadNotice({ elapsedMs, prefersReducedMotion }: { elapsedMs: number; prefersReducedMotion: boolean }): React.ReactElement {
  const textStyle: React.CSSProperties = {
    fontFamily: 'var(--font-family)',
    fontSize: 'var(--font-size-caption)',
    color: 'var(--color-text-muted)',
    fontWeight: 500,
  };
  const spinnerStyle: React.CSSProperties = {
    width: '14px',
    height: '14px',
    marginRight: '8px',
    borderRadius: '50%',
    border: '2px solid var(--color-text-muted)',
    borderTopColor: 'transparent',
    animation: 'spin 1s linear infinite',
  };
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)', padding: '4px 0', width: '100%', maxWidth: '480px' }}
      data-testid="streaming-indicator-cold-load"
      role="status"
      aria-live="polite"
      aria-label={`Preparing the local AI model, ${formatElapsed(elapsedMs)} elapsed`}
    >
      <span style={{ ...textStyle, display: 'inline-flex', alignItems: 'center' }}>
        {!prefersReducedMotion && <span style={spinnerStyle} aria-hidden="true" />}
        Preparing the local AI model — elapsed {formatElapsed(elapsedMs)}
      </span>
      <span style={textStyle}>
        The first question after launch loads the model into memory (this can take several minutes).
        You can keep exploring other tabs — your answer will appear here.
      </span>
    </div>
  );
}

/**
 * Animated streaming indicator with blinking cursor.
 * Shows "Generating" + blinking cursor when motion is allowed.
 * Shows "Generating..." static text when reduced motion is preferred.
 *
 * U1: when `modelLoadProgress` is provided (0-100), renders a determinate bar
 * with `modelLoadLabel` so a cold first-send model load is visible rather than
 * appearing as an indeterminate hang.
 */
export function StreamingIndicator({ isVisible, modelLoadProgress, modelLoadLabel, awaitingFirstTokenSince }: StreamingIndicatorProps): React.ReactElement | null {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  // #133: tick so the cold-load elapsed counter advances while waiting.
  const [now, setNow] = useState(() => Date.now());

  const isLoadingModel = typeof modelLoadProgress === 'number' && modelLoadProgress >= 0 && modelLoadProgress < 100;
  const firstTokenPending = !isLoadingModel && typeof awaitingFirstTokenSince === 'number';
  // Tick while a send is pending so the threshold crossing and the elapsed
  // counter both advance without any other render trigger. ALWAYS tick —
  // reduced motion only disables the spin ANIMATION below, never the state
  // machine (gating the tick on the media query froze the notice on RDP
  // sessions where Windows reports prefers-reduced-motion: reduce, which was
  // the operator's "never happened at all").
  useEffect(() => {
    if (!isVisible || !firstTokenPending) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isVisible, firstTokenPending]);
  const awaitingFirstToken =
    firstTokenPending && now - awaitingFirstTokenSince > COLD_START_HINT_AFTER_MS;

  useEffect(() => {
    const mediaQuery =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    if (mediaQuery) {
      setPrefersReducedMotion(mediaQuery.matches);
    }

    const handler = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    if (mediaQuery) {
      mediaQuery.addEventListener('change', handler);
      return () => {
        mediaQuery.removeEventListener('change', handler);
      };
    }
    return undefined;
  }, []);

  if (!isVisible) {
    return null;
  }

  // #133: no token yet after the grace period — desktop cold start.
  if (awaitingFirstToken) {
    return <ColdLoadNotice elapsedMs={now - awaitingFirstTokenSince} prefersReducedMotion={prefersReducedMotion} />;
  }

  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 0',
  };

  const textStyle: React.CSSProperties = {
    fontFamily: 'var(--font-family)',
    fontSize: 'var(--font-size-caption)',
    color: 'var(--color-text-muted)',
    fontWeight: 500,
  };

  const cursorStyle: React.CSSProperties = {
    animation: 'blink 1s step-end infinite',
    color: 'var(--color-text-muted)',
    marginLeft: '2px',
  };

  // U1: determinate model-load bar.
  if (isLoadingModel) {
    const pct = Math.max(0, Math.min(100, Math.round(modelLoadProgress ?? 0)));
    return (
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)', padding: '4px 0', width: '100%', maxWidth: '420px' }}
        data-testid="streaming-indicator"
        role="status"
        aria-live="polite"
        aria-label={`Loading AI model, ${pct}% complete`}
      >
        <span style={textStyle}>
          {modelLoadLabel ?? 'Loading the AI model — one-time, may take a few minutes…'} {pct}%
        </span>
        <div
          style={{
            height: '6px',
            width: '100%',
            backgroundColor: 'var(--color-bubble-system)',
            borderRadius: 'var(--radius-xs)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${pct}%`,
              backgroundColor: 'var(--color-primary)',
              borderRadius: 'var(--radius-xs)',
              transition: 'width 200ms ease',
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="streaming-indicator" role="status" aria-live="polite" aria-label="Generating response">
      {prefersReducedMotion ? (
        <span style={textStyle}>Generating...</span>
      ) : (
        <span style={textStyle}>
          Generating<span style={cursorStyle}>▋</span>
        </span>
      )}
    </div>
  );
}
