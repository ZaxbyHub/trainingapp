/**
 * Single message bubble component.
 * Displays a chat message with appropriate styling based on role.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types/chat';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SourceCitation } from './SourceCitation';
import { formatRelativeTime } from '../utils/relativeTime';

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
    borderRadius: 'var(--radius-md)',
    position: 'relative',
    wordBreak: 'break-word',
  };

  const timeStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-small)',
    marginTop: 'var(--spacing-xs)',
    opacity: 0.7,
  };

  const actionButtonBaseStyle: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid var(--color-bubble-system)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    padding: 'var(--spacing-xs) var(--spacing-sm)',
    fontSize: 'var(--font-size-caption)',
    fontFamily: 'var(--font-family)',
    color: 'var(--color-text-muted)',
  };

  const copyButtonInlineStyle: React.CSSProperties = {
    ...actionButtonBaseStyle,
    opacity: showCopy ? 1 : 0,
    transition: 'opacity 0.15s ease',
    visibility: showCopy ? 'visible' : 'hidden',
  };

  const copiedFeedbackInlineStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-bubble-system)',
    color: 'var(--color-text-muted)',
    padding: 'var(--spacing-xs) var(--spacing-sm)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--font-size-caption)',
    pointerEvents: 'none',
  };

  const regenerateStyle: React.CSSProperties = {
    ...actionButtonBaseStyle,
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
        onMouseEnter={() => setShowCopy(true)}
        onMouseLeave={() => setShowCopy(false)}
      >
        <div
          style={{
            ...bubbleStyle,
            backgroundColor: 'var(--color-bubble-user)',
            color: 'var(--color-text-on-bubble-user)',
            borderBottomRightRadius: 'var(--radius-xs)',
          }}
        >
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
                    borderRadius: 'var(--radius-sm)',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              ))}
            </div>
          )}
          <div style={{ ...timeStyle, textAlign: 'right' }}>{formatRelativeTime(message.timestamp)}</div>
          <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-sm)' }}>
            {showCopiedFeedback ? (
              <span style={copiedFeedbackInlineStyle}>Copied!</span>
            ) : (
              <button style={copyButtonInlineStyle} onClick={handleCopy} aria-label="Copy message" type="button">
                Copy
              </button>
            )}
          </div>
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

  // Assistant message — full-width prose
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
      <div style={{ width: '100%', padding: 'var(--spacing-md) 0' }}>
        <div style={{ fontFamily: 'var(--font-family)', lineHeight: 'var(--line-height-body)' }}>
          <MarkdownRenderer content={message.content} />
          {message.isStreaming && <span style={cursorStyle} aria-hidden="true" />}
        </div>
        <div style={{ ...timeStyle, textAlign: 'left' }}>{formatRelativeTime(message.timestamp)}</div>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-sm)' }}>
          {showCopiedFeedback ? (
            <span style={copiedFeedbackInlineStyle}>Copied!</span>
          ) : (
            <button style={copyButtonInlineStyle} onClick={handleCopy} aria-label="Copy message" type="button">
              Copy
            </button>
          )}
          {onRegenerate && (
            <button type="button" onClick={onRegenerate} aria-label="Regenerate response" style={regenerateStyle}>
              ↻ Regenerate
            </button>
          )}
        </div>
        {message.sources && message.sources.length > 0 && <SourceCitation sources={message.sources} />}
      </div>
    </div>
  );
});

ChatMessageBubble.displayName = 'ChatMessageBubble';
