/**
 * Chat page component - primary user interface for document Q&A.
 * Displays messages, renders markdown, and supports streaming responses.
 */

import { useState, useCallback, useRef, useEffect, type CSSProperties } from 'react';
import type { ChatMessage } from '../types/chat';
import { ChatMessageList } from '../components/ChatMessageList';
import { ChatInput } from '../components/ChatInput';
import { StreamingIndicator } from '../components/StreamingIndicator';
import { ModelBlockedOverlay } from '../components/ModelBlockedOverlay';
import { useInferenceMode } from '../lib/inference';
import { InferenceModeToggle } from '../components/InferenceModeToggle';
import { TokenStreamManager } from '../lib/streaming';
import { RAGOrchestrator } from '../lib/rag/rag-orchestrator';
import { getLLMService } from '../lib/llm/llm-factory';
import { ensureReadinessGateChecked, getReadinessResultSnapshot, resetReadinessCache } from '../lib/llm/readiness-gate';
import { WEBLLM_DEFAULT_MODEL_ID } from '../lib/llm/web-llm-service';
import { LLM_MODEL_DIR } from '../lib/models/model-manifest';
import { getToken } from '../lib/api/auth';
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
  /** Navigate to the Settings page (wired from App). Used by the model-block
   *  overlay's "Open Settings" button and the Ctrl+, shortcut. */
  onOpenSettings: () => void;
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

