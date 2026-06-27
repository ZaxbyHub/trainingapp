import React, { useEffect, useRef, useCallback } from 'react';
import type { ChatMessage } from '../types/chat';
import { ChatMessageBubble } from './ChatMessageBubble';

interface ChatMessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  onRegenerate?: () => void;
  onSuggestedPrompt?: (prompt: string) => void;
}

const SCROLL_THRESHOLD = 100;

const suggestedPrompts = [
  "Summarize my documents",
  "What are the key topics?",
  "Find specific information",
];

export const ChatMessageList: React.FC<ChatMessageListProps> = React.memo(({
  messages,
  isStreaming,
  onRegenerate,
  onSuggestedPrompt,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const checkIfNearBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((force: boolean = false) => {
    const container = containerRef.current;
    if (!container) return;
    if (force || isNearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => { isNearBottomRef.current = checkIfNearBottom(); };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [checkIfNearBottom]);

  useEffect(() => {
    scrollToBottom(isStreaming);
  }, [messages, isStreaming, scrollToBottom]);

  const handlePromptClick = (prompt: string) => {
    onSuggestedPrompt?.(prompt);
  };

  const containerStyle: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: messages.length > 0 ? 'var(--spacing-lg)' : 'var(--spacing-xxl)',
    display: 'flex',
    flexDirection: 'column',
    maxWidth: '768px',
    margin: '0 auto',
    width: '100%',
    boxSizing: 'border-box',
  };

  const emptyStateStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: 'var(--spacing-xl)',
    gap: 'var(--spacing-xxl)',
  };

  const heroStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-display)',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-family)',
    margin: 0,
    lineHeight: 'var(--line-height-tight)',
    maxWidth: '560px',
  };

  const subtitleStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-h3)',
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-family)',
    maxWidth: '420px',
    margin: 'var(--spacing-md) 0 var(--spacing-xl)',
    lineHeight: 'var(--line-height-body)',
  };

  const promptsStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--spacing-md)',
    width: '100%',
    maxWidth: '560px',
  };

  const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-bubble-assistant)',
    border: '1px solid var(--color-bubble-system)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--spacing-lg)',
    cursor: 'pointer',
    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
    textAlign: 'left',
    fontSize: 'var(--font-size-body)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-family)',
    lineHeight: 'var(--line-height-body)',
    boxShadow: 'var(--shadow-sm)',
    transform: 'none',
  };

  const cardHoverStyle: React.CSSProperties = {
    borderColor: 'var(--color-primary)',
    backgroundColor: 'var(--color-secondary)',
    transform: 'translateY(-2px)',
    boxShadow: 'var(--shadow-md)',
  };

  const footerStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-small)',
    color: 'var(--color-text-muted)',
    marginTop: 'var(--spacing-lg)',
  };

  return (
    <div ref={containerRef} style={containerStyle} role="log" aria-live="polite">
      {messages.length === 0 ? (
        <div style={emptyStateStyle} role="region" aria-labelledby="welcome-heading">
          <div>
            <h1 id="welcome-heading" style={heroStyle}>How can I help with your documents?</h1>
            <p style={subtitleStyle}>
              Ask anything about your uploaded documents. Get summaries, extract insights, or find specific information instantly.
            </p>
          </div>
          <div style={promptsStyle} role="group" aria-label="Suggested prompts">
            {suggestedPrompts.map((prompt, index) => (
              <button
                key={index}
                type="button"
                style={cardStyle}
                onMouseOver={(e) => { Object.assign(e.currentTarget.style, cardHoverStyle); }}
                onMouseOut={(e) => { Object.assign(e.currentTarget.style, cardStyle); }}
                onClick={() => handlePromptClick(prompt)}
                aria-label={`Suggested prompt: ${prompt}`}
              >
                {prompt}
              </button>
            ))}
          </div>
          <div style={footerStyle}>All conversations are stored locally in your browser</div>
        </div>
      ) : (
        messages.map((message, idx) => (
          <ChatMessageBubble
            key={message.id}
            message={message}
            onRegenerate={
              onRegenerate &&
              message.role === 'assistant' &&
              idx === messages.length - 1 &&
              !message.isStreaming
                ? onRegenerate
                : undefined
            }
          />
        ))
      )}
    </div>
  );
});

ChatMessageList.displayName = 'ChatMessageList';
