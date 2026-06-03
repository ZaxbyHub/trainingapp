/**
 * Chat page component - primary user interface for document Q&A.
 * Displays messages, renders markdown, and supports streaming responses.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage } from '../types/chat';
import { ChatMessageList } from '../components/ChatMessageList';
import { ChatInput } from '../components/ChatInput';
import { StreamingIndicator } from '../components/StreamingIndicator';
import { useInferenceMode } from '../lib/inference';
import { InferenceModeToggle } from '../components/InferenceModeToggle';
import { TokenStreamManager } from '../lib/streaming';
import { RAGOrchestrator } from '../lib/rag/rag-orchestrator';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function ChatPage() {
  return <ChatPageInner />;
}

function ChatPageInner() {
  const MAX_MESSAGES = 200;
  const { mode, isModelReady, isServerConnected, modelLoadingProgress, serverUrl } = useInferenceMode();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [clearConfirmState, setClearConfirmState] = useState<'idle' | 'confirming'>('idle');
  const tokenStreamManagerRef = useRef<TokenStreamManager | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isBrowserMode = mode === 'browser-local';
  const isModelBlocked = isBrowserMode && !isModelReady;
  const isInputDisabled = isLoading || isModelBlocked;

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

  const handleSend = useCallback((text: string) => {
    // Prevent overlapping streams
    if (tokenStreamManagerRef.current) return;

    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    const assistantMessageId = generateId();
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setMessages((prev) => {
      if (prev.length > MAX_MESSAGES) {
        const pruned = prev.slice(prev.length - MAX_MESSAGES);
        // Prepend a system indicator about hidden messages
        const indicator: ChatMessage = {
          id: 'hidden-messages-indicator',
          role: 'system',
          content: `Earlier messages have been hidden (max ${MAX_MESSAGES} shown).`,
          timestamp: Date.now(),
        };
        return [indicator, ...pruned];
      }
      return prev;
    });
    setIsLoading(true);

    // Create TokenStreamManager for this request
    const streamManager = new TokenStreamManager();
    tokenStreamManagerRef.current = streamManager;

    // Wire token callback - append tokens to assistant message
    streamManager.onToken((token) => {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? { ...msg, content: msg.content + token, timestamp: Date.now() }
            : msg
        )
      );
    });

    // Wire done callback - finalize message with sources
    streamManager.onDone((data) => {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? { ...msg, isStreaming: false, sources: data.sources }
            : msg
        )
      );
      if (tokenStreamManagerRef.current === streamManager) {
        setIsLoading(false);
        tokenStreamManagerRef.current = null;
      }
    });

    // Wire error callback
    streamManager.onError((errorMessage) => {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? { ...msg, content: msg.content + `\n[Error: ${errorMessage}]`, isStreaming: false }
            : msg
        )
      );
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

      const orchestrator = new RAGOrchestrator();
      let fullAnswer = '';
      const startTime = Date.now();
      let sources: string[] = [];

      (async () => {
        try {
          for await (const event of orchestrator.query(text, { signal: abortController.signal })) {
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
          const message = error instanceof Error ? error.message : 'RAG pipeline failed';
          streamManager.error(message);
        }
      })();
    }
  }, [mode, serverUrl]);

  const handleCancel = useCallback(() => {
    // Cancel via TokenStreamManager
    if (tokenStreamManagerRef.current) {
      tokenStreamManagerRef.current.cancel();
      tokenStreamManagerRef.current = null;
    }

    // Also abort any pending AbortController
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Mark any streaming messages as complete
    setMessages((prev) =>
      prev.map((msg) => (msg.isStreaming ? { ...msg, isStreaming: false } : msg))
    );
    setIsLoading(false);
  }, []);

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
      setMessages([]);
      setClearConfirmState('idle');
    }
  }, [clearConfirmState]);

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
        backgroundColor: 'var(--color-bubble-assistant)',
        position: 'relative',
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: 'var(--spacing-md) var(--spacing-lg)',
          borderBottom: '1px solid var(--color-bubble-system)',
          backgroundColor: 'var(--color-bubble-assistant)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'relative',
          zIndex: 101,
        }}
      >
        <h1
          style={{
            fontSize: 'var(--font-size-h2)',
            fontFamily: 'var(--font-family)',
            fontWeight: 600,
            color: 'var(--color-text-on-bubble-assistant)',
            margin: 0,
          }}
        >
          Document Q&A
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)' }}>
          {/* API mode warning */}
          {mode === 'api' && !isServerConnected && (
            <span
              title="Server not connected. Check your server URL in Settings."
              style={{
                fontSize: 'var(--font-size-caption)',
                color: '#eab308',
                fontFamily: 'var(--font-family)',
              }}
            >
              Server not connected
            </span>
          )}
          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleClearClick}
              style={{
                backgroundColor: clearConfirmState === 'confirming' ? '#dc3545' : 'transparent',
                color: clearConfirmState === 'confirming' ? '#fff' : 'var(--color-text-muted)',
                border: clearConfirmState === 'confirming' ? 'none' : '1px solid var(--color-text-muted)',
                borderRadius: '4px',
                padding: 'var(--spacing-xs) var(--spacing-sm)',
                fontSize: 'var(--font-size-caption)',
                fontFamily: 'var(--font-family)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {clearConfirmState === 'confirming' ? 'Confirm Clear?' : 'Clear Chat'}
            </button>
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
              backgroundColor: 'var(--color-bubble-assistant)',
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
                  borderRadius: '4px',
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
      <ChatMessageList messages={messages} isStreaming={isLoading} />

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
      <ChatInput onSend={handleSend} isLoading={isLoading} onCancel={handleCancel} disabled={isInputDisabled} />
    </div>
  );
}
