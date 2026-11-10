/**
 * ChatPage.switch-tail-flush.test.tsx — issue #269 AC11 (claim 2).
 *
 * WHEN a conversation switch from A to B happens while tokens are still
 * buffered, THE SYSTEM SHALL save to A a thread containing every buffered
 * token and no B message.
 *
 * Base defect: the switch effect saves A's finalized thread
 * (`onSaveConversation(owningId, finalized, ...)`) BEFORE it calls
 * cancelActiveStream(); TokenStreamManager.cancel() then flushes the buffered
 * tail tokens through the (unguarded) onToken — too late for A's record. The
 * fix reorders the effect (cancel first, its flush routed through a guarded,
 * owning-snapshot-derived onToken), so A's save carries the whole tail and no
 * B data.
 *
 * Timing: the PRR-005 fake-timer technique from
 * ChatPage.streaming-persistence.test.tsx — fake timers gate the RAF flush, so
 * every streamed token stays in the TokenStreamManager buffer until something
 * flushes it explicitly (here: the cancel triggered by the switch).
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

function makeMessage(role: 'user' | 'assistant', content: string): ChatMessage {
  return {
    id: `${role}-${content.replace(/\s+/g, '-').slice(0, 12)}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

describe('ChatPage #269 AC11: a mid-stream switch lands the buffered tail in the owning record', () => {
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('switching A -> B with tokens still buffered saves to A a thread holding every buffered token and no B message (#269 AC11)', async () => {
    vi.useFakeTimers();

    const TOKENS = ['T1-', 'T2-', 'T3-TAIL'];
    const FULL = TOKENS.join('');
    const yielded: string[] = [];

    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(async function* (): AsyncGenerator<RAGEvent> {
      for (const t of TOKENS) {
        yielded.push(t);
        yield { type: 'token', data: t };
      }
      // Park forever: the only flush of the buffer is the switch's cancel.
      await new Promise<void>(() => {});
    });

    const onSaveConversation = vi.fn();
    const setCurrentConversationId = vi.fn();

    const userMsg = makeMessage('user', 'A-QUESTION');
    const bUserMsg = makeMessage('user', 'B-QUESTION');

    type View = { convId: string; messages: ChatMessage[] };
    let view: View = { convId: 'A', messages: [userMsg] };

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

    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A-QUESTION' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });
    // Microtasks only (no timer advance): the orchestrator yields every token
    // into the TokenStreamManager buffer; the RAF flush never fires.
    await act(async () => {
      for (let i = 0; i < 40 && yielded.length < TOKENS.length; i++) await Promise.resolve();
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
    expect(yielded, 'sanity: every token must have been pushed before the switch').toEqual(TOKENS);
    expect(
      view.messages.some((m) => m.role === 'assistant' && m.content === '' && m.isStreaming === true),
      'sanity: the tokens are still BUFFERED (the live assistant message is still empty)'
    ).toBe(true);

    // Isolate the switch save from the send-time save.
    onSaveConversation.mockClear();

    // --- Switch to B while the tail is buffered -------------------------------
    await act(async () => {
      view = { convId: 'B', messages: [bUserMsg] };
      rerender(<Harness />);
    });
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });

    // === ASSERTIONS ===========================================================
    const savesToA = onSaveConversation.mock.calls.filter(([id]) => id === 'A');
    expect(savesToA.length, 'the switch must persist the owning turn to A').toBeGreaterThanOrEqual(1);
    const savedToA = savesToA[savesToA.length - 1][1] as ChatMessage[];

    // Every buffered token must be in A's saved thread (base saves BEFORE the
    // cancel flush, so the persisted assistant content is still '').
    const persistedContent = savedToA
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('');
    expect(
      persistedContent,
      'A\'s saved thread must contain every token that was buffered at the switch'
    ).toBe(FULL);

    // And no B message may leak into A's record.
    expect(
      savedToA.some((m) => m.content.includes('B-QUESTION')),
      'A\'s saved thread must not contain any B message'
    ).toBe(false);

    // No save may target B for this turn.
    expect(onSaveConversation.mock.calls.filter(([id]) => id === 'B').length).toBe(0);
  });
});
