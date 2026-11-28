/**
 * Tests for ChatPage component — issue #348 quarantine discharge.
 *
 * Verifies the live UI contract: welcome/empty state, header, message
 * sending (Enter vs Shift+Enter), the streaming indicator, Stop
 * cancellation, the two-step Clear Chat confirm flow (including the
 * 3-second auto-reset timer and its cleanup), and the input gate when
 * the model is blocked.
 *
 * Boundary mocks follow the green sibling ChatPage.first-turn-done.test.tsx
 * (streaming, rag-orchestrator, llm/*, search indexes, inference,
 * desktop-session): ChatPage transitively pulls native-ESM deps that cannot
 * load in vitest, so every such edge is mocked before the component import.
 * The TokenStreamManager mock never fires its callbacks on its own — a turn
 * stays "in flight" until the test drives it (done/stop), which is what the
 * streaming-indicator and cancel cases pin. Timers are REAL timers
 * throughout; the confirm-reset case waits out the real 3s window.
 */
import '@testing-library/jest-dom';
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const mockCancel = vi.fn();
const mockOnToken = vi.fn();
const mockOnDone = vi.fn();
const mockOnError = vi.fn();
const mockStartSSEStream = vi.fn();

vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(function () { return ({
    onToken: mockOnToken,
    onDone: mockOnDone,
    onError: mockOnError,
    pushToken: vi.fn(),
    complete: vi.fn(),
    error: vi.fn(),
    cancel: mockCancel,
    dispose: vi.fn(),
    startSSEStream: mockStartSSEStream,
    setFirstByteTimeoutMs: vi.fn(),
  }); }),
}));

vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(function () { return ({
    query: vi.fn(),
    dispose: vi.fn(),
  }); }),
}));

vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn(() => ({
    initialize: vi.fn(async () => undefined),
    interrupt: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../lib/llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn(async () => undefined),
  getReadinessResultSnapshot: vi.fn(() => null),
  resetReadinessCache: vi.fn(),
}));

vi.mock('../lib/llm/web-llm-service', () => ({
  WEBLLM_DEFAULT_MODEL_ID: 'mock-webllm-model',
}));

vi.mock('../lib/embeddings/embedding-service', () => ({
  getEmbeddingService: vi.fn(() => ({ initialize: vi.fn(async () => undefined) })),
}));

vi.mock('../lib/search/vector-index', () => ({ VectorIndex: vi.fn() }));
vi.mock('../lib/search/keyword-index', () => ({ KeywordIndex: vi.fn() }));
vi.mock('../lib/search/reranker', () => ({ Reranker: vi.fn() }));
vi.mock('../lib/search/rrf-fusion', () => ({ rrfFuse: vi.fn(), dedupeNearDuplicates: vi.fn((results: unknown[]) => results) }));

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

// settings-wiring-honesty (AC4): 'api' mode is the desktop app's built-in
// backend only — the send path needs a desktop session, so this suite drives
// the Electron api path through a stub session (same shape as the sibling).
vi.mock('../lib/desktop-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/desktop-session')>()),
  useDesktopSession: () => ({
    session: {
      baseUrl: 'http://127.0.0.1:4567',
      token: 'test-desktop-token',
      mode: 'node',
      apiClient: {},
      sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
    },
    models: null,
    loading: false,
    error: null,
  }),
  fetchModelStatus: vi.fn(async () => ({
    engine: 'stub',
    profile: 'auto',
    models: { quality: { present: false }, fast: { present: false } },
  })),
}));

import { ChatPage } from './ChatPage';
import { useInferenceMode } from '../lib/inference';
import type { ChatMessage } from '../types/chat';

function getDoneCallback() {
  return mockOnDone.mock.calls[mockOnDone.mock.calls.length - 1]?.[0] as
    | ((data: unknown) => void)
    | undefined;
}

type SaveConv = React.ComponentProps<typeof ChatPage>['onSaveConversation'];

/**
 * Stateful stand-in for App: owns the messages array and the current
 * conversation id exactly like the real shell does, so ChatPage's
 * setMessages/onNewChat flows are reflected in the rendered UI.
 */
