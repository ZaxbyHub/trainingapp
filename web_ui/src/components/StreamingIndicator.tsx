/**
 * StreamingIndicator - Animated typing indicator for streaming responses.
 * Displays "Generating" text with a blinking cursor, or static "Generating..." for reduced motion.
 */

import React, { useEffect, useState } from 'react';
import { ProgressBar } from '../ui';
import '../pages/chat.css';

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
 *
 * #133 (round 4): the elapsed-time cold-load heuristic was REMOVED — it
 * misfired on any generation whose first token took >8s. Chat gating is now
 * driven by the BACKEND's resident load state (see ChatPage's banner).
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

  // U1: determinate model-load bar.
  if (isLoadingModel) {
    const pct = Math.max(0, Math.min(100, Math.round(modelLoadProgress ?? 0)));
    return (
      <div
        className="chat-streaming chat-streaming--load"
        data-testid="streaming-indicator"
        role="status"
        aria-live="polite"
        aria-label={`Loading AI model, ${pct}% complete`}
      >
        <span>
          {modelLoadLabel ?? 'Loading the AI model — one-time, may take a few minutes…'} {pct}%
        </span>
        <ProgressBar label="Loading the AI model" value={pct} />
      </div>
    );
  }

  return (
    <div className="chat-streaming" data-testid="streaming-indicator" role="status" aria-live="polite" aria-label="Generating response">
      {prefersReducedMotion ? (
        <span>Generating...</span>
      ) : (
        <span>
          Generating<span className="chat-streaming__cursor" aria-hidden="true">▋</span>
        </span>
      )}
    </div>
  );
}
