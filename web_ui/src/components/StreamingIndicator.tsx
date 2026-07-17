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
export function StreamingIndicator({ isVisible, modelLoadProgress, modelLoadLabel }: StreamingIndicatorProps): React.ReactElement | null {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  const isLoadingModel = typeof modelLoadProgress === 'number' && modelLoadProgress >= 0 && modelLoadProgress < 100;

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
