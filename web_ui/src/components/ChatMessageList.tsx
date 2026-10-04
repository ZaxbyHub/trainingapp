import React, { useEffect, useRef, useCallback, useState } from 'react';
import type { ChatMessage } from '../types/chat';
import { ChatMessageBubble } from './ChatMessageBubble';
import { useDocumentCount } from '../hooks/useDocumentCount';
import { Button, Icon } from '../ui';
import '../pages/chat.css';

interface ChatMessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  onRegenerate?: () => void;
  onSuggestedPrompt?: (prompt: string) => void;
  /** U4: navigate to the Documents page (for the zero-doc empty state). */
  onNavigateToDocuments?: () => void;
  /** D6 (issue #82): "Open in training" deep link from the Learn panel. */
  onOpenTraining?: (target: { packId?: string; slideId: string }) => void;
}

const SCROLL_THRESHOLD = 100;
/** Re-render interval so relative timestamps ("3m ago") stay fresh. */
const RELATIVE_TIME_TICK_MS = 60_000;
/** S5: cap on how many messages RENDER at once. Windowing is render-only —
 *  the full history remains in state + IndexedDB. The indicator is a
 *  non-persisted render element, never written to Dexie. */
const MAX_RENDERED_MESSAGES = 200;

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
  onNavigateToDocuments,
  onOpenTraining,
}) => {
  // U4: document-count-aware empty state. With zero docs, suggesting prompts
  // that route through the cold-load then abstain is a guaranteed dead end.
  const { count: documentCount } = useDocumentCount();
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  // Render-mirror of isNearBottomRef so we can show/hide the Jump-to-latest button.
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Force-scroll exactly once when the user sends, and again on the first
  // assistant token of the reply (so a user who scrolled away snaps back when
  // the answer begins). During the rest of streaming we respect the
  // near-bottom heuristic — never yanking a reader who scrolled up.
  const prevLastRoleRef = useRef<string | undefined>(undefined);
  // Visually-hidden region that announces "Response complete" when streaming
  // ends (the role="log" container announces content mutations but not the
  // completion transition itself — this region does).
  const [completionNotice, setCompletionNotice] = useState('');
  const prevIsStreamingRef = useRef(false);
  // Ticking "now" so ChatMessageBubble's relative timestamps recompute.
  const [now, setNow] = useState(() => Date.now());

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

  // Track whether the user is near the bottom on each scroll.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const near = checkIfNearBottom();
      isNearBottomRef.current = near;
      setIsAtBottom(near);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [checkIfNearBottom]);

  // Decide whether to force-scroll: only on a new user message or the first
  // assistant token of a reply. Otherwise respect the near-bottom heuristic.
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    const prevRole = prevLastRoleRef.current;
    const isReplyStart = prevRole === 'user' && lastMsg?.role === 'assistant';
    const isUserSend = lastMsg?.role === 'user';
    scrollToBottom(isUserSend || isReplyStart);
    prevLastRoleRef.current = lastMsg?.role;
  }, [messages, scrollToBottom]);

  // Announce completion when streaming transitions true -> false with content.
  useEffect(() => {
    if (prevIsStreamingRef.current && !isStreaming && messages.length > 0) {
      setCompletionNotice('Response complete');
    }
    // Clear the notice when a new generation starts so it can fire again.
    if (isStreaming && !prevIsStreamingRef.current) {
      setCompletionNotice('');
    }
    prevIsStreamingRef.current = isStreaming;
  }, [isStreaming, messages.length]);

  // Shared 60-second ticker so relative timestamps ("Just now", "3m ago")
  // recompute instead of freezing at the value computed on first render.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const handleJumpToLatest = useCallback(() => {
    scrollToBottom(true);
    isNearBottomRef.current = true;
    setIsAtBottom(true);
  }, [scrollToBottom]);

  const handlePromptClick = (prompt: string) => {
    onSuggestedPrompt?.(prompt);
  };

  // S8: the `now` tick is passed down to ChatMessageBubble so its React.memo
  // comparison sees a changed prop and re-renders, recomputing the relative
  // timestamp. Previously the tick was discarded (`void now;`) and the memo
  // blocked the re-render, freezing timestamps at first paint.
  // S5: window the render array to the last MAX_RENDERED_MESSAGES items. This
  // is render-only — the full `messages` array stays in state + IndexedDB.
  const hiddenCount = Math.max(0, messages.length - MAX_RENDERED_MESSAGES);
  const renderedMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  const isEmpty = messages.length === 0;

  return (
    <div ref={containerRef} className="chat-log" role="log">
      <div className="chat-log__column">
        {/* Visually-hidden completion announcement. The log container announces
            streamed content mutations, but not the generation-complete
            transition; this status region does. */}
        <div role="status" aria-live="polite" className="ui-visually-hidden">
          {completionNotice}
        </div>
        {isEmpty ? (
          <div className="chat-welcome" role="region" aria-labelledby="welcome-heading">
            {documentCount === 0 ? (
              // U4: zero-doc first-run state. Suggesting "Summarize my documents"
              // here would route through a multi-minute cold load then abstain —
              // a guaranteed dead end. Guide the user to add documents first.
              <>
                <div>
                  <h2 id="welcome-heading" className="chat-welcome__title">Add documents to get started</h2>
                  <p className="chat-welcome__subtitle">
                    Upload your documents and I can summarize them, extract key topics, and answer specific questions — all locally in your browser.
                  </p>
                </div>
                {onNavigateToDocuments && (
                  <Button variant="primary" onClick={onNavigateToDocuments}>
                    Go to Documents
                  </Button>
                )}
              </>
            ) : (
              <>
                <div>
                  <h2 id="welcome-heading" className="chat-welcome__title">How can I help with your documents?</h2>
                  <p className="chat-welcome__subtitle">
                    Ask anything about your uploaded documents. Get summaries, extract insights, or find specific information instantly.
                  </p>
                </div>
                <div className="chat-welcome__prompts" role="group" aria-label="Suggested prompts">
                  {suggestedPrompts.map((prompt, index) => (
                    <button
                      key={index}
                      type="button"
                      className="chat-welcome__prompt ui-focusable"
                      onClick={() => handlePromptClick(prompt)}
                      aria-label={`Suggested prompt: ${prompt}`}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </>
            )}
            <p className="chat-welcome__footnote">All conversations are stored locally in your browser</p>
          </div>
        ) : (
          <>
            {/* S5: render-only windowing indicator. The full history is still in
                state + IndexedDB; this only limits what is painted. Never
                persisted (it's a <div>, not a ChatMessage). */}
            {hiddenCount > 0 && (
              <div role="status" className="chat-log__window-note">
                {hiddenCount} earlier message{hiddenCount === 1 ? '' : 's'} hidden (showing the last {MAX_RENDERED_MESSAGES})
              </div>
            )}
            {renderedMessages.map((message, idx) => (
              <ChatMessageBubble
                key={message.id}
                message={message}
                now={now}
                onOpenTraining={onOpenTraining}
                onRegenerate={
                  onRegenerate &&
                  message.role === 'assistant' &&
                  idx === renderedMessages.length - 1 &&
                  !message.isStreaming
                    ? onRegenerate
                    : undefined
                }
              />
            ))}
            {!isAtBottom && (
              <Button variant="secondary" size="sm" className="chat-log__jump" onClick={handleJumpToLatest}>
                <Icon name="arrow-down" size={16} />
                Jump to latest
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
});

ChatMessageList.displayName = 'ChatMessageList';