function Harness({
  onSaveConversation,
  onNewChat,
}: {
  onSaveConversation: SaveConv;
  onNewChat: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId] = useState<string | undefined>(undefined);
  return (
    <ChatPage
      messages={messages}
      onMessagesChange={setMessages}
      onSaveConversation={onSaveConversation}
      onNewChat={onNewChat}
      currentConversationId={conversationId}
      setCurrentConversationId={() => {}}
      onOpenSettings={() => {}}
    />
  );
}

/** saveMessages stand-in: creates the conversation and adopts the id via
 *  onCreate BEFORE the awaited save resolves (useConversations.ts ordering). */
function makeCreatingSave(convId: string): SaveConv {
  return vi.fn(async (
    _id: string | undefined,
    _messages: unknown[],
    _mode: 'api' | 'wllama',
    _engine: 'wllama',
    onCreate?: (newId: string) => void,
  ) => {
    onCreate?.(convId);
  }) as SaveConv;
}

function getComposer(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
}

async function sendQuestion(text: string): Promise<void> {
  const textarea = getComposer();
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
  // Flush the awaited send-time save (id adoption) + SSE callback wiring.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(mockStartSSEStream).toHaveBeenCalledTimes(1);
}

/** Complete the in-flight turn through the terminal done callback. */
async function finishTurn(): Promise<void> {
  const done = getDoneCallback();
  expect(done).toBeDefined();
  await act(async () => {
    done?.({ sources: [], contextLength: 0, inferenceTime: 0 });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('ChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useInferenceMode).mockReturnValue({
      mode: 'api',
      browserEngine: 'wllama' as const,
      ragPreset: 'balanced' as const,
      serverUrl: 'http://localhost:8000',
      isModelReady: false,
      isServerConnected: true,
      modelLoadingProgress: 0,
      modeError: null,
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    } as ReturnType<typeof useInferenceMode>);
  });

  afterEach(() => {
    cleanup();
  });

  describe('Initial Rendering', () => {
    it('renders the zero-document welcome state and the composer', () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      // ChatMessageList zero-doc branch (useDocumentCount reports 0 in jsdom).
      expect(screen.getByText('Add documents to get started')).toBeInTheDocument();
      // Stable composer query: aria-label, not the placeholder copy.
      expect(screen.getByRole('textbox', { name: 'Message input' })).toBeInTheDocument();
      expect(getComposer()).toHaveAttribute(
        'placeholder',
        'Ask a question… (Enter to send, Shift+Enter for a new line)'
      );
    });

    it('renders header with title', () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument();
    });

    it('does not show Clear Chat button when no messages', () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      expect(screen.queryByText('Clear Chat')).not.toBeInTheDocument();
      expect(screen.queryByText('Confirm Clear?')).not.toBeInTheDocument();
    });
  });

  describe('Message Sending', () => {
    it('sends message and creates user/assistant pair', async () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      await sendQuestion('Hello');

      // The user turn is committed to the live thread...
      expect(screen.getByText('Hello')).toBeInTheDocument();
      // ...and the assistant half of the pair exists (the conversation
      // actions appear only when messages.length > 0).
      expect(screen.getByText('Clear Chat')).toBeInTheDocument();
    });

    it('shows streaming indicator while loading', async () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      await sendQuestion('Hello');

      // The mocked SSE stream never completes on its own: the real
      // StreamingIndicator must be mounted for as long as the turn is live.
      expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
    });

    it('shows Cancel button while streaming', async () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      await sendQuestion('Hello');

      expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument();
    });
  });

  describe('Input Behavior', () => {
    it('Enter key sends message', async () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      await sendQuestion('Test message');

      expect(screen.getByText('Test message')).toBeInTheDocument();
    });

    it('Shift+Enter creates newline without sending', () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      const textarea = getComposer();
      fireEvent.change(textarea, { target: { value: 'Line1\nLine2' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

      // Message should not be sent: no user bubble, no stream started.
      expect(screen.queryByText('Line1')).not.toBeInTheDocument();
      expect(mockStartSSEStream).not.toHaveBeenCalled();
    });

    it('input is disabled when model is blocked', () => {
      // Same outer vi.mock, one-shot override: browser-local mode with the
      // model not ready raises the model gate and disables the composer.
      vi.mocked(useInferenceMode).mockReturnValueOnce({
        mode: 'browser-local',
        browserEngine: 'wllama' as const,
        ragPreset: 'balanced' as const,
        serverUrl: 'http://localhost:8000',
        isModelReady: false,
        isServerConnected: true,
        modelLoadingProgress: 0,
        modeError: null,
        setMode: vi.fn(),
        setBrowserEngine: vi.fn(),
        setRagPreset: vi.fn(),
        setServerUrl: vi.fn(),
        checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
        setModelReady: vi.fn(),
        setModelLoadingProgress: vi.fn(),
      } as ReturnType<typeof useInferenceMode>);

      const { container } = render(
        <Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />
      );

      // The browser model gate is up (its actions sit OUTSIDE the inert
      // chat content, so they stay in the accessibility tree)...
      expect(
        screen.getByRole('button', { name: 'Use a local server or cloud model' })
      ).toBeInTheDocument();
      // ...and the composer textarea inside the inert chat content is
      // disabled (role queries skip inert subtrees, so query the element).
      const textarea = container.querySelector('textarea');
      expect(textarea).not.toBeNull();
      expect(textarea).toBeDisabled();
    });
  });

  describe('Streaming Cancellation', () => {
    it('cancel stops streaming and marks messages as complete', async () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      await sendQuestion('Hello');
      expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
      await flushUi();

      // Streaming indicator is gone...
      expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument();
      // ...the live log announces the stopped (not completed) turn...
      expect(screen.getByText('Response stopped')).toBeInTheDocument();
      // ...the composer is back to Send...
      expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
      // ...and the stream was cancelled through its manager.
      expect(mockCancel).toHaveBeenCalled();
    });

    it('clears mock timer on cancel — a new turn can start after Stop', async () => {
      // Observable rewrite of the old timer-spy test: after Stop releases
      // the stream, the composer accepts and routes a SECOND turn.
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      await sendQuestion('First question');
      fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
      await flushUi();
      expect(screen.getByText('First question')).toBeInTheDocument();

      mockStartSSEStream.mockClear();
      await sendQuestion('Second question');

      expect(screen.getByText('Second question')).toBeInTheDocument();
      expect(mockStartSSEStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('Timer Cleanup on Unmount', () => {
    it('clears all timers on unmount — the in-flight turn is finalized and persisted', async () => {
      // Observable rewrite of the old clearTimeout-spy test: the unmount
      // cleanup terminalizes the live stream and persists the partial turn
      // to the owning conversation (ChatPage.tsx unmount effect).
      const onSaveConversation = makeCreatingSave('conv-unmount');
      const { unmount } = render(
        <Harness onSaveConversation={onSaveConversation} onNewChat={() => {}} />
      );

      await sendQuestion('Hello');
      expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();

      unmount();
      await flushUi();

      // Send-time save + terminal unmount save, both targeting the adopted
      // conversation id — the turn was not lost to the unmount.
      expect(onSaveConversation).toHaveBeenCalledTimes(2);
      expect(onSaveConversation).toHaveBeenLastCalledWith(
        'conv-unmount',
        expect.any(Array),
        'server',
        'wllama'
      );
    });

    it('clears confirm clear timer on unmount', async () => {
      // Arm the two-step confirm (which arms its 3s auto-reset timer), then
      // unmount: the pending confirm state leaves the document with the
      // timer cleared (ChatPage.tsx unmount cleanup), not left to fire.
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const callsBeforeArming = setTimeoutSpy.mock.calls.length;

      const { unmount } = render(
        <Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />
      );
      await sendQuestion('Hello');
      await finishTurn();

      fireEvent.click(screen.getByText('Clear Chat'));
      expect(screen.getByText('Confirm Clear?')).toBeInTheDocument();

      // The armed confirm timer is the 3000ms setTimeout issued on arming.
      const armedIndex = setTimeoutSpy.mock.calls.findIndex(
        (call, i) => i >= callsBeforeArming && call[1] === 3000
      );
      expect(armedIndex).toBeGreaterThanOrEqual(0);
      const armedTimer = setTimeoutSpy.mock.results[armedIndex]?.value;

      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(armedTimer);
      expect(screen.queryByText('Confirm Clear?')).not.toBeInTheDocument();
    });
  });

  describe('Clear Chat Functionality', () => {
    it('shows Clear Chat button when messages exist', async () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      await sendQuestion('Hello');
      await finishTurn();

      expect(screen.getByText('Clear Chat')).toBeInTheDocument();
    });

    it('first click shows confirm state', async () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      await sendQuestion('Hello');
      await finishTurn();

      fireEvent.click(screen.getByText('Clear Chat'));

      expect(screen.getByText('Confirm Clear?')).toBeInTheDocument();
      expect(screen.queryByText('Clear Chat')).not.toBeInTheDocument();
    });

    it('second click clears messages', async () => {
      const onNewChat = vi.fn();
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={onNewChat} />);

      await sendQuestion('Hello');
      await finishTurn();

      fireEvent.click(screen.getByText('Clear Chat'));
      fireEvent.click(screen.getByText('Confirm Clear?'));

      // Messages are cleared: the welcome state is back and the App-level
      // new-chat hook fired.
      expect(screen.queryByText('Hello')).not.toBeInTheDocument();
      expect(screen.getByText('Add documents to get started')).toBeInTheDocument();
      expect(onNewChat).toHaveBeenCalledTimes(1);
    });

    it('confirm timer auto-resets after 3 seconds', async () => {
      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={() => {}} />);

      await sendQuestion('Hello');
      await finishTurn();

      fireEvent.click(screen.getByText('Clear Chat'));
      expect(screen.getByText('Confirm Clear?')).toBeInTheDocument();

      // Wait out the real 3s auto-reset window (plus slack).
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3300));
      });

      expect(screen.getByText('Clear Chat')).toBeInTheDocument();
      expect(screen.queryByText('Confirm Clear?')).not.toBeInTheDocument();
      // The thread survived: only the confirm state reset.
      expect(screen.getByText('Hello')).toBeInTheDocument();
    }, 15000);

    it('clearTimeout is called when timer is no longer needed — second click clears instead of re-arming', async () => {
      // Confirm within the 3s window must CLEAR the thread and cancel the
      // armed auto-reset timer (not re-arm it for another round).
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const callsBeforeArming = setTimeoutSpy.mock.calls.length;
      const onNewChat = vi.fn();

      render(<Harness onSaveConversation={makeCreatingSave('conv-1')} onNewChat={onNewChat} />);

      await sendQuestion('Hello');
      await finishTurn();

      fireEvent.click(screen.getByText('Clear Chat'));
      expect(screen.getByText('Confirm Clear?')).toBeInTheDocument();

      const armedIndex = setTimeoutSpy.mock.calls.findIndex(
        (call, i) => i >= callsBeforeArming && call[1] === 3000
      );
      expect(armedIndex).toBeGreaterThanOrEqual(0);
      const armedTimer = setTimeoutSpy.mock.results[armedIndex]?.value;

      fireEvent.click(screen.getByText('Confirm Clear?'));

      // User-visible outcome: the thread is gone and the confirm state
      // reset with it (no re-armed confirm).
      expect(screen.queryByText('Hello')).not.toBeInTheDocument();
      expect(screen.getByText('Add documents to get started')).toBeInTheDocument();
      expect(screen.queryByText('Confirm Clear?')).not.toBeInTheDocument();
      expect(onNewChat).toHaveBeenCalledTimes(1);
      // And the armed timer was cancelled rather than left to fire.
      expect(clearTimeoutSpy).toHaveBeenCalledWith(armedTimer);
    });
  });
});
