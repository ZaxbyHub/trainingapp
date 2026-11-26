/**
 * Tests for ChatPage RAG Pipeline Integration - ChatPage.rag.test.tsx
 *
 * Tests the integration between ChatPage and RAGOrchestrator.query() AsyncGenerator:
 * - handleSend creates RAGOrchestrator and calls query() with user text
 * - Token events are pushed to TokenStreamManager (pushToken called for each)
 * - Complete event passes sources to TokenStreamManager.complete()
 * - Error event calls TokenStreamManager.error() with message
 * - User message and empty assistant message are added to state
 * - Loading state surfaces an observable busy signal while streaming and
 *   clears via the terminal done handler
 * - Cancellation via handleCancel aborts the controller and cancels stream
 * - Multiple rapid sends (second message while first streaming)
 * - Sources from complete event are stored in message
 *
 * Boundary mocks mirror the green sibling page specs
 * (ChatPage.first-turn-done.test.tsx / ChatPage.keyboard-wiring.test.tsx):
 * ChatPage transitively pulls native-ESM deps (rag-orchestrator -> vector-index
 * -> edgevec) and the packaged-model gate (the REAL WllamaService.initialize
 * throws "Browser LLM not packaged" when no GGUF is staged), so every such
 * edge is mocked before the component import — getLLMService resolves
 * immediately and the orchestrator/stream-manager are the test seams.
 *
 * Persistence lifecycle: production saves TWICE per turn — the send-time save
 * (user turn + streaming placeholder, ChatPage.tsx:1201-1217) and the terminal
 * done save (finalized thread, ChatPage.tsx:803-804). Assertions target the
 * LAST call for finalized content and account for the send-time call
 * explicitly.
 *
 * ChatPage is fully CONTROLLED (ChatPage.tsx:240-241): the messages prop is
 * the only source of truth, so tests that assert rendered user/assistant
 * bubbles use the stateful Harness below instead of `messages={[]}` + no-op
 * setter.
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// Import modules to get typed mocks
import * as ragModule from '../lib/rag/rag-orchestrator';
import * as inferenceModule from '../lib/inference';
import * as streamingModule from '../lib/streaming';

// Shared mock instance to track calls
let mockStreamManagerInstance: {
  onToken: ReturnType<typeof vi.fn>;
  onDone: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  pushToken: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  startSSEStream: ReturnType<typeof vi.fn>;
  setFirstByteTimeoutMs: ReturnType<typeof vi.fn>;
};

// Mock modules BEFORE importing the component under test
vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(function () {
    return {
      query: vi.fn(),
    };
  }),
}));

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

// Browser-local boundary: the REAL WllamaService.initialize throws
// "Browser LLM not packaged — missing: /models/llm/lfm2-1.2b-rag/model.gguf"
// in vitest (no GGUF staged), which ChatPage catches and routes to
// streamManager.error BEFORE the orchestrator is ever constructed
// (ChatPage.tsx:1022 -> :1045). Mocking the factory boundary lets the RAG
// pipeline legs run. The extra exports are imported by
// src/lib/llm/readiness-gate.ts:11 and src/lib/inference/InferenceModeContext.tsx:16.
vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(),
    dispose: vi.fn(),
  })),
  DEFAULT_BROWSER_ENGINE: 'wllama',
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn(() => 'wllama'),
}));

vi.mock('../lib/llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn().mockResolvedValue(null),
  getReadinessResultSnapshot: vi.fn(() => null),
  resetReadinessCache: vi.fn(),
}));

// ChatMessageList reads useDocumentCount(), whose real store touches
// indexedDB (absent in jsdom) — the caught "indexedDB is not defined" error
// spams the console. Mock the hook (ChatPage.keyboard-wiring.test.tsx:56-58
// pattern) to keep the spec hermetic.
vi.mock('../hooks/useDocumentCount', () => ({
  useDocumentCount: () => ({ count: 3, loading: false }),
}));

vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(function () {
    mockStreamManagerInstance = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      pushToken: vi.fn(),
      complete: vi.fn(),
      error: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
      // Production calls these on the api-mode legs (ChatPage.tsx:935,947;
      // TokenStreamManager.ts:85,237). Unused on the browser-local legs below
      // but part of the manager's surface.
      startSSEStream: vi.fn(),
      setFirstByteTimeoutMs: vi.fn(),
    };
    return mockStreamManagerInstance;
  }),
}));

// Import after mocks are set up
import { ChatPage } from './ChatPage';

// Re-export RAGEvent type for test helper
export type { RAGEvent } from '../lib/rag/rag-orchestrator';
import type { RAGEvent } from '../lib/rag/rag-orchestrator';
import type { ChatMessage } from '../types/chat';

/**
 * Helper: Create a controlled AsyncGenerator that yields RAGEvents
 */
