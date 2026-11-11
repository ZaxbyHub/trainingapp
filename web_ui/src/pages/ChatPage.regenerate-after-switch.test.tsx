/**
 * ChatPage.regenerate-after-switch.test.tsx — issue #269 AC4 (claim 5).
 *
 * WHEN Regenerate is invoked on conversation B after the active conversation
 * changed from A to B, THE SYSTEM SHALL re-run B's last user question, not A's.
 *
 * Base defect: `lastTurnRef` is set at send time and only cleared by
 * "clear chat"; no conversation switch resets it, and handleRegenerate reads
 * it blindly. So: complete a turn in A, switch to B (no streaming needed),
 * click Regenerate on B — base re-runs A's question against B's thread with
 * owning id B, permanently replacing B's answer.
 *
 * The boundary vi.mock block is copied from ChatPage.streaming-persistence.
 * test.tsx (rag-orchestrator, llm-factory, inference, readiness-gate, auth).
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ChatMessage } from '../types/chat';
import type { RAGEvent } from '../lib/rag/rag-orchestrator';

// --- Module mocks (copied from ChatPage.streaming-persistence.test.tsx) -----

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

import { ChatPage } from './ChatPage';
import * as ragModule from '../lib/rag/rag-orchestrator';
import * as inferenceModule from '../lib/inference';
import * as llmFactoryModule from '../lib/llm/llm-factory';

function makeMessage(role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `${role}-${content.replace(/\s+/g, '-').slice(0, 12)}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

async function flushMicrotasks(n = 16): Promise<void> {
  await act(async () => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  });
}

/** A turn that streams one token and completes immediately (onDone fires). */
async function* completingStream(): AsyncGenerator<RAGEvent> {
  yield { type: 'token', data: 'A-ANSWER' };
  yield { type: 'complete', data: { answer: 'A-ANSWER', sources: [], chunks: [], grounding: 'grounded' } };
}

/** A regenerated turn that parks forever (only the query call is observed). */
async function* parkedStream(): AsyncGenerator<RAGEvent> {
  yield { type: 'token', data: 'REGEN-' };
  await new Promise<void>(() => {});
}

describe('ChatPage #269 AC4: Regenerate after a conversation switch re-runs the on-screen question', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(llmFactoryModule.getLLMService).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(),
    }) as unknown as ReturnType<typeof llmFactoryModule.getLLMService>);
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
    vi.restoreAllMocks();
  });

  test('Regenerate on B after switching from A re-runs B-QUESTION, not A-QUESTION (#269 AC4)', async () => {
    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    // First call (A's turn) completes; every later call (the regenerate) parks.
    orchestrator.query.mockImplementationOnce(completingStream).mockImplementation(parkedStream);

    const onSaveConversation = vi.fn();
    const setCurrentConversationId = vi.fn();

    type View = { convId: string; messages: ChatMessage[] };
    let view: View = { convId: 'A', messages: [] };

    function Harness() {
      return (
        <ChatPage
          messages={view.messages}
          onMessagesChange={(next) => {
            view = {
              ...view,
              messages:
                typeof next === 'function'
                  ? (next as (p: ChatMessage[]) => ChatMessage[])(view.messages)
                  : next,
            };
          }}
          onSaveConversation={onSaveConversation}
          currentConversationId={view.convId}
          setCurrentConversationId={setCurrentConversationId}
          onNewChat={() => {}}
          onOpenSettings={() => {}}
        />
      );
    }

    const { rerender } = render(<Harness />);

    // --- Step 1: complete a turn in A ----------------------------------------
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A-QUESTION' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });
    await flushMicrotasks(24);
    // Re-render so the completed turn (isLoading false) reaches the DOM.
    await act(async () => {
      rerender(<Harness />);
    });
    expect(orchestrator.query).toHaveBeenCalledTimes(1);
    expect(orchestrator.query).toHaveBeenLastCalledWith(
      'A-QUESTION',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(
      view.messages.some((m) => m.role === 'assistant' && m.content === 'A-ANSWER' && !m.isStreaming),
      'sanity: A\'s turn must have completed before the switch'
    ).toBe(true);

    // --- Step 2: switch to B, whose thread ends B-QUESTION + an answer -------
    const bUserMsg = makeMessage('user', 'B-QUESTION');
    const bAnswer = makeMessage('assistant', 'B-ANSWER');
    await act(async () => {
      view = { convId: 'B', messages: [bUserMsg, bAnswer] };
      rerender(<Harness />);
    });
    await flushMicrotasks();

    // The Regenerate action must be offered on B's last answer.
    const regenerate = screen.getByRole('button', { name: /regenerate response/i });
    expect(regenerate).toBeInTheDocument();

    // --- Step 3: Regenerate on B ---------------------------------------------
    await act(async () => {
      fireEvent.click(regenerate);
    });
    await flushMicrotasks(24);

    // === ASSERTION: the re-run question is B's, not A's ======================
    // At base handleRegenerate reads the stale lastTurnRef ({ text: 'A-QUESTION' }).
    expect(orchestrator.query).toHaveBeenCalledTimes(2);
    expect(orchestrator.query).toHaveBeenLastCalledWith(
      'B-QUESTION',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});
