/**
 * PRE-2: cancelling a generation must not announce "Response complete".
 *
 * Drives the REAL ChatPage + ChatMessageList + TokenStreamManager: a stream is
 * parked mid-answer, the user presses Stop, and the visually-hidden status
 * region inside the chat log must say "Response stopped". A second case lets a
 * stream finish normally and expects "Response complete", so the assertion is
 * not satisfied by an always-silent region.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RAGEvent } from '../lib/rag/rag-orchestrator';

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
vi.mock('../lib/api/auth', () => ({ getToken: vi.fn().mockReturnValue(null) }));
vi.mock('../hooks/useDocumentCount', () => ({
  useDocumentCount: () => ({ count: 3, loading: false }),
}));

import { ChatPage } from './ChatPage';
import * as ragModule from '../lib/rag/rag-orchestrator';
import * as inferenceModule from '../lib/inference';
import type { ChatMessage } from '../types/chat';

/** Parks after one token until `gate` resolves; yields `complete` only when `finish` is set. */
function parkedStream(gate: Promise<void>, finish: boolean): () => AsyncGenerator<RAGEvent> {
  return async function* (): AsyncGenerator<RAGEvent> {
    yield { type: 'token', data: 'partial ' };
    await gate;
    if (finish) {
      yield { type: 'complete', data: { answer: 'partial answer', sources: [], chunks: [], grounding: 'grounded' } };
    }
  };
}

function statusText(): string {
  const log = screen.getByRole('log');
  return Array.from(log.querySelectorAll('[role="status"].ui-visually-hidden'))
    .map((n) => n.textContent ?? '')
    .join('|');
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function Page({
  onSaveConversation,
}: {
  // #269 AC7 (C6): the harness accepts a save observer; default no-op keeps
  // the four announcement tests byte-identical in behavior.
  onSaveConversation?: React.ComponentProps<typeof ChatPage>['onSaveConversation'];
}) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  return (
    <ChatPage
      messages={messages}
      onMessagesChange={(next) =>
        setMessages((prev) => (typeof next === 'function' ? (next as (p: typeof prev) => typeof prev)(prev) : next))
      }
      onSaveConversation={onSaveConversation ?? (() => {})}
      currentConversationId="conv-1"
      setCurrentConversationId={() => {}}
      onNewChat={() => {}}
      onOpenSettings={() => {}}
    />
  );
}

describe('ChatPage live-region announcement on Stop (PRE-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    cleanup();
  });

  let orchestrator: { query: ReturnType<typeof vi.fn> };
  async function send(text: string) {
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });
    await flush();
  }
  async function startTurn(gate: Promise<void>, finish: boolean, onSaveConversation?: React.ComponentProps<typeof ChatPage>['onSaveConversation']) {
    orchestrator = { query: vi.fn().mockImplementation(parkedStream(gate, finish)) };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(() => orchestrator as unknown as ragModule.RAGOrchestrator);
    const view = render(<Page onSaveConversation={onSaveConversation} />);
    await send('Question');
    return view;
  }

  test('Stop announces "Response stopped" and never "Response complete"', async () => {
    await startTurn(new Promise<void>(() => {}), false); // never resolves: parked mid-answer
    fireEvent.click(await screen.findByRole('button', { name: /stop generation/i }));
    await flush();
    expect(screen.queryByRole('button', { name: /stop generation/i })).toBeNull();
    expect(statusText()).toContain('Response stopped');
    expect(statusText()).not.toContain('Response complete');
  });

  test('L4: after a Stop, the next turn resets the stopped flag and its normal finish says "Response complete"', async () => {
    await startTurn(new Promise<void>(() => {}), false);
    fireEvent.click(await screen.findByRole('button', { name: /stop generation/i }));
    await flush();
    expect(statusText()).toContain('Response stopped');

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    orchestrator.query.mockImplementation(parkedStream(gate, true));
    await send('Again');
    await act(async () => {
      release();
    });
    await flush();
    expect(statusText()).toContain('Response complete');
    expect(statusText()).not.toContain('Response stopped');
  });

  test('L1: switching the browser engine mid-answer announces "Response stopped"', async () => {
    const { rerender } = await startTurn(new Promise<void>(() => {}), false);
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      ...vi.mocked(inferenceModule.useInferenceMode)(),
      browserEngine: 'webllm',
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
    rerender(<Page />);
    await flush();
    expect(screen.queryByRole('button', { name: /stop generation/i })).toBeNull();
    expect(statusText()).toContain('Response stopped');
    expect(statusText()).not.toContain('Response complete');
  });

  test('a stream that finishes on its own still announces "Response complete"', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await startTurn(gate, true);
    await act(async () => {
      release();
    });
    await flush();
    expect(statusText()).toContain('Response complete');
    expect(statusText()).not.toContain('Response stopped');
  });

  test('Stop persists the assistant message with stopped:true (C6)', async () => {
    // Issue #269 AC7 (claim 7): base's handleCancel finalizes only
    // `isStreaming`, so after a reload a stopped answer is indistinguishable
    // from a finished one. The cancel-path save must carry `stopped: true`.
    const onSaveConversation = vi.fn();
    await startTurn(new Promise<void>(() => {}), false, onSaveConversation); // parked mid-answer
    fireEvent.click(await screen.findByRole('button', { name: /stop generation/i }));
    await flush();

    expect(onSaveConversation.mock.calls.length, 'Stop must persist the finalized turn').toBeGreaterThanOrEqual(1);
    const lastCall = onSaveConversation.mock.calls[onSaveConversation.mock.calls.length - 1];
    expect(lastCall[0], 'the Stop save targets the owning conversation').toBe('conv-1');
    const persisted = lastCall[1] as ChatMessage[];
    const assistant = persisted.find((m) => m.role === 'assistant');
    expect(assistant, 'the truncated assistant message must be persisted').toBeDefined();
    // The cancel flush (PRR-005) keeps the streamed partial in the save.
    expect(assistant?.content).toContain('partial');
    expect(assistant?.isStreaming).toBeFalsy();
    // The marker under test (#269): undefined at base.
    expect((assistant as ChatMessage & { stopped?: boolean })?.stopped).toBe(true);
  });
});
