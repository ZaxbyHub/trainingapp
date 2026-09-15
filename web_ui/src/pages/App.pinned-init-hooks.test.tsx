/**
 * Regression test (issue #83 CI failure, 2026-09-15): the D7 staleness
 * producer's useEffect was originally registered AFTER AppContent's
 * `if (!isInitialized)` early return. On a REAL boot the init gate starts
 * false and lifts to true, so the hook count grew between renders and the
 * renderer crashed with React error #310 ("Rendered more hooks than during
 * the previous render") exactly when first-run init completed — caught by the
 * Playwright-under-Electron smoke, invisible to unit suites that mock the
 * gate as always-initialized.
 *
 * This test drives the gate flip for real: render with the gate closed, then
 * lift it. With the hook correctly registered above the early return, the app
 * survives the flip and mounts the chat input; with the regression, React
 * throws #310, the ErrorBoundary catches, and the chat input never appears.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// The init gate is a module-level mock with a FLIPPABLE flag (unlike the
// always-initialized mocks used elsewhere — that's the point).
const initCtrl = vi.hoisted(() => ({ isInitialized: false }));

vi.mock('../hooks/useServiceInitialization', () => ({
  useServiceInitialization: () => ({
    isInitialized: initCtrl.isInitialized,
    initError: null,
    currentStep: initCtrl.isInitialized ? 'Ready' : 'Loading services…',
  }),
}));

vi.mock('../db/conversations', () => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(async () => undefined),
  createConversation: vi.fn(async () => undefined),
  updateConversation: vi.fn(async () => undefined),
  deleteConversation: vi.fn(async () => undefined),
  countConversations: vi.fn(async () => 0),
}));

vi.mock('../lib/inference/InferenceModeContext', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => ({
    mode: 'browser-local',
    browserEngine: 'wllama',
    ragPreset: 'balanced',
    isModelReady: true,
    isServerConnected: true,
    modelLoadingProgress: 100,
    serverUrl: '',
    setMode: vi.fn(),
    setBrowserEngine: vi.fn(),
    setRagPreset: vi.fn(),
    setServerUrl: vi.fn(),
    checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
    setModelReady: vi.fn(),
    setModelLoadingProgress: vi.fn(),
    modeError: null,
  }),
}));

const originalPathname = window.location.pathname;
const originalSearch = window.location.search;

vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(function () {
    return {
      onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn(), pushToken: vi.fn(),
      complete: vi.fn(), error: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
      startSSEStream: vi.fn(),
    };
  }),
}));
vi.mock('../components/StreamingIndicator', () => ({ StreamingIndicator: () => null }));
vi.mock('../components/InferenceModeToggle', () => ({ InferenceModeToggle: () => null }));
vi.mock('./DocumentsPage', () => ({ DocumentsPage: () => <div data-testid="documents-page-marker" /> }));
vi.mock('./SettingsPage', () => ({ SettingsPage: () => <div data-testid="settings-page-marker" /> }));

vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn(),
}));
vi.mock('../lib/llm/llm-factory', () => ({
  DEFAULT_BROWSER_ENGINE: 'wllama',
  getLLMService: vi.fn(),
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn(() => 'wllama'),
}));

// Import the component under test AFTER the mocks are in place.
import App from '../App';

describe('D7 hook-order across the boot gate (issue #83 CI regression)', () => {
  beforeEach(() => {
    initCtrl.isInitialized = false;
  });

  afterEach(() => {
    cleanup();
    window.history.pushState({}, '', originalPathname + originalSearch);
  });

  it('survives the init gate lifting without a React #310 hook-order crash', async () => {
    const { rerender } = render(<App />);

    // Gate closed: the loading overlay shows, no chat input yet.
    expect(screen.queryByPlaceholderText(/Ask a question/)).toBeNull();

    // Gate lifts (the exact transition that crashed CI with React #310 when
    // the staleness effect was registered below the early return).
    initCtrl.isInitialized = true;
    rerender(<App />);

    // The app must mount the real chat page, not the ErrorBoundary fallback.
    const input = await screen.findByPlaceholderText(/Ask a question/, {}, { timeout: 3000 });
    expect(input).toBeInTheDocument();
  });
});
