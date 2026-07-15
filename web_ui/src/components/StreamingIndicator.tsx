/**
 * StreamingIndicator - Animated typing indicator for streaming responses.
 * Displays "Generating" text with a blinking cursor, or static "Generating..." for reduced motion.
 */

import React, { useEffect, useState } from 'react';

interface StreamingIndicatorProps {
  isVisible: boolean;
}

/**
 * Animated streaming indicator with blinking cursor.
 * Shows "Generating" + blinking cursor when motion is allowed.
 * Shows "Generating..." static text when reduced motion is preferred.
 */
export function StreamingIndicator({ isVisible }: StreamingIndicatorProps): React.ReactElement | null {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

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
