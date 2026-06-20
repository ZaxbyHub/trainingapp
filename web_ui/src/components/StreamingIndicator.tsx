/**
 * StreamingIndicator - Animated typing indicator for streaming responses.
 * Displays three bouncing dots with staggered animation.
 */

import React, { useEffect, useState } from 'react';

interface StreamingIndicatorProps {
  isVisible: boolean;
}

/**
 * Animated streaming indicator with three bouncing dots.
 * Uses setInterval-based opacity animation for reliable cross-browser behavior.
 */
export function StreamingIndicator({ isVisible }: StreamingIndicatorProps): React.ReactElement | null {
  const [dotIndex, setDotIndex] = useState(0);

  useEffect(() => {
    if (!isVisible) return;

    const interval = setInterval(() => {
      setDotIndex((prev) => (prev + 1) % 3);
    }, 200);

    return () => {
      clearInterval(interval);
    };
  }, [isVisible]);

  if (!isVisible) {
    return null;
  }

  const dotStyle = (index: number): React.CSSProperties => {
    return {
      display: 'inline-block',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      backgroundColor: 'var(--color-text-muted)',
      margin: '0 2px',
      opacity: dotIndex === index ? 1 : 0.3,
      transition: 'opacity 0.1s ease-in-out',
    };
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 0',
      }}
    >
      <span style={dotStyle(0)} />
      <span style={dotStyle(1)} />
      <span style={dotStyle(2)} />
    </div>
  );
}