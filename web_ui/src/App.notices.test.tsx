/**
 * Lumen phase 7: the App-level non-blocking notices (persistence error, degraded
 * search) are ui/Banner with Lumen tokens and no inline styles; dismiss/retry are
 * real buttons found by role.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App from './App';

const state = vi.hoisted(() => ({
  initError: null as string | null,
  persistenceError: null as string | null,
  clearPersistenceError: vi.fn(),
}));

vi.mock('./hooks/useConversations', () => ({
  useConversations: () => ({
    conversations: [],
    currentConversationId: undefined,
    currentMessages: [],
    setCurrentMessages: vi.fn(),
    setCurrentConversationId: vi.fn(),
    selectConversation: vi.fn(),
    newChat: vi.fn(),
    saveMessages: vi.fn(),
    removeConversation: vi.fn(),
    renameConversation: vi.fn(),
    hasMore: false,
    loadMore: vi.fn(),
    persistenceError: state.persistenceError,
    clearPersistenceError: state.clearPersistenceError,
    searchQuery: '',
    setSearchQuery: vi.fn(),
    searchResults: null,
    searchTruncated: false,
    isSearching: false,
  }),
}));
vi.mock('./hooks/useServiceInitialization', () => ({
  useServiceInitialization: () => ({
    isInitialized: true,
    initError: state.initError,
    currentStep: 'Ready',
    servicesReady: { embeddings: true, vectorIndex: true, keywordIndex: true, modelCached: true, webgpuAvailable: false },
  }),
}));
vi.mock('./db/conversations', () => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(async () => undefined),
  createConversation: vi.fn(async () => undefined),
  updateConversation: vi.fn(async () => undefined),
  deleteConversation: vi.fn(async () => undefined),
  countConversations: vi.fn(async () => 0),
}));
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


beforeEach(() => {
  state.initError = null;
  state.persistenceError = null;
  state.clearPersistenceError = vi.fn();
});
afterEach(() => {
  cleanup();
  // PRR-151-061: undo stubGlobal here so a failing assertion can never leak the
  // `location` stub into the next test.
  vi.unstubAllGlobals();
});

describe('App notices (Lumen phase 7)', () => {
  it('persistence error: a danger Banner (alert) with a Dismiss button that clears it', () => {
    state.persistenceError = 'Could not save the conversation';
    render(<App />);
    const alert = screen.getByText('Could not save the conversation').closest('.ui-banner') as HTMLElement;
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveClass('ui-banner--danger', 'app-notice');
    expect(alert.querySelectorAll('[style]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(state.clearPersistenceError).toHaveBeenCalledTimes(1);
  });

  it('degraded search: a polite status Banner with Retry (reload) and Dismiss', () => {
    state.initError = 'vector index failed';
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<App />);
    const banner = screen.getByText(/Search is degraded/).closest('.ui-banner') as HTMLElement;
    expect(banner).toHaveTextContent('vector index failed');
    expect(banner).toHaveClass('ui-banner--warning');
    // Announced by the enclosing polite status region, not as a second alert.
    expect(banner).not.toHaveAttribute('role');
    const status = banner.parentElement as HTMLElement;
    expect(status).toHaveAttribute('role', 'status');
    expect(status.querySelectorAll('[style]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss degraded-search notice' }));
    expect(screen.queryByText(/Search is degraded/)).toBeNull();
  });

  it('PRR-151-011: a dismissed degraded-search notice re-arms on a NEW distinct failure, not on the same one', () => {
    state.initError = 'vector index failed';
    const { rerender } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss degraded-search notice' }));
    expect(screen.queryByText(/Search is degraded/)).toBeNull();
    // Same error again: stays dismissed.
    rerender(<App />);
    expect(screen.queryByText(/Search is degraded/)).toBeNull();
    // The hook appends later failures to the same string: a distinct failure re-arms.
    state.initError = 'vector index failed; keyword index failed';
    rerender(<App />);
    expect(screen.getByText(/Search is degraded/)).toHaveTextContent('keyword index failed');
  });

  it('PRR-151-012: the degraded-search polite region is mounted before the notice and its text changes in place', () => {
    const { rerender } = render(<App />);
    const before = Array.from(document.querySelectorAll('[role="status"]'));
    state.initError = 'vector index failed';
    rerender(<App />);
    const banner = screen.getByText(/Search is degraded/).closest('.ui-banner') as HTMLElement;
    // The notice sits in a region element that already existed (inserted-with-content would be a new node).
    expect(before).toContain(banner.parentElement);
  });

  it('renders neither notice when there is no error', () => {
    render(<App />);
    expect(screen.queryByText(/Search is degraded/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss error' })).toBeNull();
  });
});
