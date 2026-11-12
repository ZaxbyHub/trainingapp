/**
 * TST-2/TST-3 (#267 live wiring): ChatPage's registration of
 * useKeyboardShortcuts against the REAL mounted tree — the shortcut handlers
 * ChatPage passes (onFocusComposer, onClearChat, onStopGeneration) must reach
 * the production components, not just the hook's own unit contract (which the
 * useKeyboardShortcuts.* hook specs pin in isolation).
 *
 * Three legs, all through real keydown events:
 *   (a) Ctrl+K while focus is on document.body moves focus to the REAL
 *       'Message input' textarea — covers ChatPage's onFocusComposer binding
 *       AND ChatInput's textareaRef forwarding (the merged ref the shortcut
 *       focuses through);
 *   (b) Ctrl+Shift+L pressed INSIDE that textarea reaches the production
 *       data-chat-composer carve-out and drives the real clear-chat path
 *       (confirm state, then onNewChat + the cleared messages report);
 *   (c) Escape while a generation is in flight drives the real stop path —
 *       the same terminalizeStream('stop') protocol as the Stop button
 *       ('Response stopped' announced, Stop button released).
 *
 * Harness: ChatPage.keyboard-guard.test.tsx's mocking bridge (mocked
 * llm-factory / inference / readiness-gate, real ChatInput and real
 * useKeyboardShortcuts) combined with ChatPage.stop-announcement.test.tsx's
 * parked-stream RAG generator for leg (c) — that pattern is proven in this
 * suite and is NOT quarantined.
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

/** The composer textarea through its accessible name (the real ChatInput). */
function composer(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement;
}

function statusText(): string {
  const log = screen.getByRole('log');
  return Array.from(log.querySelectorAll('[role="status"].ui-visually-hidden'))
    .map((n) => (n.textContent ?? ''))
    .join('|');
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

/** Stateful messages holder mirroring the App's controlled-messages contract. */
function Page({ initialMessages, onNewChat }: { initialMessages: ChatMessage[]; onNewChat: () => void }) {
  const [messages, setMessages] = React.useState<ChatMessage[]>(initialMessages);
  return (
    <ChatPage
      messages={messages}
      onMessagesChange={(next) =>
        setMessages((prev) => (typeof next === 'function' ? (next as (p: typeof prev) => typeof prev)(prev) : next))
      }
      onSaveConversation={() => {}}
      currentConversationId="conv-1"
      setCurrentConversationId={() => {}}
      onNewChat={onNewChat}
      onOpenSettings={() => {}}
    />
  );
}

describe('ChatPage keyboard-shortcut live wiring (#267, TST-2/TST-3)', () => {
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

  test('(a) Ctrl+K from document.body focuses the real Message input textarea (onFocusComposer + textareaRef forwarding)', () => {
    render(<Page initialMessages={[]} onNewChat={() => {}} />);
    const textarea = composer();
    // ChatInput's focus-restoration effect focuses on mount; move focus to
    // body so the shortcut's focus move is observable (not pre-satisfied).
    act(() => {
      textarea.blur();
    });
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    // The global shortcut focused the REAL composer textarea through
    // ChatPage's composerTextareaRef → ChatInput's merged textareaRef.
    expect(document.activeElement).toBe(textarea);
  });

  test('(b) Ctrl+Shift+L inside the composer drives the production clear-chat path (data-chat-composer carve-out)', async () => {
    const onNewChat = vi.fn();
    const initialMessages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: 2 },
    ];
    render(<Page initialMessages={initialMessages} onNewChat={onNewChat} />);
    const textarea = composer();
    act(() => {
      textarea.focus();
    });

    // First press (from INSIDE the composer — an editable target): the
    // composer carve-out lets the shortcut through; the real handler arms the
    // confirm state (the header button flips to "Confirm Clear?").
    fireEvent.keyDown(textarea, { key: 'L', ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole('button', { name: /confirm clear\?/i })).toBeDefined();
    expect(onNewChat).not.toHaveBeenCalled();

    // Second press within the window: the real clear path runs — messages
    // cleared (the header clear affordance disappears with them) and the
    // App-level onNewChat fires.
    fireEvent.keyDown(textarea, { key: 'L', ctrlKey: true, shiftKey: true });
    await flush();
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /clear chat/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /confirm clear\?/i })).toBeNull();
  });

  test('(c) Escape while a generation is in flight drives the real stop path (Response stopped, Stop released)', async () => {
    // Parked stream: one token, then never resolves — the turn stays in
    // flight (isLoading true) until the stop path terminalizes it.
    const orchestrator = {
      query: vi.fn(
        async function* (): AsyncGenerator<RAGEvent> {
          yield { type: 'token', data: 'partial ' };
          await new Promise<void>(() => {});
        },
      ),
    };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => orchestrator as unknown as ragModule.RAGOrchestrator,
    );
    render(<Page initialMessages={[]} onNewChat={() => {}} />);

    await act(async () => {
      fireEvent.change(composer(), { target: { value: 'streaming question' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });
    await flush();

    // In flight: the Stop affordance is up (isGenerating true for the hook).
    expect(screen.getByRole('button', { name: /stop generation/i })).toBeDefined();

    // Escape on window: the hook's onStopGeneration binding — ChatPage's
    // handleCancel — runs the single terminalization protocol.
    fireEvent.keyDown(window, { key: 'Escape' });
    await flush();

    expect(screen.queryByRole('button', { name: /stop generation/i })).toBeNull();
    expect(statusText()).toContain('Response stopped');
    expect(statusText()).not.toContain('Response complete');
  });
});
