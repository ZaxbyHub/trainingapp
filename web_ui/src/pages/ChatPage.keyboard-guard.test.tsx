/**
 * F-CTRL-ENTER-BYPASS regression coverage (PR #28 review, closeout critic
 * pass): ChatPage.tsx's global Ctrl+Enter handler
 * (`onSendMessage` passed to `useKeyboardShortcuts`) guards on
 * `draft && !tokenStreamManagerRef.current && !isInputDisabled` — the
 * `!isInputDisabled` clause was added so Ctrl+Enter can't bypass the
 * model-blocked overlay (`isModelBlocked` -> `isInputDisabled`) and fire a
 * send while the app has no usable model. No test previously exercised this
 * specific guard in isolation.
 *
 * This file mirrors the mocking conventions established in
 * ChatPage.overlay.test.tsx (model-blocked state via `useInferenceMode`) and
 * ChatPage.init.test.tsx (direct `textarea` draft entry + RAGOrchestrator
 * spy), but drives the send path via a global `keydown` (Ctrl+Enter)
 * dispatched on `window` rather than a click on the Send button, since the
 * bug this guards against is specific to the global keyboard-shortcut path.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ChatPage } from './ChatPage';

// Spy on RAGOrchestrator.query so we can assert the send path was never
// reached — a more direct signal than inspecting internal state.
const mockQuery = vi.fn(async function* () {
  yield { type: 'complete', data: { answer: 'ok', sources: [], chunks: [] } };
});

vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(() => ({
    query: mockQuery,
  })),
}));

vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: () => ({
    initialize: vi.fn(async () => undefined),
    generate: async function* () { yield 'ok'; },
    generateComplete: async () => 'ok',
    isReady: () => false,
    getModelInfo: () => null,
    getInferenceMode: () => 'wasm' as const,
    supportsImages: () => false,
    interrupt: () => undefined,
  }),
  disposeBrowserEngine: () => undefined,
  getPreferredBrowserEngine: () => 'wllama',
}));

// isModelReady: false + mode: 'browser-local' => isModelBlocked => isInputDisabled,
// which is the exact condition the Ctrl+Enter guard must respect.
vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => ({
    mode: 'browser-local',
    browserEngine: 'wllama',
    ragPreset: 'balanced',
    isModelReady: false,
    isServerConnected: true,
    modelLoadingProgress: 0,
    serverUrl: '',
    setModelLoadingProgress: vi.fn(),
    setMode: vi.fn(),
    setBrowserEngine: vi.fn(),
    setRagPreset: vi.fn(),
    setServerUrl: vi.fn(),
    checkServerConnectivity: vi.fn(),
    setModelReady: vi.fn(),
    modeError: null,
  }),
}));

vi.mock('../lib/llm/readiness-gate', () => ({
  getReadinessSnapshot: () => ({ modelCached: false, webgpuAvailable: false }),
  getReadinessResultSnapshot: () => null,
  getReadinessGateInstance: () => null,
  applyReadinessFromEvent: vi.fn(),
  resetReadinessCache: vi.fn(),
  ensureReadinessGateChecked: vi.fn(async () => null),
}));

vi.mock('../components/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
}));
vi.mock('../components/InferenceModeToggle', () => ({
  InferenceModeToggle: () => null,
}));
vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(() => ({
    onToken: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    pushToken: vi.fn(),
    complete: vi.fn(),
    error: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  })),
}));

describe('ChatPage — Ctrl+Enter guard while model-blocked (F-CTRL-ENTER-BYPASS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });
  afterEach(() => cleanup());

  it('does not send when the model is blocked, even with a non-empty draft and no in-flight stream', () => {
    const { container } = render(
      <ChatPage
        messages={[]}
        onMessagesChange={() => {}}
        onSaveConversation={() => {}}
        onNewChat={() => {}}
        currentConversationId={undefined}

        setCurrentConversationId={() => {}}

        onOpenSettings={() => {}}
      />
    );

    // Confirm the model-blocked overlay is actually up, so this test is
    // exercising the intended precondition rather than an accidental
    // non-blocked render.
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    // Populate the draft the same way ChatInput does (onDraftChange mirrors
    // its textarea value into ChatPage's draftRef), so the Ctrl+Enter
    // handler sees a non-empty, non-whitespace draft.
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'this should not send' } });

    // Dispatch the global Ctrl+Enter shortcut on window (not on the
    // textarea) — useKeyboardShortcuts bails early for INPUT/TEXTAREA/SELECT
    // targets, and the bug this test guards against is specifically about
    // the window-level listener bypassing the model-blocked state.
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });

    // The send path (RAGOrchestrator.query) must never be reached.
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