async function* mockRAGEvents(events: RAGEvent[]): AsyncGenerator<RAGEvent> {
  for (const event of events) {
    yield event;
  }
}

/**
 * Stateful stand-in for App: ChatPage is fully CONTROLLED — the messages prop
 * is the only source of truth (ChatPage.tsx:240-241) — so any test that
 * asserts rendered user/assistant bubbles must let onMessagesChange write
 * back into this holder, exactly like the real shell does.
 */
function Harness({
  onSaveConversation = () => {},
  onNewChat = () => {},
  registerControls,
}: {
  onSaveConversation?: React.ComponentProps<typeof ChatPage>['onSaveConversation'];
  onNewChat?: () => void;
  registerControls?: (controls: {
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  }) => void;
}) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  registerControls?.({ setMessages });
  return (
    <ChatPage
      messages={messages}
      onMessagesChange={setMessages}
      onSaveConversation={onSaveConversation}
      onNewChat={onNewChat}
      currentConversationId={undefined}
      setCurrentConversationId={() => {}}
      onOpenSettings={() => {}}
    />
  );
}

// --- Test Suite ---

describe('ChatPage RAG Pipeline Integration', () => {
  let mockOrchestratorInstance: {
    query: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock instance
    mockStreamManagerInstance = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      pushToken: vi.fn(),
      complete: vi.fn(),
      error: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
      startSSEStream: vi.fn(),
      setFirstByteTimeoutMs: vi.fn(),
    };

    // Re-setup the mock implementation to return our fresh instance
    vi.mocked(streamingModule.TokenStreamManager).mockImplementation(function () {
      return mockStreamManagerInstance as unknown as streamingModule.TokenStreamManager;
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Create mock orchestrator instance
    mockOrchestratorInstance = {
      query: vi.fn(),
    };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(() => mockOrchestratorInstance as unknown as ragModule.RAGOrchestrator);

    // Setup useInferenceMode mock — every field ChatPage destructures
    // (ChatPage.tsx:193: mode, browserEngine, ragPreset, isModelReady,
    // isServerConnected, modelLoadingProgress, setModelLoadingProgress).
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: true,
      isServerConnected: true,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Helper to submit a message via the Send button
  const submitMessage = (text: string) => {
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: text } });
    const sendButton = screen.getByRole('button', { name: /send message/i });
    fireEvent.click(sendButton);
  };

  // ========================================================================
  // TEST 1: handleSend creates RAGOrchestrator and calls query() with user text
  // ========================================================================
  test('handleSend creates RAGOrchestrator and calls query() with user text', async () => {
    const userText = 'What is machine learning?';
    const events: RAGEvent[] = [
      { type: 'complete', data: { answer: 'ML is great.', sources: ['doc-1'], chunks: [], grounding: 'grounded' } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);
    submitMessage(userText);

    // Wait for the async handler to start
    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    // Verify RAGOrchestrator.query was called with user text
    expect(mockOrchestratorInstance.query).toHaveBeenCalledWith(userText, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  // ========================================================================
  // TEST 2: Token events are pushed to TokenStreamManager (pushToken called)
  // ========================================================================
  test('Token events are pushed to TokenStreamManager via pushToken', async () => {
    const userText = 'Hello?';
    const events: RAGEvent[] = [
      { type: 'token', data: 'Hello' },
      { type: 'token', data: ', ' },
      { type: 'token', data: 'world' },
      { type: 'token', data: '!' },
      { type: 'complete', data: { answer: 'Hello, world!', sources: [], chunks: [], grounding: 'grounded' } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);
    submitMessage(userText);

    // Advance timers to let the async generator consume events
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // Verify pushToken was called for each token
    expect(mockStreamManagerInstance.pushToken).toHaveBeenCalledTimes(4);
    expect(mockStreamManagerInstance.pushToken).toHaveBeenCalledWith('Hello');
    expect(mockStreamManagerInstance.pushToken).toHaveBeenCalledWith(', ');
    expect(mockStreamManagerInstance.pushToken).toHaveBeenCalledWith('world');
    expect(mockStreamManagerInstance.pushToken).toHaveBeenCalledWith('!');
  });

  // ========================================================================
  // TEST 3: Complete event passes sources to TokenStreamManager.complete()
  // ========================================================================
  test('Complete event passes sources to TokenStreamManager.complete()', async () => {
    const userText = 'Tell me about AI';
    const sources = ['doc-1', 'doc-2'];
    const events: RAGEvent[] = [
      { type: 'complete', data: { answer: 'AI is artificial intelligence.', sources, chunks: [], grounding: 'grounded' } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);
    submitMessage(userText);

    await act(async () => {
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // Verify complete was called with sources
    expect(mockStreamManagerInstance.complete).toHaveBeenCalledTimes(1);
    expect(mockStreamManagerInstance.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        sources,
      })
    );
  });

  // ========================================================================
  // TEST 4: Error event calls TokenStreamManager.error() with message
  // ========================================================================
  test('Error event calls TokenStreamManager.error() with message', async () => {
    const userText = 'What went wrong?';
    const errorMessage = 'Generation failed';
    const events: RAGEvent[] = [
      { type: 'error', data: { stage: 'generation', message: errorMessage } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);
    submitMessage(userText);

    await act(async () => {
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // Verify error was called
    expect(mockStreamManagerInstance.error).toHaveBeenCalledTimes(1);
    expect(mockStreamManagerInstance.error).toHaveBeenCalledWith(errorMessage);
  });

  // ========================================================================
  // TEST 5: User message and empty assistant message are added to state
  // ========================================================================
  test('User message and empty assistant message are added to state immediately', async () => {
    const userText = 'Hello there';
    const events: RAGEvent[] = [
      { type: 'complete', data: { answer: 'Hi!', sources: [], chunks: [], grounding: 'grounded' } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<Harness />);

    // Check initial state - no messages
    expect(screen.queryAllByText(userText)).toHaveLength(0);

    submitMessage(userText);

    // Controlled messages: the user turn + streaming assistant placeholder are
    // committed through onMessagesChange and rendered immediately, before any
    // async iteration. The user bubble is visible, the assistant answer is NOT
    // there yet (the placeholder is empty), and the turn is already busy.
    expect(screen.getByText(userText)).toBeInTheDocument();
    expect(screen.queryByText('Hi!')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop generation/i })).toBeInTheDocument();
  });

  // ========================================================================
  // TEST 6: Loading state is true during streaming, false after complete
  // Pinned through observable DOM signals: the composer swaps Send for
  // "Stop generation" while the turn is in flight (ChatInput.tsx:386-407) and
  // swaps back once the terminal done handler clears the busy state.
  // ========================================================================
  test('Loading state is true during streaming, false after complete', async () => {
    const userText = 'Loading test';
    const events: RAGEvent[] = [
      { type: 'token', data: 'Loading' },
      { type: 'token', data: '...' },
      { type: 'complete', data: { answer: 'Loading...', sources: [], chunks: [], grounding: 'grounded' } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<Harness />);
    submitMessage(userText);

    // Observable busy signal while the stream is in flight: Send is replaced
    // by Stop generation.
    expect(screen.getByRole('button', { name: /stop generation/i })).toBeInTheDocument();

    await act(async () => {
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // The RAG complete event reached the manager's complete payload...
    expect(mockStreamManagerInstance.complete).toHaveBeenCalledTimes(1);
    // ...and the terminal done handler (which the real TokenStreamManager
    // fires synchronously inside complete()) is what clears the busy state.
    expect(mockStreamManagerInstance.onDone).toHaveBeenCalledTimes(1);
    const onDoneHandler = mockStreamManagerInstance.onDone.mock.calls[0][0];
    await act(async () => {
      onDoneHandler({ sources: [], contextLength: 9, inferenceTime: 1 });
    });

    // Busy state cleared: Stop is gone, Send is back.
    expect(screen.queryByRole('button', { name: /stop generation/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
  });

  // ========================================================================
  // TEST 7: Cancellation via handleCancel aborts the controller and cancels stream
  // ========================================================================
  test('handleCancel calls TokenStreamManager.cancel() and clears loading', async () => {
    const userText = 'Cancel test';
    // Create an infinite generator to simulate streaming that needs cancellation
    async function* infiniteEvents(): AsyncGenerator<RAGEvent> {
      while (true) {
        yield { type: 'token', data: 'a' };
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(infiniteEvents());

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);
    submitMessage(userText);

    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    // Find and click cancel button (Stop button)
    const cancelButton = screen.getByRole('button', { name: /stop generation/i });
    fireEvent.click(cancelButton);

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    // Verify cancel was called on the stream manager
    expect(mockStreamManagerInstance.cancel).toHaveBeenCalled();
  });

  // ========================================================================
  // TEST 8: Multiple rapid sends are handled correctly (concurrent send guard)
  // Verifies: second rapid handleSend is ignored (not duplicated), no race on abortControllerRef
  // Uses double-submit inside single act() so DOM updates from first don't affect second's getByRole
  // ========================================================================
  test('Multiple rapid sends are handled correctly', async () => {
    const userText1 = 'First question';
    const events: RAGEvent[] = [
      { type: 'token', data: 'Answer 1' },
      { type: 'complete', data: { answer: 'Answer 1', sources: [], chunks: [], grounding: 'grounded' } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    const sendButton = screen.getByRole('button', { name: /send message/i });

    // Send the first message
    fireEvent.change(textarea, { target: { value: userText1 } });
    fireEvent.click(sendButton);

    // A genuine rapid-second-send attempt: while the first turn is in flight,
    // the Send button is UNMOUNTED (ChatInput renders Stop in its place,
    // ChatInput.tsx:386-407), so the captured ref is stale/detached and the
    // second click cannot reach a handler — the concurrent send is
    // structurally prevented.
    fireEvent.click(sendButton);

    // Advance timers (and flush microtasks) to let the first (only) async generator consume events
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // Verify: only first send processed (second ignored, not duplicated)
    expect(mockOrchestratorInstance.query).toHaveBeenCalledTimes(1);
    expect(mockOrchestratorInstance.query).toHaveBeenCalledWith(
      userText1,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    // Verify only the first send produced messages (stateful Harness — the
    // controlled messages prop is the only source of truth). The user bubble
    // carries a "Copy message" affordance; the assistant placeholder is still
    // EMPTY (isStreaming, its token sits buffered in the mocked manager —
    // ChatPage's view commit runs in the manager's token callback, not in
    // pushToken), so it renders the streaming cursor with no Copy button
    // (ChatMessageBubble.tsx:110). A duplicated second send would add a second
    // non-empty user bubble and bump this count to 2.
    expect(screen.getByText(userText1)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /copy message/i })).toHaveLength(1);

    // Verify no race condition: only one RAGOrchestrator created (hence only one abortControllerRef set inside the send path)
    expect(vi.mocked(ragModule.RAGOrchestrator)).toHaveBeenCalledTimes(1);
  });

  // ========================================================================
  // TEST 9: Sources from complete event are stored in message
  // The chain across the mocked manager boundary: the orchestrator complete
  // event carries sources into streamManager.complete() (payload assert), and
  // the terminal done handler — what the real TokenStreamManager fires with
  // that same payload — stores them on the assistant message. Asserted on the
  // RENDERED citation pills of the finalized bubble (stateful Harness).
  // ========================================================================
  test('Sources from complete event are stored in assistant message', async () => {
    const userText = 'Give me sources';
    const sources = ['doc-alpha', 'doc-beta', 'doc-gamma'];
    const events: RAGEvent[] = [
      { type: 'complete', data: { answer: 'Here are sources.', sources, chunks: [], grounding: 'grounded' } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<Harness />);
    submitMessage(userText);

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // The complete payload carried the orchestrator's sources...
    expect(mockStreamManagerInstance.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        sources,
      })
    );

    // ...and the registered done handler stores them on the assistant
    // message. Fire it the way the real TokenStreamManager.complete() does:
    // synchronously, with the complete payload as the done data.
    expect(mockStreamManagerInstance.onDone).toHaveBeenCalledTimes(1);
    const onDoneHandler = mockStreamManagerInstance.onDone.mock.calls[0][0];
    await act(async () => {
      onDoneHandler({ sources, chunks: [], grounding: 'grounded', contextLength: 17, inferenceTime: 1 });
    });

    // The sources render as citation pills (Source 1..N) on the bubble.
    for (let i = 1; i <= sources.length; i++) {
      expect(screen.getByRole('button', { name: new RegExp(`^Source ${i}:`) })).toBeInTheDocument();
    }
  });

  // ========================================================================
  // TEST: Error during RAG pipeline iteration calls streamManager.error()
  // ========================================================================
  test('Error during async iteration calls streamManager.error()', async () => {
    const userText = 'Error test';
    const pipelineErrorMessage = 'RAG pipeline crashed';

    async function* errorEvents(): AsyncGenerator<RAGEvent> {
      yield { type: 'token', data: 'Partial ' };
      yield { type: 'token', data: 'answer' };
      throw new Error(pipelineErrorMessage);
    }
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(errorEvents());

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);
    submitMessage(userText);

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // Verify error was called on stream manager with the correct message
    expect(mockStreamManagerInstance.error).toHaveBeenCalledWith(pipelineErrorMessage);
  });

  // ========================================================================
  // TEST 10: Save-on-stream-done integration (PRR-006) + stale-ref guard.
  // Verifies the headline wiring (terminal done -> onSaveConversation) AND
  // that the finalized array includes every streamed token. This guards the
  // PRR-002 fix: onDone fires synchronously after flushBuffer() inside
  // complete(), so the saved array must reflect tokens flushed in the same
  // call stack. A regression that reads a stale messagesRef would save an
  // empty/partial assistant content and FAIL the content assertion below.
  //
  // Persistence lifecycle (current production): a turn saves TWICE — the
  // send-time save persists the user turn + streaming placeholder
  // (ChatPage.tsx:1201-1217) and the terminal done save persists the
  // finalized thread (ChatPage.tsx:803-804). The send-time call is accounted
  // for explicitly; the finalized assertions target the LAST call.
  // ========================================================================
  test('onDone invokes onSaveConversation with finalized messages including streamed tokens', async () => {
    const userText = 'Persist me';
    const events: RAGEvent[] = [
      { type: 'complete', data: { answer: 'Saved.', sources: ['doc-x'], chunks: [], grounding: 'grounded' } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    const onSaveConversation = vi.fn();
    const onNewChat = vi.fn();

    render(
      <Harness onSaveConversation={onSaveConversation} onNewChat={onNewChat} />
    );
    submitMessage(userText);

    // Let the submit + complete microtasks flush so the user+assistant pair is
    // committed and the stream callbacks are registered on the mock manager.
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // Capture the registered onToken + onDone handlers.
    expect(mockStreamManagerInstance.onToken).toHaveBeenCalledTimes(1);
    expect(mockStreamManagerInstance.onDone).toHaveBeenCalledTimes(1);
    const onTokenHandler = mockStreamManagerInstance.onToken.mock.calls[0][0];
    const onDoneHandler = mockStreamManagerInstance.onDone.mock.calls[0][0];

    // Simulate the real TokenStreamManager.complete() ordering: flush tokens
    // (onToken), then fire onDone synchronously in the same call stack.
    const streamedAnswer = 'Hello world';
    await act(async () => {
      onTokenHandler(streamedAnswer);
      onDoneHandler({ sources: ['doc-x'], contextLength: streamedAnswer.length, inferenceTime: 5 });
    });

    // Persistence lifecycle: exactly TWO saves per turn.
    // 1) the send-time save (user turn + streaming placeholder), and
    // 2) the terminal done save (finalized thread) — the LAST call.
    // onSaveConversation signature: (conversationId, messages, mode,
    // modelUsed, onCreate?) — messages is position 1.
    expect(onSaveConversation).toHaveBeenCalledTimes(2);

    const [, sendTimeMessages] = onSaveConversation.mock.calls[0];
    expect(sendTimeMessages).toHaveLength(2); // user + assistant placeholder
    const sendTimeAssistant = sendTimeMessages.find((m: { role: string }) => m.role === 'assistant');
    expect(sendTimeAssistant.isStreaming).toBe(true);
    expect(sendTimeAssistant.content).toBe('');

    // Terminal save (LAST call): finalized messages with the streamed tokens.
    const lastSave = onSaveConversation.mock.calls.at(-1);
    expect(lastSave).toBeDefined();
    const [, savedMessages, savedMode, savedModelUsed] = lastSave as [
      unknown,
      Array<{ role: string; isStreaming?: boolean; sources?: string[]; content: string }>,
      string | undefined,
      string | undefined,
    ];
    expect(savedMessages.length).toBe(2); // user + assistant
    const assistant = savedMessages.find((m: { role: string }) => m.role === 'assistant')!;
    expect(assistant).toBeDefined();
    // The terminal handler STRIPS the streaming marker (destructure-omit at
    // ChatPage.tsx:753-755) — the key is absent on the finalized message.
    expect(assistant.isStreaming).toBeUndefined();
    expect(assistant.sources).toEqual(['doc-x']);
    // The streamed token MUST be present in the saved content — this is the
    // assertion that catches a stale-messagesRef regression.
    expect(assistant.content).toBe(streamedAnswer);
    // browser-local + wllama engine maps to mode 'wllama' with the engine name.
    expect(savedMode).toBe('wllama');
    expect(savedModelUsed).toBe('wllama');
  });

  // ========================================================================
  // TEST 11: Stream cancellation (PRR-003) — the shared cancelActiveStream
  // path that Clear Chat and the external New Chat path both rely on. The
  // Stop button is the reachable entry point during streaming (Clear is
  // disabled while loading), so it exercises the same extracted helper.
  // ========================================================================
  test('Cancel during streaming cancels the active stream manager', async () => {
    const userText = 'To be cleared';
    const events: RAGEvent[] = [
      { type: 'token', data: 'partial' },
      { type: 'complete', data: { answer: 'partial', sources: [], chunks: [], grounding: 'grounded' } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
  currentConversationId={undefined}

  setCurrentConversationId={() => {}}

  onOpenSettings={() => {}}
/>);
    submitMessage(userText);

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    // The Clear button is disabled while a stream is active; cancel first.
    const cancelButton = screen.getByRole('button', { name: /cancel|stop/i });
    await act(async () => {
      fireEvent.click(cancelButton);
    });
    expect(mockStreamManagerInstance.cancel).toHaveBeenCalled();
  });

  // ========================================================================
  // TEST 12: Cancel-on-empty effect (PRR-003+004 core scenario).
  // The sidebar "New Chat" path calls newChat() in App, which empties
  // currentMessages (the messages prop) WITHOUT going through ChatPage. The
  // cancel-on-empty effect must detect that non-empty → empty transition
  // while a stream is in flight and cancel the orphaned stream manager.
  // ========================================================================
  test('External clear (messages prop non-empty → empty) cancels the active stream', async () => {
    const userText = 'Stream then externally cleared';
    const events: RAGEvent[] = [
      { type: 'token', data: 'partial answer' },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    const onSaveConversation = vi.fn();

    // Harness that lets the test flip messages to [] to simulate the sidebar
    // New Chat path (App calls newChat → setCurrentMessages([])).
    let externalClear: () => void = () => {};
    function Harness() {
      const [messages, setMessages] = React.useState<import('../types/chat').ChatMessage[]>([]);
      externalClear = () => setMessages([]);
      return (
        <ChatPage
          messages={messages}
          onMessagesChange={setMessages}
          onSaveConversation={onSaveConversation}
          onNewChat={() => {}}
          currentConversationId={undefined}

          setCurrentConversationId={() => {}}

          onOpenSettings={() => {}}
        />
      );
    }
    render(<Harness />);
    submitMessage(userText);

    // Let the user+assistant pair propagate (non-empty) and the stream start.
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // A stream is in flight and messages is non-empty.
    expect(mockStreamManagerInstance.cancel).not.toHaveBeenCalled();

    // Simulate the sidebar New Chat: the parent empties the messages prop.
    await act(async () => {
      externalClear();
    });

    // The cancel-on-empty effect fires and cancels the orphaned stream.
    expect(mockStreamManagerInstance.cancel).toHaveBeenCalled();
  });
});
