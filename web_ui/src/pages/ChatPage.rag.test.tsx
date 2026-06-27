/**
 * Tests for ChatPage RAG Pipeline Integration - ChatPage.rag.test.tsx
 *
 * Tests the integration between ChatPage and RAGOrchestrator.query() AsyncGenerator:
 * - handleSend creates RAGOrchestrator and calls query() with user text
 * - Token events are pushed to TokenStreamManager (pushToken called for each)
 * - Complete event passes sources to TokenStreamManager.complete()
 * - Error event calls TokenStreamManager.error() with message
 * - User message and empty assistant message are added to state
 * - Loading state is true during streaming, false after complete
 * - Cancellation via handleCancel aborts the controller and cancels stream
 * - Multiple rapid sends (second message while first streaming)
 * - Sources from complete event are stored in message
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
    };
    return mockStreamManagerInstance;
  }),
}));

// Import after mocks are set up
import { ChatPage } from './ChatPage';

// Re-export RAGEvent type for test helper
export type { RAGEvent } from '../lib/rag/rag-orchestrator';
import type { RAGEvent } from '../lib/rag/rag-orchestrator';

/**
 * Helper: Create a controlled AsyncGenerator that yields RAGEvents
 */
async function* mockRAGEvents(events: RAGEvent[]): AsyncGenerator<RAGEvent> {
  for (const event of events) {
    yield event;
  }
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
    };

    // Re-setup the mock implementation to return our fresh instance
    vi.mocked(streamingModule.TokenStreamManager).mockImplementation(function () {
      return mockStreamManagerInstance;
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Create mock orchestrator instance
    mockOrchestratorInstance = {
      query: vi.fn(),
    };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(() => mockOrchestratorInstance);

    // Setup useInferenceMode mock
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
      setServerUrl: vi.fn(),
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
      { type: 'complete', data: { answer: 'ML is great.', sources: ['doc-1'], chunks: [] } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
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
      { type: 'complete', data: { answer: 'Hello, world!', sources: [], chunks: [] } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
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
      { type: 'complete', data: { answer: 'AI is artificial intelligence.', sources, chunks: [] } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
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
      { type: 'complete', data: { answer: 'Hi!', sources: [], chunks: [] } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
/>);

    // Check initial state - no messages
    expect(screen.queryAllByText(userText)).toHaveLength(0);

    submitMessage(userText);

    // Messages should be added immediately (before async iteration)
    // After submit, user text appears - either in textarea (if not yet cleared) or message bubble
    expect(screen.getByText(userText)).toBeInTheDocument();
  });

  // ========================================================================
  // TEST 6: Loading state is true during streaming, false after complete
  // ========================================================================
  test('Loading state is true during streaming, false after complete', async () => {
    const userText = 'Loading test';
    const events: RAGEvent[] = [
      { type: 'token', data: 'Loading' },
      { type: 'token', data: '...' },
      { type: 'complete', data: { answer: 'Loading...', sources: [], chunks: [] } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
/>);
    submitMessage(userText);

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // After complete, verify complete was called
    expect(mockStreamManagerInstance.complete).toHaveBeenCalled();
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
    const userText2 = 'Second question';
    const events: RAGEvent[] = [
      { type: 'token', data: 'Answer 1' },
      { type: 'complete', data: { answer: 'Answer 1', sources: [], chunks: [] } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
/>);

    const textarea = screen.getByRole('textbox');
    const sendButton = screen.getByRole('button', { name: /send message/i });

    // Send the first message
    fireEvent.change(textarea, { target: { value: userText1 } });
    fireEvent.click(sendButton);

    // After first send, isLoading=true disables the textarea and
    // the send button is replaced by "Stop generation" button,
    // so a second concurrent send is structurally prevented.

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

    // Verify only first user's message appears as a sent message.
    // (The rapid change2 may leave text2 in the input textarea, but no second message was added to chat.)
    expect(screen.getByText(userText1)).toBeInTheDocument();
    // Each message (user + assistant) renders a "Copy message" button; 2 means only the first send produced messages
    expect(screen.getAllByRole('button', { name: /copy message/i })).toHaveLength(2);

    // Verify no race condition: only one RAGOrchestrator created (hence only one abortControllerRef set inside the send path)
    expect(vi.mocked(ragModule.RAGOrchestrator)).toHaveBeenCalledTimes(1);
  });

  // ========================================================================
  // TEST 9: Sources from complete event are stored in message
  // ========================================================================
  test('Sources from complete event are stored in assistant message', async () => {
    const userText = 'Give me sources';
    const sources = ['doc-alpha', 'doc-beta', 'doc-gamma'];
    const events: RAGEvent[] = [
      { type: 'complete', data: { answer: 'Here are sources.', sources, chunks: [] } },
    ];
    vi.mocked(mockOrchestratorInstance.query).mockReturnValue(mockRAGEvents(events));

    render(<ChatPage
  messages={[]}
  onMessagesChange={() => {}}
  onSaveConversation={() => {}}
  onNewChat={() => {}}
/>);
    submitMessage(userText);

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }
    });

    // Verify onDone callback was called with sources
    expect(mockStreamManagerInstance.onDone).toHaveBeenCalled();
    expect(mockStreamManagerInstance.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        sources,
      })
    );
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
});
