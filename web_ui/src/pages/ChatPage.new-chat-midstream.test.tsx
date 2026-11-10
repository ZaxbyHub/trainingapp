/**
 * ChatPage.new-chat-midstream.test.tsx — issue #269 AC2 (claim 3).
 *
 * WHEN the active conversation is cleared to New Chat (id becomes undefined)
 * while a stream is in flight, THE SYSTEM SHALL display an empty thread and
 * SHALL create the next conversation from the new turn only.
 *
 * Base defect: App's newChat() (and delete-of-active) set the id to undefined
 * and the messages to []. The id change A -> undefined fires the same
 * ChatPage switch effect as an A -> B switch (its guard is
 * `prevConversationIdRef.current !== currentConversationId`), which writes the
 * OWNING conversation A's finalized thread back into the cleared view
 * (`messagesRef.current = finalized; setMessages(finalized)`). The next send
 * then builds `appended` from that restored thread and the create-path save
 * (conversationId === undefined) receives A's old messages plus the new turn,
 * duplicating A.
 *
 * Harness: copied from ChatPage.streaming-persistence.test.tsx (parking
 * stream, lifted `view`, rerender after the switch, then read view.messages).
 * The boundary vi.mock block below is copied verbatim from that sibling suite.
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

// `../lib/streaming` is intentionally NOT mocked: the REAL TokenStreamManager.
import { ChatPage } from './ChatPage';
import * as ragModule from '../lib/rag/rag-orchestrator';
import * as inferenceModule from '../lib/inference';
import * as llmFactoryModule from '../lib/llm/llm-factory';

// --- Helpers (copied from ChatPage.streaming-persistence.test.tsx) ----------

function makeMessage(role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `${role}-${content.replace(/\s+/g, '-').slice(0, 12)}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function flushRafFrames(frames = 3): Promise<void> {
  return new Promise<void>((resolve) => {
    let remaining = frames;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  });
}

async function waitForPartialContent(
  getMessages: () => ChatMessage[],
  partialToken: string,
  maxIters = 40
): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    await Promise.resolve();
    await Promise.resolve();
    await flushRafFrames(2);
    const has = getMessages().some(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes(partialToken)
    );
    if (has) return;
  }
  throw new Error(
    `waitForPartialContent: token "${partialToken}" never appeared in messages after ${maxIters} iterations`
  );
}

/** Yields one token, then parks on `gate` (never resolved here). */
function makeParkingStream(
  gate: { promise: Promise<void>; resolve: () => void },
  token: string
): () => AsyncGenerator<RAGEvent> {
  return async function* (): AsyncGenerator<RAGEvent> {
    yield { type: 'token', data: token };
    await gate.promise;
    yield { type: 'complete', data: { answer: token, sources: [], chunks: [], grounding: 'grounded' } };
  };
}

// --- Suite -------------------------------------------------------------------

describe('ChatPage #269 AC2: New Chat mid-stream keeps the cleared view empty and the next create clean', () => {
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

  test('clearing to New Chat mid-stream displays an empty thread and the next conversation is created from the new turn only (#269 AC2)', async () => {
    const gate = makeDeferred();
    const PARTIAL_TOKEN = 'PARTIAL-A-';

    const orchestrator = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator
    );
    orchestrator.query.mockImplementation(makeParkingStream(gate, PARTIAL_TOKEN));

    const onSaveConversation = vi.fn();
    const setCurrentConversationId = vi.fn();

    const aUserMsg = makeMessage('user', 'A-QUESTION');

    type View = { convId: string | undefined; messages: ChatMessage[] };
    let view: View = { convId: 'A', messages: [aUserMsg] };

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

    // --- Step 1: send in A; the stream parks after one flushed token ---------
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A-QUESTION' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });
    await act(async () => {
      await waitForPartialContent(() => view.messages, PARTIAL_TOKEN);
    });
    expect(
      view.messages.some((m) => m.role === 'assistant' && m.content.includes(PARTIAL_TOKEN)),
      'sanity: the stream must be live in A before New Chat'
    ).toBe(true);

    // --- Step 2: New Chat (App's newChat(): id -> undefined, messages -> []) --
    await act(async () => {
      view = { convId: undefined, messages: [] };
      rerender(<Harness />);
    });
    await act(async () => {
      await flushRafFrames(2);
      await Promise.resolve();
    });

    // === ASSERTION 1: the cleared view stays EMPTY ===========================
    // At base the switch effect restores A's finalized thread into the view.
    expect(view.messages, 'New Chat mid-stream must leave the view empty').toEqual([]);

    // --- Step 3: send the next turn on the cleared view ----------------------
    onSaveConversation.mockClear();
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'NEXT-QUESTION' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });
    // Microtasks only: the send-time (create-path) save fires; the new
    // stream's token stays buffered so the assistant entry is the placeholder.
    await act(async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });

    // === ASSERTION 2: the view is exactly the new turn =======================
    expect(
      view.messages.map((m) => `${m.role}:${m.content}`),
      'the view after the next send must hold only the new turn'
    ).toEqual(['user:NEXT-QUESTION', 'assistant:']);

    // === ASSERTION 3: the create-path save carries ONLY the new turn =========
    const createCalls = onSaveConversation.mock.calls.filter(([id]) => id === undefined);
    expect(createCalls.length, 'the next send must take the create path (undefined id)').toBeGreaterThanOrEqual(1);
    const created = (createCalls[createCalls.length - 1][1] as ChatMessage[]).map((m) => `${m.role}:${m.content}`);
    expect(created, 'the next conversation must be created from the new turn only').toEqual([
      'user:NEXT-QUESTION',
      'assistant:',
    ]);
    expect(
      created.some((c) => c.includes('A-QUESTION')),
      'the created conversation must not start from A\'s old thread'
    ).toBe(false);
  });
});
