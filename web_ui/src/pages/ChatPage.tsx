/**
 * Chat page component - primary user interface for document Q&A.
 * Displays messages, renders markdown, and supports streaming responses.
 */

import { useState, useCallback, useRef, useEffect, type CSSProperties } from 'react';
import type { ChatMessage } from '../types/chat';
import { ChatMessageList } from '../components/ChatMessageList';
import { ChatInput } from '../components/ChatInput';
import { StreamingIndicator } from '../components/StreamingIndicator';
import { useInferenceMode } from '../lib/inference';
import { InferenceModeToggle } from '../components/InferenceModeToggle';
import { TokenStreamManager } from '../lib/streaming';
import { RAGOrchestrator } from '../lib/rag/rag-orchestrator';
import { getLLMService, disposeBrowserEngine } from '../lib/llm/llm-factory';
import { ensureReadinessGateChecked } from '../lib/llm/readiness-gate';
import type { AttachedImage } from '../lib/processing/image-input';
import { presetOptions } from '../lib/rag/rag-presets';
import { downloadConversation } from '../lib/export/conversation-export';
import { messagesForRegenerate } from '../lib/chat/message-ops';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export interface ChatPageProps {
  messages: ChatMessage[];
  onMessagesChange: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  onSaveConversation: (messages: ChatMessage[], mode: 'server' | 'wllama', modelUsed: string) => void;
  onNewChat: () => void;
}

export function ChatPage(props: ChatPageProps) {
  return <ChatPageInner {...props} />;
}

const exportButtonStyle: CSSProperties = {
  backgroundColor: 'transparent',
  color: 'var(--color-text-muted)',
  border: '1px solid var(--color-text-muted)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--spacing-xs) var(--spacing-sm)',
  fontSize: 'var(--font-size-caption)',
  fontFamily: 'var(--font-family)',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
};

