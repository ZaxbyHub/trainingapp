/**
 * ChatPage.first-turn-done.test.tsx — defect-class guardrail for issue #118.
 *
 * Pins the terminal stream callbacks' live-UI commit contract:
 *   (a) first-turn DONE — a brand-new conversation (currentConversationId
 *       undefined at send time) must surface the terminal done payload
 *       (source pills, grounding badge, learn panel) in the live UI.
 *   (b) first-turn ERROR twin — the same scenario through onError must finalize
 *       the assistant bubble with the structured error card (S6).
 *   (c) S1 mid-stream-switch — a late done event after the user switched to a
 *       DIFFERENT conversation must NOT write the owning turn into the
 *       switched-to view (the invariant the terminal guards exist to protect),
 *       while persistence still targets the owning conversation.
 *
 * Unit-level mirrors of the frozen e2e checks (C1/C2/C5 in the #118 trace):
 * they fail on the stale-closure guard shape and pass on the live-ref fix.
 * This file is NOT in the vitest.config.ts quarantine — it runs in the normal
 * vitest gate.
 *
 * Boundary mocks (../lib/rag/rag-orchestrator, ../lib/llm/*, ../lib/streaming)
 * follow the established page-component-test convention: ChatPage transitively
 * pulls native-ESM deps (rag-orchestrator -> vector-index -> edgevec) that
 * cannot load in vitest, so every such edge is mocked before the component
 * import.
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
  TokenStreamManager: vi.fn().mockImplementation(() => ({
    onToken: mockOnToken,
    onDone: mockOnDone,
    onError: mockOnError,
    pushToken: vi.fn(),
    complete: vi.fn(),
    error: vi.fn(),
    cancel: mockCancel,
    dispose: vi.fn(),
    startSSEStream: mockStartSSEStream,
  })),
}));

vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(() => ({
    query: vi.fn(),
    dispose: vi.fn(),
  })),
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
vi.mock('../lib/search/rrf-fusion', () => ({ rrfFuse: vi.fn() }));

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

import { ChatPage } from './ChatPage';
import { useInferenceMode } from '../lib/inference';
import type { ChatMessage } from '../types/chat';

// Well-formed terminal done payload (shapes per lib/api/types).
const DONE_PAYLOAD = {
  sources: ['expenses-guide.md'],
  contextLength: 512,
  inferenceTime: 12.3,
  grounding: 'grounded' as const,
  citations: [
    {
      source: 'expenses-guide.md',
      text: 'Expense reports are due by the last business day of the month.',
      score: 0.82,
    },
  ],
  learn: [
    {
      slide_id: '5rN4PvXJM5d',
      title: 'OpMed CDP MicroLearning Companion',
      section: 'Introduction',
      score: 0.9,
      reason: 'direct' as const,
      snippet: 'Introduces the companion.',
    },
  ],
  abstain: false,
  abstainReason: null,
  retrievalDegraded: false,
};

function getDoneCallback() {
  return mockOnDone.mock.calls[mockOnDone.mock.calls.length - 1]?.[0] as
    | ((data: unknown) => void)
    | undefined;
}

function getErrorCallback() {
  return mockOnError.mock.calls[mockOnError.mock.calls.length - 1]?.[0] as
    | ((message: string) => void)
    | undefined;
}

type SaveConv = React.ComponentProps<typeof ChatPage>['onSaveConversation'];

/**
 * Stateful stand-in for App: owns the messages array and the current
 * conversation id exactly like the real shell does, so a terminal
 * setMessages from ChatPage's callbacks flows back into the rendered UI.
 * Exposes the state setters so tests can emulate an App-level conversation
 * switch on the SAME mounted instance.
 */