function ChatPageInner({ messages: messagesProp, onMessagesChange, onSaveConversation, onNewChat, onOpenSettings }: ChatPageProps) {
  const MAX_MESSAGES = 200;
  const { mode, browserEngine, ragPreset, isModelReady, isServerConnected, modelLoadingProgress, serverUrl, setModelLoadingProgress } = useInferenceMode();
  const messages = messagesProp;
  const setMessages = onMessagesChange;
  const [isLoading, setIsLoading] = useState(false);
  const [clearConfirmState, setClearConfirmState] = useState<'idle' | 'confirming'>('idle');
  const tokenStreamManagerRef = useRef<TokenStreamManager | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last sent turn (text + raw image bytes) so Regenerate can re-run it.
  const lastTurnRef = useRef<{ text: string; images?: AttachedImage[] } | null>(null);
  // Current input draft, mirrored from ChatInput so the Ctrl+Enter shortcut can
  // send it without ChatPage owning the textarea state.
  const draftRef = useRef('');

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

  // Abort any in-flight generation on a genuine engine switch — NOT on unmount.
  // Disposal of the OLD engine singleton itself now lives in
  // InferenceModeContext's setBrowserEngine, since that context is mounted for
  // the app's entire lifetime and survives ChatPage unmount/remount — whereas
  // this component only sees an engine change on the rare occasion it stays
  // mounted across one (in practice, engine changes happen from SettingsPage,
  // which unmounts ChatPage first). Kept here defensively, but note the actual
  // ordering: setBrowserEngine's disposeBrowserEngine() call runs synchronously
  // in the SettingsPage onClick/onChange handler, BEFORE React even schedules a
  // re-render — so it runs BEFORE this effect, not after. This abort only fires
  // once React commits the re-render and flushes effects, i.e. AFTER dispose
  // has already happened. That ordering doesn't currently cause a crash because
  // WllamaService's and WebLLMService's dispose paths are self-guarding against
  // being called while a generation or init is still in flight — but that's a
  // property of those services, not an ordering guarantee provided here. (PR #28
  // PRR-010, issue #21 F-LEAK; Stage B review corrected the prior inaccurate
  // "BEFORE the context's dispose call runs" claim)
  //
  // Declared BEFORE the readiness effect below so on an engine switch React
  // runs this effect's body (abort old) before re-checking readiness for the
  // new engine.
  const prevEngineRef = useRef(browserEngine);
  useEffect(() => {
    const prev = prevEngineRef.current;
    prevEngineRef.current = browserEngine;
    if (mode === 'browser-local' && prev !== browserEngine) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (tokenStreamManagerRef.current) {
        tokenStreamManagerRef.current.cancel();
        tokenStreamManagerRef.current = null;
      }
      setIsLoading(false);
    }
  }, [browserEngine, mode]);

  // Evaluate model readiness for the selected engine when entering browser-local
  // mode or switching engines. This drives `isModelReady` (and the input gate)
  // engine-awarely — e.g. wllama unblocks on no-WebGPU hardware once its packaged
  // model is present, without waiting for a (blocked) first query.
  useEffect(() => {
    if (mode === 'browser-local') {
      void ensureReadinessGateChecked(browserEngine);
    }
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
          ? {
              ...msg,
              isStreaming: false,
              sources: data.sources,
              // Structured citations from the retrieved chunks (F7). Map
              // explicitly to CitationRef so the retrieval-only `score` field
              // is not persisted into the message / Dexie (PRR-008), and keep
              // the array in context order so pill [i+1] maps to chunks[i].
              citations: data.chunks?.map((c) => ({
                docId: c.docId,
                chunkIndex: c.chunkIndex,
                source: c.source,
                page: c.page,
                text: c.text,
              })),
              abstain: data.abstain,
              abstainReason: data.abstainReason,
              retrievalDegraded: data.retrievalDegraded,
            }
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
      // Server API mode — SSE streaming via /ask/stream endpoint.
      // Pass the stored auth token when present so server mode works whether
      // auth is off (default) or on. Wrap setup so a synchronous throw (e.g.
      // URL validation) routes to onError and clears the stream ref instead of
      // wedging the send pipeline permanently. (issue #21 F5, F9)
      const url = serverUrl ? `${serverUrl.replace(/\/$/, '')}/ask/stream` : '/ask/stream';
      try {
        streamManager.startSSEStream(url, { question: text }, getToken() ?? undefined);
      } catch (err) {
        streamManager.error(err instanceof Error ? err.message : String(err));
      }
    } else {
      // Browser-local mode — RAG pipeline AsyncGenerator.
      // The LLM service singleton is fetched uninitialized from the factory; we
      // MUST initialize it before the orchestrator calls generate(), otherwise
      // generate() throws "not initialized" and the assistant bubble shows the
      // raw error (issue #21 F1). initialize() is idempotent — fast no-op when
      // the model is already loaded — so calling it on every send is safe.
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const llmService = getLLMService(browserEngine);
      const initModelId = browserEngine === 'wllama' ? LLM_MODEL_DIR : WEBLLM_DEFAULT_MODEL_ID;

      (async () => {
        try {
          // Ensure the model is loaded before the pipeline touches generate().
          // Route real load progress into the overlay so a cold first send shows
          // progress instead of an apparent hang.
          setModelLoadingProgress(0);
          await llmService.initialize(initModelId, (p) => {
            if (tokenStreamManagerRef.current !== streamManager) return;
            setModelLoadingProgress(Math.min(100, Math.max(0, Math.round((p.progress ?? 0) * 100))));
          });
          if (abortController.signal.aborted) return;
          if (tokenStreamManagerRef.current !== streamManager) return;

          const orchestrator = new RAGOrchestrator({ llmService });
          let fullAnswer = '';
          const startTime = Date.now();
          let sources: string[] = [];

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
                  chunks: event.data.chunks,
                  abstain: event.data.abstain,
                  abstainReason: event.data.abstainReason,
                  retrievalDegraded: event.data.retrievalDegraded,
                  contextTrimmed: event.data.contextTrimmed,
                  contextLength: fullAnswer.length,
                  inferenceTime: Date.now() - startTime,
                });
                break;
              case 'error': {
                // Only embedding/generation failures are fatal. The orchestrator
                // treats vector/keyword/rerank/rrf errors as recoverable (it
                // yields the error and continues); mirror that here so a single
                // retrieval hiccup doesn't kill a response that could degrade
                // gracefully (issue #21 F11).
                const stage = (event.data as { stage?: string }).stage;
                if (stage === 'embedding' || stage === 'generation') {
                  streamManager.error((event.data as { message: string }).message);
                  return;
                }
                console.warn(
                  `[ChatPage] Recoverable RAG stage failed: ${stage}`,
                  (event.data as { message?: string }).message
                );
                break;
              }
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
  }, [mode, serverUrl, browserEngine, ragPreset, onSaveConversation, setModelLoadingProgress]);

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

  // Keyboard shortcuts — ChatPage registers the chat-scoped set (send/clear-chat
  // plus its own Ctrl+, handling for the model-blocked overlay's Open Settings
  // affordance). App.tsx's AppContent ALSO registers useKeyboardShortcuts with
  // only `onOpenSettings`, at the root, so Ctrl+, works from every page — while
  // on the Chat page there are therefore two window keydown listeners, and both
  // fire on Ctrl+,, but `openSettings` is idempotent (`setCurrentPage('settings')`
  // called twice with the same value), so the double-firing is harmless.
  // Ctrl+Enter sends the current draft; Ctrl+L clears; Ctrl+, opens Settings.
  useKeyboardShortcuts({
    onSendMessage: () => {
      const draft = draftRef.current.trim();
      // Mirror the ChatInput Send button's guard so Ctrl+Enter can't bypass
      // the model-blocked overlay or send while a response is in flight.
      // (PR #28 F-CTRL-ENTER-BYPASS)
      if (draft && !tokenStreamManagerRef.current && !isInputDisabled) {
        handleSend(draft);
      }
    },
    onClearChat: handleClearClick,
    onOpenSettings,
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
        <div className="chat-header-actions" style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)' }}>
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

      {/* Model loading blocking overlay.
          Engine-aware: shows the actual readiness failures/recommendations
          instead of a generic "please wait for download" message (which is
          actively wrong for wllama, where there is no download step — the real
          cause is usually missing packaged weights). Offers Retry and Open
          Settings actions. Extracted into ModelBlockedOverlay (issue #25) which
          adds aria-modal + a focus trap. (originally issue #21 F10) */}
      {isModelBlocked && (
        <ModelBlockedOverlay
          readinessResult={getReadinessResultSnapshot()}
          browserEngine={browserEngine}
          modelLoadingProgress={modelLoadingProgress}
          onRetry={() => {
            resetReadinessCache();
            void ensureReadinessGateChecked(browserEngine);
          }}
          onOpenSettings={onOpenSettings}
        />
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
        onDraftChange={(text) => { draftRef.current = text; }}
      />
    </div>
  );
}
