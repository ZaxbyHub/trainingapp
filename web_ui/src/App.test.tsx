/**
 * App-level regression test for Issue #21 acceptance criterion 2 (AC2):
 * "switching between pages (Chat -> Documents/Settings -> Chat) does not lose
 * the conversation."
 *
 * App.tsx satisfies AC2 by calling `useConversations()` in `AppContent` —
 * *above* `renderPage()` — so `currentMessages` / `setCurrentMessages` are
 * lifted out of `ChatPage` and survive its unmount/remount when the user
 * navigates away and back. Before this test existed there was NO coverage at
 * all for App.tsx, so a future regression (e.g. moving `useConversations()`
 * back inside ChatPage, or breaking the messages/onMessagesChange prop
 * threading) would go undetected until a user actually lost a conversation.
 *
 * This test renders the REAL `App` component tree with the REAL
 * `useConversations` hook (only its IndexedDB-backed persistence layer,
 * `../db/conversations`, is mocked — following the convention already used
 * in `hooks/useConversations.test.ts`) and the REAL `ChatPage`, so a genuine
 * user message send actually flows through `onMessagesChange` into the
 * lifted `currentMessages` state. Only genuinely heavy/unrelated
 * dependencies are mocked out (LLM services, RAG orchestrator, streaming,
 * inference-mode context, service initialization, and the Documents/Settings
 * pages, which are irrelevant to the AC2 regression this test guards).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import App from './App';

// --- Conversation persistence layer: mock only the Dexie/IndexedDB boundary,
// exactly as hooks/useConversations.test.ts does, so the REAL useConversations
// hook (and its state-lifting behavior) is genuinely exercised. ---
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

// --- Inference mode context: same shape used by ChatPage.init.test.tsx.
// App.tsx imports directly from './lib/inference/InferenceModeContext'; the
// barrel at './lib/inference' (used by ChatPage) re-exports the same module,
// so mocking this one path covers both call sites. ---
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

// --- ChatPage's LLM/RAG/streaming dependencies: same mocking convention as
// ChatPage.init.test.tsx, so real ChatPage renders and a real send actually
// produces a user + assistant message pair without pulling in the WASM/
// edgevec-backed RAG pipeline. ---
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

// --- Documents/Settings pages: irrelevant to the AC2 regression under test
// (they have their own heavy IndexedDB/model-management dependencies) —
// replaced with trivial markers so navigation can be asserted without
// pulling those subsystems in. ---
vi.mock('./pages/DocumentsPage', () => ({
  DocumentsPage: () => <div data-testid="documents-page-marker">Documents Page</div>,
}));
vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page-marker">Settings Page</div>,
}));

describe('App — AC2: navigating between pages preserves the conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps chat messages after navigating Chat -> Documents -> Chat', async () => {
    render(<App />);

    // Chat is the default page; send a real message through the real ChatPage.
    const textarea = await screen.findByPlaceholderText('Ask a question...');
    fireEvent.change(textarea, { target: { value: 'Hello from AC2 test' } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      expect(screen.getByText('Hello from AC2 test')).toBeInTheDocument();
    });

    // Navigate away to Documents — this unmounts ChatPage.
    const documentsNavButton = screen.getByRole('button', { name: 'Documents' });
    fireEvent.click(documentsNavButton);

    await waitFor(() => {
      expect(screen.getByTestId('documents-page-marker')).toBeInTheDocument();
    });
    expect(screen.queryByText('Hello from AC2 test')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Ask a question...')).not.toBeInTheDocument();

    // Navigate back to Chat — this remounts ChatPage. The regression this
    // test guards: if useConversations() were ever moved back inside
    // ChatPage (or the messages/onMessagesChange props were broken), the
    // message below would be gone because ChatPage's local state would have
    // reset on remount instead of reading from AppContent's lifted state.
    const chatNavButton = screen.getByRole('button', { name: 'Chat' });
    fireEvent.click(chatNavButton);

    await waitFor(() => {
      expect(screen.getByText('Hello from AC2 test')).toBeInTheDocument();
    });
  });

  it('keeps chat messages after navigating Chat -> Settings -> Chat', async () => {
    render(<App />);

    const textarea = await screen.findByPlaceholderText('Ask a question...');
    fireEvent.change(textarea, { target: { value: 'Second round trip' } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      expect(screen.getByText('Second round trip')).toBeInTheDocument();
    });

    const settingsNavButton = screen.getByRole('button', { name: 'Settings' });
    fireEvent.click(settingsNavButton);

    await waitFor(() => {
      expect(screen.getByTestId('settings-page-marker')).toBeInTheDocument();
    });
    expect(screen.queryByText('Second round trip')).not.toBeInTheDocument();

    const chatNavButton = screen.getByRole('button', { name: 'Chat' });
    fireEvent.click(chatNavButton);

    await waitFor(() => {
      expect(screen.getByText('Second round trip')).toBeInTheDocument();
    });
  });
});
