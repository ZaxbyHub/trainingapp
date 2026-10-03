/**
 * Single message bubble component.
 * Displays a chat message with appropriate styling based on role.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types/chat';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SourceCitation } from './SourceCitation';
import { LearnPanel } from './LearnPanel';
import { GroundingBadge } from './GroundingBadge';
import { formatRelativeTime } from '../utils/relativeTime';
import { Banner, Button, Icon } from '../ui';
import '../pages/chat.css';

interface ChatMessageBubbleProps {
  message: ChatMessage;
  /** When set, renders a Regenerate action (last assistant message only). */
  onRegenerate?: () => void;
  /** S8: current timestamp tick from the parent, so relative-time labels
   *  recompute every 60s instead of freezing at first paint. The prop change
   *  defeats React.memo so formatRelativeTime re-runs. */
  now?: number;
  /** D6 (issue #82): "Open in training" deep link (Learn panel buttons). */
  onOpenTraining?: (target: { packId?: string; slideId: string }) => void;
}

export const ChatMessageBubble: React.FC<ChatMessageBubbleProps> = React.memo(({ message, onRegenerate, now, onOpenTraining }) => {
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

  const copyButton = (
    <Button
      variant="ghost"
      size="sm"
      className="chat-msg__action"
      onClick={handleCopy}
      aria-label={copied ? 'Copied to clipboard' : 'Copy message'}
    >
      <Icon name={copied ? 'check' : 'copy'} size={16} />
      {copied ? 'Copied!' : 'Copy'}
    </Button>
  );

  if (message.role === 'user') {
    return (
      <div className="chat-msg chat-msg--user" data-role="user">
        <div className="chat-msg__bubble">
          <div className="chat-msg__text">{message.content}</div>
          {message.images && message.images.length > 0 && (
            <div className="chat-msg__images">
              {message.images.map((img) => (
                <img
                  key={img.id}
                  src={img.dataUrl}
                  alt={img.fileName || 'attached image'}
                  className="chat-msg__image"
                />
              ))}
            </div>
          )}
        </div>
        <div className="chat-msg__meta">
          <span className="chat-msg__time">{relativeLabel}</span>
          {copyButton}
        </div>
      </div>
    );
  }

  if (message.role === 'system') {
    return (
      <div className="chat-msg chat-msg--system" data-role="system">
        <div className="chat-msg__system">{message.content}</div>
      </div>
    );
  }

  // Assistant message — full-width prose on the canvas (no card).
  return (
    <div className="chat-msg chat-msg--assistant" data-role="assistant">
      {message.abstain ? (
        // F2: distinct abstention state. The pipeline deliberately did NOT
        // answer because it found no usable evidence, so we never show the
        // model's content or copy/citation actions.
        <div role="status" aria-live="polite" className="chat-msg__note">
          {message.abstainReason === 'retrieval_degraded'
            ? 'Retrieval is degraded (semantic search unavailable) and no relevant passages were found.'
            : 'Insufficient evidence in the knowledge base to answer this question.'}
        </div>
      ) : message.error ? (
        // S6: structured error card. The error message is stored on the
        // dedicated `error` field (NOT injected into content, which would be
        // parsed as markdown and could linkify/mangle). The Try-again button
        // only renders when onRegenerate is present (M4) — otherwise the card
        // just reports the failure. Banner(danger) keeps role="alert".
        <Banner
          tone="danger"
          title="Something went wrong while answering."
          action={
            onRegenerate ? (
              <Button variant="secondary" size="sm" onClick={onRegenerate} aria-label="Try again">
                <Icon name="rotate-ccw" size={16} />
                Try again
              </Button>
            ) : undefined
          }
        >
          <span className="chat-msg__error-detail">{message.error}</span>
        </Banner>
      ) : (
        <>
          {/* A7: an empty assistant message (Stop before first token, or a
              placeholder that never received content) renders only the
              cursor while streaming, and nothing at all once settled — no
              bordered box, no Copy button that copies "". */}
          {message.content === '' && !message.isStreaming ? null : (
            <div className="chat-msg__body">
              <MarkdownRenderer content={message.content} isStreaming={message.isStreaming} />
              {message.isStreaming && <span className="chat-msg__cursor" aria-hidden="true" />}
            </div>
          )}
          {/* F4: non-blocking indicator when only keyword search was available. */}
          {message.retrievalDegraded && (
            <div role="status" aria-live="polite" className="chat-msg__degraded">
              Retrieval is degraded — semantic search unavailable (showing keyword-only results).
            </div>
          )}
          <div className="chat-msg__meta">
            <span className="chat-msg__time">{relativeLabel}</span>
            {copyButton}
            {onRegenerate && (
              <Button
                variant="ghost"
                size="sm"
                className="chat-msg__action"
                onClick={onRegenerate}
                aria-label="Regenerate response"
              >
                <Icon name="rotate-ccw" size={16} />
                Regenerate
              </Button>
            )}
          </div>
          {/* C5 (issue #72): per-answer provenance badge (above the
              citations it describes); accessible, never color-only. */}
          <GroundingBadge grounding={message.grounding} />
          {/* F7: prefer structured numbered citations; fall back to legacy
              sources string array for older persisted messages. */}
          {message.citations && message.citations.length > 0 ? (
            <SourceCitation citations={message.citations} />
          ) : (
            message.sources && message.sources.length > 0 && <SourceCitation sources={message.sources} />
          )}
          {/* D6 (issue #82): "where to learn this" deep links, rendered after
              the citations they are derived from. */}
          {message.learn && message.learn.length > 0 && (
            <LearnPanel learn={message.learn} onOpenTraining={onOpenTraining} />
          )}
        </>
      )}
    </div>
  );
});

ChatMessageBubble.displayName = 'ChatMessageBubble';
