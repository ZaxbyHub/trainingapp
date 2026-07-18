/**
 * F-AC7 coverage: the model-blocked overlay (ChatPage.tsx ~lines 534-682,
 * the `isModelBlocked` conditional render with `role="alertdialog"`) has
 * ZERO test coverage across the other ChatPage*.test.tsx files as of PR #28
 * review — none of them mock `../lib/llm/readiness-gate`, so the overlay
 * (when it happens to render at all in those files) only ever shows the
 * generic "Preparing the model…" fallback, never the engine-aware failure
 * headline, the real failures/recommendations lists, or the Retry/Open
 * Settings button wiring. Issue #21 AC7 requires this overlay to be tested.
 *
 * This file mocks `useInferenceMode` to force `isModelReady: false` (which
 * drives `isModelBlocked` in browser-local mode) and mocks
 * `../lib/llm/readiness-gate` so `getReadinessResultSnapshot()` returns a
 * controllable failures/recommendations payload, matching the actual data
 * flow ChatPage.tsx reads from.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatPage } from './ChatPage';
import type { ReadinessResult } from '../lib/llm/model-readiness';
import type { BrowserEngine } from '../types/llm';

// Mutable per-test state read by the mocked modules below. Reassigned in
// each test (not just `beforeEach`) so individual tests can vary engine /
// readiness content without redeclaring the mocks.
interface InferenceState {
  mode: 'browser-local';
  browserEngine: BrowserEngine;
  ragPreset: string;
  isModelReady: boolean;
  isServerConnected: boolean;
  modelLoadingProgress: number;
  serverUrl: string;
  modeError: string | null;
}
let inferenceState: InferenceState = {
  mode: 'browser-local',
  browserEngine: 'wllama',
  ragPreset: 'balanced',
  isModelReady: false,
  isServerConnected: true,
  modelLoadingProgress: 0,
  serverUrl: '',
  modeError: null,
};
let currentReadinessResult: ReadinessResult | null = null;

const mockResetReadinessCache = vi.fn();
const mockEnsureReadinessGateChecked = vi.fn(async (_engine?: BrowserEngine) => null);

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => ({
    ...inferenceState,
    setModelLoadingProgress: vi.fn(),
    setMode: vi.fn(),
    setBrowserEngine: vi.fn(),
    setRagPreset: vi.fn(),
    setServerUrl: vi.fn(),
    checkServerConnectivity: vi.fn(),
    setModelReady: vi.fn(),
  }),
}));

vi.mock('../lib/llm/readiness-gate', () => ({
  getReadinessSnapshot: () => ({ modelCached: false, webgpuAvailable: false }),
  getReadinessResultSnapshot: () => currentReadinessResult,
  getReadinessGateInstance: () => null,
  applyReadinessFromEvent: vi.fn(),
  // Wrapped in a function (not assigned directly) so the reference to
  // mockResetReadinessCache/mockEnsureReadinessGateChecked is resolved lazily
  // at call time, not when this factory executes. `vi.mock` factories run as
  // soon as './ChatPage' is imported — which, per ESM evaluation order,
  // happens BEFORE this file's own top-level `const` declarations run — so a
  // direct property reference here would hit the TDZ (unlike the `callOrder`
  // pattern used elsewhere in this repo, which only reads the outer variable
  // from inside a further-nested closure invoked later, after the whole file
  // has finished loading).
  resetReadinessCache: () => mockResetReadinessCache(),
  ensureReadinessGateChecked: (engine?: BrowserEngine) => mockEnsureReadinessGateChecked(engine),
}));

// Not exercised while blocked, but ChatPage imports them unconditionally.
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
vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(() => ({
    query: async function* () {
      yield { type: 'complete', data: { answer: 'ok', sources: [], chunks: [] } };
    },
  })),
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

function makeReadinessResult(overrides: Partial<ReadinessResult> = {}): ReadinessResult {
  return {
    ready: false,
    checks: {
      webgpu: false,
      modelCached: false,
      memory: { availableBytes: 1_000_000_000, requiredBytes: 2_000_000_000, sufficient: false, tier: 'LOW' },
    },
    failures: [],
    recommendations: [],
    ...overrides,
  };
}

function renderChatPage(onOpenSettings: () => void = () => {}) {
  return render(
    <ChatPage
      messages={[]}
      onMessagesChange={() => {}}
      onSaveConversation={() => {}}
      onNewChat={() => {}}
      currentConversationId={undefined}

      setCurrentConversationId={() => {}}

      onOpenSettings={onOpenSettings}
    />
  );
}

describe('ChatPage — model-blocked overlay (F-AC7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    inferenceState = {
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: false,
      isServerConnected: true,
      modelLoadingProgress: 0,
      serverUrl: '',
      modeError: null,
    };
    currentReadinessResult = null;
  });
  afterEach(() => cleanup());

  it('renders the alertdialog with the wllama-specific failure headline and the real failure/recommendation text', () => {
    currentReadinessResult = makeReadinessResult({
      failures: ['This build does not include the packaged model weights (gemma-4-e2b-it).'],
      recommendations: ['Rebuild the app with the model bundled, or contact your administrator.'],
    });

    renderChatPage();

    const dialog = screen.getByRole('alertdialog', { name: /model not ready/i });
    expect(dialog).toBeInTheDocument();

    // Engine-aware, non-generic headline for wllama.
    expect(
      screen.getByText('This build is missing the packaged model. See the Packaging guide or contact your administrator.')
    ).toBeInTheDocument();
    // Must NOT fall back to the generic "preparing" message when there's a real failure.
    expect(screen.queryByText('Preparing the model…')).not.toBeInTheDocument();

    // The actual failure/recommendation text is surfaced, not a generic message.
    expect(
      screen.getByText('This build does not include the packaged model weights (gemma-4-e2b-it).')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Rebuild the app with the model bundled, or contact your administrator.')
    ).toBeInTheDocument();
  });

  it('renders the webllm-specific failure headline when the engine is webllm', () => {
    inferenceState = { ...inferenceState, browserEngine: 'webllm' };
    currentReadinessResult = makeReadinessResult({
      failures: ['WebGPU is not available in this browser.'],
      recommendations: ['Use a WebGPU-capable browser, or switch to the wllama engine.'],
    });

    renderChatPage();

    expect(
      screen.getByText('The browser model is not available. Use Settings to download it, or switch engines.')
    ).toBeInTheDocument();
    expect(screen.getByText('WebGPU is not available in this browser.')).toBeInTheDocument();
  });

  it('shows the generic "Preparing the model…" headline and no failure/recommendation lists when there are no failures yet', () => {
    // No readiness result yet (still loading) — getReadinessResultSnapshot() returns null.
    currentReadinessResult = null;
    inferenceState = { ...inferenceState, modelLoadingProgress: 42 };

    renderChatPage();

    expect(screen.getByText('Preparing the model…')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    // No <ul> failure/recommendation lists should render when there are no failures.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('Retry button resets the readiness cache and re-triggers the gate check for the current engine', () => {
    currentReadinessResult = makeReadinessResult({
      failures: ['This build does not include the packaged model weights.'],
      recommendations: ['Rebuild the app with the model bundled.'],
    });

    renderChatPage();

    // ChatPage's own mount-time readiness effect also calls
    // ensureReadinessGateChecked once; clear that call so the assertions
    // below isolate the Retry button's own invocation.
    mockResetReadinessCache.mockClear();
    mockEnsureReadinessGateChecked.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(mockResetReadinessCache).toHaveBeenCalledTimes(1);
    expect(mockEnsureReadinessGateChecked).toHaveBeenCalledTimes(1);
    expect(mockEnsureReadinessGateChecked).toHaveBeenCalledWith('wllama');
  });

  it('Open Settings button invokes the onOpenSettings prop', () => {
    currentReadinessResult = makeReadinessResult({
      failures: ['This build does not include the packaged model weights.'],
      recommendations: ['Rebuild the app with the model bundled.'],
    });
    const onOpenSettings = vi.fn();

    renderChatPage(onOpenSettings);

    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
