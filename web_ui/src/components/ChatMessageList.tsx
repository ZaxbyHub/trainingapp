/**
 * Scrollable message list component.
 * Displays a list of chat messages with auto-scroll behavior.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import type { ChatMessage } from '../types/chat';
import { ChatMessageBubble } from './ChatMessageBubble';

interface ChatMessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  /** When provided, the last assistant message shows a Regenerate action. */
  onRegenerate?: () => void;
}

const SCROLL_THRESHOLD = 100;

export const ChatMessageList: React.FC<ChatMessageListProps> = React.memo(({ messages, isStreaming, onRegenerate }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const checkIfNearBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    return distanceFromBottom <= SCROLL_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((force: boolean = false) => {
    const container = containerRef.current;
    if (!container) return;

    if (force || isNearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  // Track if user is near bottom
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      isNearBottomRef.current = checkIfNearBottom();
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [checkIfNearBottom]);

  // Auto-scroll when messages change
  useEffect(() => {
    scrollToBottom(isStreaming);
  }, [messages, isStreaming, scrollToBottom]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: messages.length > 0 ? 'var(--spacing-lg)' : 'var(--spacing-xxl)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {messages.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <p
            style={{
              fontSize: 'var(--font-size-body)',
              color: 'var(--color-text-muted)',
              fontFamily: 'var(--font-family)',
              textAlign: 'center',
            }}
          >
            Ask a question about your documents
          </p>
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
