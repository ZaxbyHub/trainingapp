/**
 * ChatPage.clear-handler-busy (PR #264 review, PRR-102): the session-clear
 * handler ChatPage registers must report isBusy ONLY while a generation turn
 * is actually live. The bug: runGeneration's onDone/onError nulled
 * tokenStreamManagerRef but never abortControllerRef (set only on the
 * default browser-local path), so isBusy stayed true forever after a normal
 * completion — AC6's inactivity auto-clear could never stop deferring, the
 * tab kept holding the origin-wide session-active shared lock and the 30 s
 * re-arm poll spun indefinitely.
 *
 * Asserted through the REAL session-clear bus (anyHandlerBusy), with the REAL
 * TokenStreamManager; only the LLM/RAG pipeline is mocked, deferred-gated so
 * the test can observe the busy window mid-stream and after completion.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ChatMessage } from '../types/chat';
import type { RAGEvent } from '../lib/rag/rag-orchestrator';
import { anyHandlerBusy, resetSessionClearBusForTests } from '../lib/session/session-clear';

vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(function () {
    return { query: vi.fn() };
  }),
}));

vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(),
  })),
  DEFAULT_BROWSER_ENGINE: 'wllama',
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn().mockReturnValue('wllama'),
}));

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

vi.mock('../lib/llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn().mockResolvedValue(null),
  getReadinessResultSnapshot: vi.fn().mockReturnValue(null),
  resetReadinessCache: vi.fn(),
}));

vi.mock('../lib/api/auth', () => ({
  getToken: vi.fn().mockReturnValue(null),
}));

// The REAL TokenStreamManager is exercised (complete()→flushBuffer()→onDone).
import { ChatPage } from './ChatPage';
import * as ragModule from '../lib/rag/rag-orchestrator';
import * as inferenceModule from '../lib/inference';

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Deferred stream: one token, parks on the gate, then a terminal event. */
function makeDeferredStream(
  gate: { promise: Promise<void>; resolve: () => void },
  terminal: 'complete' | 'generation-error',
): () => AsyncGenerator<RAGEvent> {
  return async function* (): AsyncGenerator<RAGEvent> {
    yield { type: 'token', data: 'tok-' };
    await gate.promise;
    if (terminal === 'complete') {
      yield {
        type: 'complete',
        data: { answer: 'done', sources: ['doc-a'], chunks: [], grounding: 'grounded' },
      };
    } else {
      yield { type: 'error', data: { stage: 'generation', message: 'boom' } };
    }
  };
}

const initialMessages: ChatMessage[] = [];

describe('ChatPage session-clear handler isBusy lifecycle (PRR-102)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionClearBusForTests();

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
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
  });

  afterEach(() => {
    resetSessionClearBusForTests();
    // NOT vi.restoreAllMocks(): it would wipe the vi.mock() factory
    // implementations (getLLMService et al.) for the NEXT test in this file;
    // clearAllMocks only drops call history.
    vi.clearAllMocks();
  });

  async function mountAndSend(terminal: 'complete' | 'generation-error') {
    const gate = makeDeferred();
    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(makeDeferredStream(gate, terminal));

    const onSaveConversation = vi.fn();
    render(
      <ChatPage
        messages={initialMessages}
        onMessagesChange={() => {}}
        onSaveConversation={onSaveConversation}
        currentConversationId={undefined}
        setCurrentConversationId={vi.fn()}
        onNewChat={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    const textarea = screen.getByRole('textbox');
    const sendButton = screen.getByRole('button', { name: /send message/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'busy-check' } });
      fireEvent.click(sendButton);
    });
    // Flush microtasks so initialize() resolves, the orchestrator loop starts,
    // emits the token and parks on the gate.
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    return gate;
  }

  test('isBusy is true during the stream and FALSE after onDone completion', async () => {
    const gate = await mountAndSend('complete');
    // Mid-stream (parked on the gate): the busy signal must be live.
    expect(anyHandlerBusy(), 'isBusy must be true while the stream is in flight').toBe(true);
    await act(async () => {
      gate.resolve();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    // PRR-102: normal completion must clear EVERY busy leg — isLoading,
    // tokenStreamManagerRef AND abortControllerRef (previously leaked).
    expect(anyHandlerBusy(), 'isBusy must be false after the turn completes').toBe(false);
  });

  test('isBusy is true during the stream and FALSE after onError completion', async () => {
    const gate = await mountAndSend('generation-error');
    expect(anyHandlerBusy(), 'isBusy must be true while the stream is in flight').toBe(true);
    await act(async () => {
      gate.resolve();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    // A failed turn is still a completed turn: the busy signal must release.
    expect(anyHandlerBusy(), 'isBusy must be false after the turn errors').toBe(false);
  });

  test('a second turn re-arms the busy signal and releases it again', async () => {
    const gate = await mountAndSend('complete');
    await act(async () => {
      gate.resolve();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(anyHandlerBusy()).toBe(false);

    // A fresh deferred stream for the second send.
    const gate2 = makeDeferred();
    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(makeDeferredStream(gate2, 'complete'));
    const textarea = screen.getByRole('textbox');
    const sendButton = screen.getByRole('button', { name: /send message/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'busy-check-2' } });
      fireEvent.click(sendButton);
    });
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(anyHandlerBusy(), 'the second turn re-arms isBusy').toBe(true);
    await act(async () => {
      gate2.resolve();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(anyHandlerBusy(), 'the second turn also releases isBusy').toBe(false);
  });
});
