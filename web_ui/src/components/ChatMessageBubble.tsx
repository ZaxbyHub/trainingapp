/**
 * Single message bubble component.
 * Displays a chat message with appropriate styling based on role.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types/chat';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SourceCitation } from './SourceCitation';

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return 'just now';
}

interface ChatMessageBubbleProps {
  message: ChatMessage;
  /** When set, renders a Regenerate action (last assistant message only). */
  onRegenerate?: () => void;
}

export const ChatMessageBubble: React.FC<ChatMessageBubbleProps> = React.memo(({ message, onRegenerate }) => {
  const [showCopy, setShowCopy] = useState(false);
  const [showCopiedFeedback, setShowCopiedFeedback] = useState(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current !== null) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setShowCopiedFeedback(true);
      if (copyFeedbackTimerRef.current !== null) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = setTimeout(() => {
        setShowCopiedFeedback(false);
        copyFeedbackTimerRef.current = null;
      }, 1500);
    } catch {
      console.warn('[ChatMessageBubble] Clipboard write failed');
    }
  }, [message.content]);

  const bubbleStyle: React.CSSProperties = {
    maxWidth: '75%',
    padding: 'var(--spacing-md)',
    borderRadius: '12px',
    position: 'relative',
    wordBreak: 'break-word',
  };

  const timeStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-small)',
    marginTop: 'var(--spacing-xs)',
    opacity: 0.7,
  };

  const copyButtonStyle: React.CSSProperties = {
    position: 'absolute',
    top: 'var(--spacing-sm)',
    right: 'var(--spacing-sm)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 'var(--spacing-xs)',
    opacity: showCopy ? 1 : 0,
    transition: 'opacity 0.15s ease',
    color: 'var(--color-text-muted)',
    fontSize: 'var(--font-size-caption)',
  };

  const copiedFeedbackStyle: React.CSSProperties = {
    position: 'absolute',
    top: 'var(--spacing-sm)',
    right: 'var(--spacing-sm)',
    backgroundColor: 'var(--color-source-pill-bg)',
    color: 'var(--color-text-muted)',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: 'var(--font-size-caption)',
    pointerEvents: 'none',
    opacity: showCopiedFeedback ? 1 : 0,
    transition: 'opacity 0.15s ease',
  };

  const cursorStyle: React.CSSProperties = {
    display: 'inline-block',
    width: '2px',
    height: 'var(--font-size-body)',
    backgroundColor: 'var(--color-text-on-bubble-assistant)',
    marginLeft: '2px',
    verticalAlign: 'text-bottom',
    animation: 'blink 1s step-end infinite',
  };

  if (message.role === 'user') {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: 'var(--spacing-sm)',
        }}
      >
        <div
          style={{
            ...bubbleStyle,
            backgroundColor: 'var(--color-bubble-user)',
            color: 'var(--color-text-on-bubble-user)',
            borderBottomRightRadius: '4px',
          }}
          onMouseEnter={() => setShowCopy(true)}
          onMouseLeave={() => setShowCopy(false)}
        >
          <button
            style={copyButtonStyle}
            onClick={handleCopy}
            aria-label="Copy message"
            type="button"
          >
            {showCopiedFeedback ? 'Copied!' : 'Copy'}
          </button>
          <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-family)' }}>
            {message.content}
          </div>
          {message.images && message.images.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--spacing-sm)',
                marginTop: 'var(--spacing-sm)',
              }}
            >
              {message.images.map((img) => (
                <img
                  key={img.id}
                  src={img.dataUrl}
                  alt={img.fileName || 'attached image'}
                  style={{
                    maxWidth: 160,
                    maxHeight: 160,
                    borderRadius: '6px',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              ))}
            </div>
          )}
          <div style={{ ...timeStyle, textAlign: 'right' }}>{formatRelativeTime(message.timestamp)}</div>
        </div>
      </div>
    );
  }

  if (message.role === 'system') {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          marginBottom: 'var(--spacing-sm)',
        }}
      >
        <div
          style={{
            ...bubbleStyle,
            backgroundColor: 'var(--color-bubble-system)',
            color: 'var(--color-text-on-bubble-system)',
            fontSize: 'var(--font-size-caption)',
            maxWidth: '90%',
            textAlign: 'center',
          }}
        >
          <div style={{ fontFamily: 'var(--font-family)' }}>{message.content}</div>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-start',
        marginBottom: 'var(--spacing-sm)',
      }}
      onMouseEnter={() => setShowCopy(true)}
      onMouseLeave={() => setShowCopy(false)}
    >
      <div
        style={{
          ...bubbleStyle,
          backgroundColor: 'var(--color-bubble-assistant)',
          color: 'var(--color-text-on-bubble-assistant)',
          borderBottomLeftRadius: '4px',
        }}
      >
        <span style={copiedFeedbackStyle}>Copied!</span>
        <button
          style={copyButtonStyle}
          onClick={handleCopy}
          aria-label="Copy message"
          type="button"
        >
          {showCopiedFeedback ? 'Copied!' : 'Copy'}
        </button>
        <div style={{ fontFamily: 'var(--font-family)' }}>
          <MarkdownRenderer content={message.content} />
          {message.isStreaming && <span style={cursorStyle} aria-hidden="true" />}
        </div>
        <div style={{ ...timeStyle, textAlign: 'left' }}>{formatRelativeTime(message.timestamp)}</div>
        {message.sources && message.sources.length > 0 && <SourceCitation sources={message.sources} />}
        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            aria-label="Regenerate response"
            style={{
              marginTop: 'var(--spacing-sm)',
              background: 'transparent',
              border: '1px solid var(--color-text-muted)',
              borderRadius: '4px',
              padding: 'var(--spacing-xs) var(--spacing-sm)',
              fontSize: 'var(--font-size-caption)',
              fontFamily: 'var(--font-family)',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
            }}
          >
            ↻ Regenerate
          </button>
        )}
      </div>
    </div>
  );
});

ChatMessageBubble.displayName = 'ChatMessageBubble';
