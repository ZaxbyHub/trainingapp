/**
 * App-level regression test for F-KEYBOARD-REGRESSION (PR #28 / issue #21
 * follow-up, see F-STALE-TEST-DOC).
 *
 * `App.tsx`'s `AppContent` now registers the global
 * `useKeyboardShortcuts({ onOpenSettings: openSettings })` at the App level
 * (see the comment above that call in App.tsx), specifically so Ctrl/Cmd+,
 * opens Settings from *any* page — not only while ChatPage happens to be
 * mounted (ChatPage has its own, chat-scoped `useKeyboardShortcuts` call for
 * send/clear-chat, and also wires Ctrl+, for its own model-blocked overlay,
 * but that registration disappears whenever ChatPage unmounts).
 *
 * Before this fix, Ctrl+, only worked while on the Chat page. The intended
 * regression test for this (`ChatPage.shortcuts.test.tsx`) is excluded from
 * CI (see `vitest.config.ts`'s `exclude` list, a pre-existing/unrelated
 * concern), so it provides no real protection today. This file is NOT
 * excluded and asserts the actual end-to-end behavior: dispatching a real
 * `keydown` on `window` while a NON-chat page (Documents) is showing still
 * navigates to Settings, proving the hook is registered above the page
 * switch rather than inside ChatPage.
 *
 * Mocking follows the same convention as `App.test.tsx`: only the heavy/
 * unrelated dependency graph (IndexedDB conversation persistence, service
 * initialization, inference-mode context, LLM/RAG/streaming internals, and
 * the Documents/Settings pages) is mocked out. `useKeyboardShortcuts` itself
 * is deliberately left un-mocked — it is the exact thing under test.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import App from './App';

// --- Conversation persistence layer: mock only the Dexie/IndexedDB boundary,
// same as App.test.tsx / hooks/useConversations.test.ts. ---
vi.mock('./db/conversations', () => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(async () => undefined),
  createConversation: vi.fn(async () => undefined),
  updateConversation: vi.fn(async () => undefined),
  deleteConversation: vi.fn(async () => undefined),
  countConversations: vi.fn(async () => 0),
}));

// --- Service initialization: skip the real (heavy) vector/keyword index boot
// so App renders past the LoadingOverlay immediately. ---
vi.mock('./hooks/useServiceInitialization', () => ({
  useServiceInitialization: () => ({
    isInitialized: true,
    initError: null,
    currentStep: 'Ready',
    servicesReady: {
      embeddings: true,
      vectorIndex: true,
      keywordIndex: true,
      modelCached: true,
      webgpuAvailable: false,
    },
  }),
}));

// --- Inference mode context: same shape used by App.test.tsx / ChatPage.init.test.tsx. ---
vi.mock('./lib/inference/InferenceModeContext', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => ({
    mode: 'browser-local',
    browserEngine: 'wllama',
    ragPreset: 'balanced',
    isModelReady: true,
    isServerConnected: true,
    modelLoadingProgress: 100,
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

// --- ChatPage's LLM/RAG/streaming dependencies: ChatPage is the default page,
// so it mounts on initial render and needs the same mocking as App.test.tsx. ---
const fakeLlmService = {
  initialize: vi.fn(async () => undefined),
  generate: async function* () { yield 'ok'; },
  generateComplete: async () => 'ok',
  isReady: () => true,
  getModelInfo: () => null,
  getInferenceMode: () => 'wasm' as const,
  supportsImages: () => false,
  interrupt: () => undefined,
};

vi.mock('./lib/llm/llm-factory', () => ({
  getLLMService: () => fakeLlmService,
  disposeBrowserEngine: () => undefined,
  getPreferredBrowserEngine: () => 'wllama',
}));

vi.mock('./lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(() => ({
    query: async function* () {
      yield { type: 'complete', data: { answer: 'Assistant reply', sources: [], chunks: [] } };
    },
  })),
}));

vi.mock('./components/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
}));
vi.mock('./components/InferenceModeToggle', () => ({
  InferenceModeToggle: () => null,
}));
vi.mock('./lib/streaming', () => ({
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

// --- Documents/Settings pages: replaced with trivial markers so navigation
// can be asserted without pulling in their own heavy dependency graphs. ---
vi.mock('./pages/DocumentsPage', () => ({
  DocumentsPage: () => <div data-testid="documents-page-marker">Documents Page</div>,
}));
vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page-marker">Settings Page</div>,
}));

describe('App — F-KEYBOARD-REGRESSION: global Ctrl+, works from any page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('navigates to Settings on Ctrl+, while the Documents page (not Chat) is showing', async () => {
    render(<App />);

    // Leave the default Chat page for Documents — this unmounts ChatPage,
    // along with its own chat-scoped useKeyboardShortcuts registration.
    const documentsNavButton = screen.getByRole('button', { name: 'Documents' });
    fireEvent.click(documentsNavButton);

    await waitFor(() => {
      expect(screen.getByTestId('documents-page-marker')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('settings-page-marker')).not.toBeInTheDocument();

    // Dispatch a real Ctrl+, keydown on window — exactly what App-level
    // useKeyboardShortcuts listens for. If the global registration in
    // AppContent regressed (e.g. moved back into ChatPage-only), this event
    // would have no listener to reach while Documents is showing.
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByTestId('settings-page-marker')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('documents-page-marker')).not.toBeInTheDocument();
  });

  it('does not navigate on a plain "," keydown (no Ctrl/Cmd) while on Documents', async () => {
    render(<App />);

    const documentsNavButton = screen.getByRole('button', { name: 'Documents' });
    fireEvent.click(documentsNavButton);

    await waitFor(() => {
      expect(screen.getByTestId('documents-page-marker')).toBeInTheDocument();
    });

    // Negative control: without the modifier key, useKeyboardShortcuts should
    // ignore the event entirely, proving the prior assertion isn't trivially
    // true (e.g. a mis-registered listener firing on any keydown).
    fireEvent.keyDown(window, { key: ',' });

    // Give any (incorrect) async navigation a chance to happen before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByTestId('documents-page-marker')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-page-marker')).not.toBeInTheDocument();
  });
});