function Harness({
  initialConversationId,
  onSaveConversation,
  registerControls,
}: {
  initialConversationId: string | undefined;
  onSaveConversation: SaveConv;
  registerControls?: (controls: {
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    setConversationId: React.Dispatch<React.SetStateAction<string | undefined>>;
  }) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(
    initialConversationId,
  );
  registerControls?.({ setMessages, setConversationId });
  return (
    <ChatPage
      messages={messages}
      onMessagesChange={setMessages}
      onSaveConversation={onSaveConversation}
      onNewChat={() => {}}
      currentConversationId={conversationId}
      setCurrentConversationId={setConversationId}
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

async function sendFirstQuestion() {
  const textarea = screen.getByRole('textbox', { name: 'Message input' });
  fireEvent.change(textarea, { target: { value: 'What is the monthly deadline?' } });
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
  // Flush the awaited send-time save (id adoption) + callback registration.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(mockStartSSEStream).toHaveBeenCalledTimes(1);
}

async function flushUi() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('ChatPage terminal callbacks on a first turn (issue #118 guardrail)', () => {
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

  it('(a) first-turn done payload (source pills + grounding badge + learn panel) reaches the live UI', async () => {
    const onSaveConversation = makeCreatingSave('conv-created-1');
    render(
      <Harness initialConversationId={undefined} onSaveConversation={onSaveConversation} />,
    );
    await sendFirstQuestion();

    const done = getDoneCallback();
    expect(done).toBeDefined();
    await act(async () => {
      done?.(DONE_PAYLOAD);
    });
    await flushUi();

    // Terminal done-payload UI must be visible after the FIRST turn.
    expect(screen.getByText('Grounded in your documents')).toBeInTheDocument();
    expect(screen.getByLabelText('Learn panel — where to learn this')).toBeInTheDocument();
    // Structured citation ref: the pill renders label + copy affordance; the
    // cite text lives in the click-to-expand popover, so assert the ref itself.
    expect(screen.getByRole('button', { name: /^Source 1:/ })).toBeInTheDocument();
    // And the turn was persisted to the adopted conversation (F1: no
    // duplicate). The terminal save passes 4 args (no onCreate — the
    // conversation already exists).
    expect(onSaveConversation).toHaveBeenLastCalledWith(
      'conv-created-1',
      expect.any(Array),
      'server',
      'wllama',
    );
  });

  it('(b) first-turn error finalizes the live bubble with the error card', async () => {
    const onSaveConversation = makeCreatingSave('conv-created-2');
    render(
      <Harness initialConversationId={undefined} onSaveConversation={onSaveConversation} />,
    );
    await sendFirstQuestion();

    const onError = getErrorCallback();
    expect(onError).toBeDefined();
    await act(async () => {
      onError?.('connection refused');
    });
    await flushUi();

    // The structured error card (S6) must render on the first turn too.
    expect(screen.getByText('Something went wrong while answering.')).toBeInTheDocument();
    expect(screen.getByText('connection refused')).toBeInTheDocument();
  });

  it('(c) late done after a mid-stream switch does not clobber the switched-to view (S1) but still persists to the owner', async () => {
    const onSaveConversation = vi.fn(async (_id: string | undefined) => {}) as unknown as SaveConv;
    const controls: {
      setMessages?: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
      setConversationId?: React.Dispatch<React.SetStateAction<string | undefined>>;
    } = {};
    render(
      <Harness
        initialConversationId={'conv-A'}
        onSaveConversation={onSaveConversation}
        registerControls={(c) => {
          controls.setMessages = c.setMessages;
          controls.setConversationId = c.setConversationId;
        }}
      />,
    );
    await sendFirstQuestion();

    // The user switches to conversation B mid-stream: App replaces the view
    // (empty messages, different id) on the SAME mounted ChatPage instance.
    // The S1 switch effect cancels the stream; a late/queued done can still
    // fire afterwards (the callback was registered before cancellation).
    act(() => {
      controls.setConversationId?.('conv-B');
      controls.setMessages?.([]);
    });
    expect(mockCancel).toHaveBeenCalled();

    const done = getDoneCallback();
    expect(done).toBeDefined();
    await act(async () => {
      done?.(DONE_PAYLOAD);
    });
    await flushUi();

    // The terminal update must NOT be written into the switched-to view...
    expect(screen.queryByLabelText('Learn panel — where to learn this')).not.toBeInTheDocument();
    expect(screen.queryByText('Grounded in your documents')).not.toBeInTheDocument();
    // ...but persistence must still target the OWNING conversation (S1).
    const ownerSave = (onSaveConversation as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(ownerSave?.[0]).toBe('conv-A');
  });
});