function ChatPageInner({ messages: messagesProp, onMessagesChange, onSaveConversation, onNewChat }: ChatPageProps) {
  const MAX_MESSAGES = 200;
  const { mode, browserEngine, ragPreset, isModelReady, isServerConnected, modelLoadingProgress, serverUrl } = useInferenceMode();
  const messages = messagesProp;
  const setMessages = onMessagesChange;
  const [isLoading, setIsLoading] = useState(false);
  const [clearConfirmState, setClearConfirmState] = useState<'idle' | 'confirming'>('idle');
  const tokenStreamManagerRef = useRef<TokenStreamManager | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last sent turn (text + raw image bytes) so Regenerate can re-run it.
  const lastTurnRef = useRef<{ text: string; images?: AttachedImage[] } | null>(null);

  // Mirror of the current messages so async callbacks (onDone/onError) can read
  // the latest array without placing side effects inside a state updater.
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const isBrowserMode = mode === 'browser-local';
  const isModelBlocked = isBrowserMode && !isModelReady;
  const isInputDisabled = isLoading || isModelBlocked;
  // Image upload is supported by the multimodal wllama engine in browser-local mode.
  const canAttachImages = isBrowserMode && browserEngine === 'wllama' && isModelReady;

  // Evaluate model readiness for the selected engine when entering browser-local
  // mode or switching engines. This drives `isModelReady` (and the input gate)
  // engine-awarely — e.g. wllama unblocks on no-WebGPU hardware once its packaged
  // model is present, without waiting for a (blocked) first query.
  useEffect(() => {
    if (mode === 'browser-local') {
      void ensureReadinessGateChecked(browserEngine);
    }
  }, [mode, browserEngine]);

  // Dispose the old engine heap when the user switches engines.
  // Effect cleanup closes over the current (old) engine value, so it runs
  // with the previous engine on each change and on unmount.
  useEffect(() => {
    return () => {
      if (mode === 'browser-local') {
        disposeBrowserEngine(browserEngine);
      }
    };
  }, [mode, browserEngine]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clearTimeoutRef.current !== null) {
        clearTimeout(clearTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (tokenStreamManagerRef.current !== null) {
        tokenStreamManagerRef.current.dispose();
        tokenStreamManagerRef.current = null;
      }
    };
  }, []);

  // Run a query for an existing assistant placeholder message. Shared by send +
  // regenerate. `images` carry the raw bytes (not stored on ChatMessage), so
  // regenerate captures them via lastTurnRef.
  const runGeneration = useCallback((
    text: string,
    images: AttachedImage[] | undefined,
    assistantMessageId: string
  ) => {
    // Create TokenStreamManager for this request
    const streamManager = new TokenStreamManager();
    tokenStreamManagerRef.current = streamManager;

    // Wire token callback - append tokens to assistant message.
    // Compute the next array from messagesRef (the always-current mirror),
    // commit it to the ref synchronously, and set state with the value form
    // (no updater function) so React never double-invokes a side-effect.
    streamManager.onToken((token) => {
      const next = messagesRef.current.map((msg) =>
        msg.id === assistantMessageId
          ? { ...msg, content: msg.content + token, timestamp: Date.now() }
          : msg
      );
      messagesRef.current = next;
      setMessages(next);
    });

    // Wire done callback - finalize message with sources.
    // TokenStreamManager.complete() flushes the token buffer (firing onToken)
    // and then invokes onDone synchronously in the same call stack, so
    // messagesRef.current already reflects every streamed token here.
    streamManager.onDone((data) => {
      const updated = messagesRef.current.map((msg) =>
        msg.id === assistantMessageId
          ? { ...msg, isStreaming: false, sources: data.sources }
          : msg
      );
      messagesRef.current = updated;
      setMessages(updated);
      // Save to Dexie after stream completes
      onSaveConversation(updated, mode === 'api' ? 'server' : 'wllama', browserEngine);
      if (tokenStreamManagerRef.current === streamManager) {
        setIsLoading(false);
        tokenStreamManagerRef.current = null;
      }
    });

    // Wire error callback. Like onDone, onError fires synchronously after
    // flushBuffer() inside TokenStreamManager.error(), so read from the ref.
    streamManager.onError((errorMessage) => {
      const updated = messagesRef.current.map((msg) =>
        msg.id === assistantMessageId
          ? { ...msg, content: msg.content + `\n[Error: ${errorMessage}]`, isStreaming: false }
          : msg
      );
      messagesRef.current = updated;
      setMessages(updated);
      if (tokenStreamManagerRef.current === streamManager) {
        setIsLoading(false);
        tokenStreamManagerRef.current = null;
      }
    });

    if (mode === 'api') {
      // Server API mode — SSE streaming via /ask/stream endpoint
      const url = serverUrl ? `${serverUrl.replace(/\/$/, '')}/ask/stream` : '/ask/stream';
      streamManager.startSSEStream(url, { question: text }, undefined);
    } else {
      // Browser-local mode — RAG pipeline AsyncGenerator
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const orchestrator = new RAGOrchestrator({ llmService: getLLMService(browserEngine) });
      let fullAnswer = '';
      const startTime = Date.now();
      let sources: string[] = [];

      (async () => {
        try {
          for await (const event of orchestrator.query(text, {
            ...presetOptions(ragPreset),
            signal: abortController.signal,
            images: images?.map((img) => ({ data: img.data, mimeType: img.mimeType })),
          })) {
            if (abortController.signal.aborted) return;
            if (tokenStreamManagerRef.current !== streamManager) return;

            switch (event.type) {
              case 'token':
                fullAnswer += event.data;
                streamManager.pushToken(event.data);
                break;
              case 'complete':
                sources = event.data.sources;
                streamManager.complete({
                  sources,
                  contextLength: fullAnswer.length,
                  inferenceTime: Date.now() - startTime,
                });
                break;
              case 'error':
                streamManager.error(event.data.message);
                return;
            }
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return; // User cancelled — no error message needed
          }
          const message = error instanceof Error ? error.message : 'RAG pipeline failed';
          streamManager.error(message);
        }
      })();
    }
  }, [mode, serverUrl, browserEngine, ragPreset, onSaveConversation]);

  const handleSend = useCallback((text: string, attachedImages?: AttachedImage[]) => {
    // Prevent overlapping streams
    if (tokenStreamManagerRef.current) return;

    // Capture the turn so Regenerate can re-run it (images carry raw bytes).
    lastTurnRef.current = { text, images: attachedImages };

    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      images: attachedImages?.map((img) => ({
        id: img.id,
        dataUrl: img.dataUrl,
        mimeType: img.mimeType,
        fileName: img.fileName,
      })),
    };

    const assistantMessageId = generateId();
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    const appended = [...messagesRef.current, userMessage, assistantMessage];
    if (appended.length > MAX_MESSAGES) {
      const pruned = appended.slice(appended.length - MAX_MESSAGES);
      const indicator: ChatMessage = {
        id: 'hidden-messages-indicator',
        role: 'system',
        content: `Earlier messages have been hidden (max ${MAX_MESSAGES} shown).`,
        timestamp: Date.now(),
      };
      messagesRef.current = [indicator, ...pruned];
    } else {
      messagesRef.current = appended;
    }
    setMessages(messagesRef.current);
    setIsLoading(true);
    runGeneration(text, attachedImages, assistantMessageId);
  }, [runGeneration]);

  // Re-run the most recent user turn, replacing the last assistant response.
  const handleRegenerate = useCallback(() => {
    if (tokenStreamManagerRef.current) return; // a stream is in flight
    const last = lastTurnRef.current;
    if (!last) return;

    const assistantMessageId = generateId();
    const regenerated = messagesForRegenerate(messagesRef.current, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    });
    messagesRef.current = regenerated;
    setMessages(regenerated);
    setIsLoading(true);
    runGeneration(last.text, last.images, assistantMessageId);
  }, [runGeneration]);

  // Cancel any in-flight stream and release its resources. Shared by the
  // explicit Cancel button, Clear Chat, and the external New Chat path
  // (sidebar) which clears messages without going through ChatPage.
  const cancelActiveStream = useCallback(() => {
    if (tokenStreamManagerRef.current) {
      tokenStreamManagerRef.current.cancel();
      tokenStreamManagerRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
  }, []);

  const handleCancel = useCallback(() => {
    cancelActiveStream();

    // Mark any streaming messages as complete
    const finalized = messagesRef.current.map((msg) =>
      msg.isStreaming ? { ...msg, isStreaming: false } : msg
    );
    messagesRef.current = finalized;
    setMessages(finalized);
  }, [cancelActiveStream]);

  // If messages are cleared while a stream is in flight (e.g. the sidebar
  // "New Chat" button calls newChat() in App, which empties currentMessages
  // without going through ChatPage), cancel the orphaned stream so its
  // callbacks don't fire against the cleared state and resources are released.
  // Only react to a non-empty → empty transition so this never cancels a
  // stream that was started while the view was already empty (e.g. the render
  // window between handleSend setting the stream ref and the messages prop
  // updating).
  const prevMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    const prev = prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = messages.length;
    if (prev > 0 && messages.length === 0 && tokenStreamManagerRef.current) {
      cancelActiveStream();
    }
  }, [messages.length, cancelActiveStream]);

  const handleClearClick = useCallback(() => {
    if (clearConfirmState === 'idle') {
      setClearConfirmState('confirming');
      clearTimeoutRef.current = setTimeout(() => {
        setClearConfirmState('idle');
        clearTimeoutRef.current = null;
      }, 3000);
    } else if (clearConfirmState === 'confirming') {
      // Second click - clear messages
      if (clearTimeoutRef.current !== null) {
        clearTimeout(clearTimeoutRef.current);
        clearTimeoutRef.current = null;
      }
      // Cancel any in-flight stream so its callbacks don't fire against the
      // cleared state and resources are released immediately.
      cancelActiveStream();
      setMessages([]);
      messagesRef.current = [];
      onNewChat();
      lastTurnRef.current = null; // no turn to regenerate after clearing
      setClearConfirmState('idle');
    }
  }, [clearConfirmState, cancelActiveStream, onNewChat]);

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onClearChat: handleClearClick,
    onOpenSettings: () => {
      // Navigation handled at App level
    },
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: 'var(--color-bg)',
        position: 'relative',
      }}
    >
      {/* Header */}
      <header
        aria-label="Chat controls"
        style={{
          padding: 'var(--spacing-sm) var(--spacing-md)',
          borderBottom: '1px solid var(--color-bubble-system)',
          backgroundColor: 'var(--color-surface)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          position: 'relative',
          zIndex: 101,
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)' }}>
          {/* API mode warning */}
          {mode === 'api' && !isServerConnected && (
            <span
              title="Server not connected. Check your server URL in Settings."
              style={{
                fontSize: 'var(--font-size-caption)',
                color: 'var(--color-warning)',
                fontFamily: 'var(--font-family)',
              }}
            >
              Server not connected
            </span>
          )}
          {messages.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => downloadConversation(messages, 'markdown')}
                title="Export conversation as Markdown"
                aria-label="Export conversation as Markdown"
                style={exportButtonStyle}
              >
                Export
              </button>
              <button
                type="button"
                onClick={handleClearClick}
                disabled={isLoading}
                title={isLoading ? 'Cancel the active response before clearing' : 'Clear chat'}
                style={{
                  backgroundColor: clearConfirmState === 'confirming' ? 'var(--color-danger)' : 'transparent',
                  color: clearConfirmState === 'confirming' ? 'var(--color-text-on-primary)' : 'var(--color-text-muted)',
                  border: clearConfirmState === 'confirming' ? 'none' : '1px solid var(--color-text-muted)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 'var(--spacing-xs) var(--spacing-sm)',
                  fontSize: 'var(--font-size-caption)',
                  fontFamily: 'var(--font-family)',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  opacity: isLoading ? 0.6 : 1,
                  transition: 'all 0.15s ease',
                }}
              >
                {clearConfirmState === 'confirming' ? 'Confirm Clear?' : 'Clear Chat'}
              </button>
            </>
          )}
          <InferenceModeToggle />
        </div>
      </header>

      {/* Model loading blocking overlay */}
      {isModelBlocked && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            style={{
backgroundColor: 'var(--color-surface)',
              padding: 'var(--spacing-xl)',
              borderRadius: '8px',
              textAlign: 'center',
              maxWidth: '400px',
            }}
          >
            <p
              style={{
                fontSize: 'var(--font-size-body)',
                color: 'var(--color-text-on-bubble-assistant)',
                fontFamily: 'var(--font-family)',
                marginBottom: 'var(--spacing-md)',
              }}
            >
              Model not loaded. Please wait for the model to download and initialize.
            </p>
            {modelLoadingProgress > 0 && (
              <div
                style={{
                  width: '100%',
                  height: '8px',
                  backgroundColor: 'var(--color-bubble-system)',
  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${modelLoadingProgress}%`,
                    height: '100%',
                    backgroundColor: '#22c55e',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            )}
            <p
              style={{
                fontSize: 'var(--font-size-caption)',
                color: 'var(--color-text-muted)',
                fontFamily: 'var(--font-family)',
                marginTop: 'var(--spacing-sm)',
              }}
            >
              {modelLoadingProgress > 0 ? `${modelLoadingProgress}%` : 'Loading...'}
            </p>
          </div>
        </div>
      )}

      {/* Message List */}
      <ChatMessageList
        messages={messages}
        isStreaming={isLoading}
        onRegenerate={!isLoading && lastTurnRef.current ? handleRegenerate : undefined}
        onSuggestedPrompt={(prompt) => handleSend(prompt)}
      />

      {/* Streaming Indicator */}
      <div
        style={{
          padding: 'var(--spacing-xs) var(--spacing-lg)',
          minHeight: '28px',
        }}
      >
        <StreamingIndicator isVisible={isLoading} />
      </div>

      {/* Input */}
      <ChatInput
        onSend={handleSend}
        isLoading={isLoading}
        onCancel={handleCancel}
        disabled={isInputDisabled}
        imageUploadEnabled={canAttachImages}
      />
    </div>
  );
}
