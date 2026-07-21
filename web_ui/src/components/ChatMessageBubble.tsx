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
  /** S8: current timestamp tick from the parent, so relative-time labels
   *  recompute every 60s instead of freezing at first paint. The prop change
   *  defeats React.memo so formatRelativeTime re-runs. */
  now?: number;
}

export const ChatMessageBubble: React.FC<ChatMessageBubbleProps> = React.memo(({ message, onRegenerate, now }) => {
  // S8: recompute the label whenever `now` changes. Falling back to Date.now()
  // keeps one-off renders (tests, direct usage) correct.
  const relativeLabel = formatRelativeTime(message.timestamp, now);
  const [copied, setCopied] = useState(false);
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
      setCopied(true);
      if (copyFeedbackTimerRef.current !== null) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = setTimeout(() => {
        setCopied(false);
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

  // Shared inline style for the copy/regenerate action buttons. Visibility is
  // driven by the `.bubble-action` / `.bubble-row` CSS classes in theme.css
  // (using :hover / :focus-within) so keyboard and touch users can reach them
  // — inline styles alone cannot express those pseudo-classes.
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
        className="bubble-row"
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
          <div style={{ ...timeStyle, textAlign: 'right' }}>{relativeLabel}</div>
          <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-sm)' }}>
            <button
              className="bubble-action"
              style={actionButtonBaseStyle}
              onClick={handleCopy}
              aria-label={copied ? 'Copied to clipboard' : 'Copy message'}
              type="button"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
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
      className="bubble-row"
      style={{
        display: 'flex',
        justifyContent: 'flex-start',
        marginBottom: 'var(--spacing-sm)',
      }}
    >
      <div
        style={{
          width: '100%',
          padding: 'var(--spacing-md) var(--spacing-lg)',
          backgroundColor: 'var(--color-surface-elevated)',
          border: '1px solid var(--color-bubble-system)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        {message.abstain ? (
          // F2: distinct abstention state. The pipeline deliberately did NOT
          // answer because it found no usable evidence, so we never show the
          // model's content or copy/citation actions.
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: 'var(--spacing-sm) var(--spacing-md)',
              borderRadius: '8px',
              backgroundColor: 'var(--color-bubble-system)',
              color: 'var(--color-text-muted)',
              fontStyle: 'italic',
              fontFamily: 'var(--font-family)',
            }}
          >
            {message.abstainReason === 'retrieval_degraded'
              ? 'Retrieval is degraded (semantic search unavailable) and no relevant passages were found.'
              : 'Insufficient evidence in the knowledge base to answer this question.'}
          </div>
        ) : message.error ? (
          // S6: structured error card. The error message is stored on the
          // dedicated `error` field (NOT injected into content, which would be
          // parsed as markdown and could linkify/mangle). The Try-again button
          // only renders when onRegenerate is present (M4) — otherwise the card
          // just reports the failure.
          <div
            role="alert"
            style={{
              padding: 'var(--spacing-md)',
              borderRadius: '8px',
              backgroundColor: 'rgba(211, 47, 47, 0.08)',
              border: '1px solid var(--color-danger)',
              color: 'var(--color-danger)',
              fontFamily: 'var(--font-family)',
            }}
          >
            <div style={{ fontSize: 'var(--font-size-body)', marginBottom: 'var(--spacing-xs)' }}>
              Something went wrong while answering.
            </div>
            <div style={{ fontSize: 'var(--font-size-caption)', opacity: 0.85, wordBreak: 'break-word' }}>
              {message.error}
            </div>
            {onRegenerate && (
              <button
                className="bubble-action"
                type="button"
                onClick={onRegenerate}
                aria-label="Try again"
                style={{ ...regenerateStyle, marginTop: 'var(--spacing-sm)' }}
              >
                ↻ Try again
              </button>
            )}
          </div>
        ) : (
          <>
            {/* A7: an empty assistant message (Stop before first token, or a
                placeholder that never received content) renders only the
                cursor while streaming, and nothing at all once settled — no
                bordered box, no Copy button that copies "". */}
            {message.content === '' && !message.isStreaming ? null : (
              <div style={{ fontFamily: 'var(--font-family)', lineHeight: 'var(--line-height-body)' }}>
                <MarkdownRenderer content={message.content} isStreaming={message.isStreaming} />
                {message.isStreaming && <span style={cursorStyle} aria-hidden="true" />}
              </div>
            )}
            {/* F4: non-blocking indicator when only keyword search was available. */}
            {message.retrievalDegraded && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  marginTop: 'var(--spacing-xs)',
                  fontSize: 'var(--font-size-caption)',
                  color: 'var(--color-text-muted)',
                  fontStyle: 'italic',
                }}
              >
                Retrieval is degraded — semantic search unavailable (showing keyword-only results).
              </div>
            )}
            <div style={{ ...timeStyle, textAlign: 'left' }}>{relativeLabel}</div>
            <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-sm)' }}>
              <button
                className="bubble-action"
                style={actionButtonBaseStyle}
                onClick={handleCopy}
                aria-label={copied ? 'Copied to clipboard' : 'Copy message'}
                type="button"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
              {onRegenerate && (
                <button
                  className="bubble-action"
                  type="button"
                  onClick={onRegenerate}
                  aria-label="Regenerate response"
                  style={regenerateStyle}
                >
                  ↻ Regenerate
                </button>
              )}
            </div>
            {/* F7: prefer structured numbered citations; fall back to legacy
                sources string array for older persisted messages. */}
            {message.citations && message.citations.length > 0 ? (
              <SourceCitation citations={message.citations} />
            ) : (
              message.sources && message.sources.length > 0 && <SourceCitation sources={message.sources} />
            )}
          </>
        )}
      </div>
    </div>
  );
});

ChatMessageBubble.displayName = 'ChatMessageBubble';
