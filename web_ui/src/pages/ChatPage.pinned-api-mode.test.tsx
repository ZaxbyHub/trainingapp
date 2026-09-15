/**
 * D7 acceptance check C10 (issue #83, api-mode boundary): with the app in
 * server-API inference mode and a LIVE pin active —
 *
 *   (1) the pinned-slide banner still renders (the pin is visible context in
 *       BOTH inference modes), and
 *   (2) NOTHING pinned reaches the server: the SSE request payload carries no
 *       key mentioning "pinned" (case-insensitive) and its JSON does not
 *       contain the pinned slide's title, and
 *   (3) no RAGOrchestrator is ever constructed in api mode (the pin's
 *       orchestrator channel is browser-local-only by construction).
 *
 * FROZEN SPEC — authored by the independent check author at base f5bc456,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Contract frozen by this spec (web_ui/src/pages/ChatPage.tsx, api branch):
 *
 *   - <PinnedSlideContext .../> renders iff pinnedSlide is non-null, in BOTH
 *     inference modes ('api' included).
 *   - The server branch (mode === 'api') builds its payload as
 *     { question, history } — the pinned slide must NOT be added to it, under
 *     any key, at any nesting level (the frozen API contract has no
 *     pinned-slide field; server-side pinning is an explicitly named
 *     follow-up, out of scope per the issue).
 *   - new RAGOrchestrator(...) must never run in api mode.
 *
 * The "Explain this step" control on the banner is the send trigger used
 * here: it goes through the same send path as a typed question, so if the
 * implementation (incorrectly) attached the pin in api mode, the leaked pin
 * would be observable in exactly this payload.
 *
 * Mock layout mirrors the round-1 ChatPage checks (mock-instance pattern from
 * src/pages/ChatPage.rag.test.tsx) with two api-mode deltas:
 *   - useInferenceMode returns mode 'api', serverUrl ''
 *   - ../lib/api/auth is mocked so getToken() returns null (no stored token)
 * The TokenStreamManager mock instance gains a startSSEStream spy — the api
 * send path's observable boundary. No network, no models.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Import mocked modules to get typed mocks
import * as ragModule from '../lib/rag/rag-orchestrator';
import * as inferenceModule from '../lib/inference';
import * as streamingModule from '../lib/streaming';

// Shared mock instance to track calls (assigned fresh in beforeEach)
let mockStreamManagerInstance: {
  onToken: ReturnType<typeof vi.fn>;
  onDone: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  pushToken: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  startSSEStream: ReturnType<typeof vi.fn>;
};

// Mock modules BEFORE importing the component under test
vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(function () {
    return {
      query: vi.fn(),
    };
  }),
}));

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(function () {
    return mockStreamManagerInstance;
  }),
}));

// api mode deltas: no LLM factory calls are expected, but the module is
// mocked so nothing real can load; and the auth boundary returns no token.
vi.mock('../lib/llm/llm-factory', () => ({
  DEFAULT_BROWSER_ENGINE: 'wllama',
  getLLMService: vi.fn(),
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn(() => 'wllama'),
}));

vi.mock('../lib/api/auth', () => ({
  getToken: vi.fn(() => null),
  storeToken: vi.fn(),
  clearToken: vi.fn(),
}));

import { ChatPage } from './ChatPage';

describe('D7 C10: api-mode invariant — banner renders, nothing pinned reaches the server (issue #83)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockStreamManagerInstance = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      pushToken: vi.fn(),
      complete: vi.fn(),
      error: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
      startSSEStream: vi.fn(),
    };

    vi.mocked(streamingModule.TokenStreamManager).mockImplementation(function () {
      return mockStreamManagerInstance as unknown as streamingModule.TokenStreamManager;
    });

    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => ({ query: vi.fn() }) as unknown as ragModule.RAGOrchestrator
    );

    // API-mode inference context (real timers; the api send path calls
    // startSSEStream synchronously after the awaited send-time save).
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'api',
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
      checkServerConnectivity: vi.fn(() => Promise.resolve(true)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** Render ChatPage with a LIVE pin, exactly as App will. */
  const renderWithLivePin = () =>
    render(
      <ChatPage
        messages={[]}
        onMessagesChange={() => {}}
        onSaveConversation={vi.fn(async () => undefined)}
        onNewChat={() => {}}
        currentConversationId={undefined}
        setCurrentConversationId={() => {}}
        onOpenSettings={() => {}}
        pinnedSlide={
          {
            slideId: '5rN4PvXJM5d',
            slideTitle: 'Welcome',
            section: 'Intro Module',
          } as never
        }
        onDismissPinnedSlide={() => {}}
      />
    );

  it('[AC10-RED] the pinned-slide banner renders in api mode with a live pin', () => {
    renderWithLivePin();
    expect(
      screen.queryByTestId('pinned-slide-context'),
      '[AC10-RED] expected the pinned-slide banner to render in api mode while a pin is active — the banner must not be browser-local-only'
    ).not.toBeNull();
  });

  it('[AC10-RED] "Explain this step" in api mode: SSE payload carries nothing pinned and no orchestrator is constructed', async () => {
    renderWithLivePin();

    const banner = screen.queryByTestId('pinned-slide-context');
    expect(
      banner,
      '[AC10-RED] expected the pinned-slide banner to render so the Explain control exists'
    ).not.toBeNull();
    const explain = banner!.querySelector('[data-testid="pinned-slide-explain"]');
    expect(
      explain,
      '[AC10-RED] expected an "Explain this step" control [data-testid="pinned-slide-explain"] on the banner'
    ).not.toBeNull();

    await act(async () => {
      fireEvent.click(explain as HTMLElement);
    });
    // Flush the awaited send-time persistence + runGeneration microtasks.
    await act(async () => {
      for (let i = 0; i < 30; i++) {
        await Promise.resolve();
      }
    });

    // The api send path reached the SSE boundary.
    expect(
      mockStreamManagerInstance.startSSEStream,
      '[AC10-RED] expected the api-mode send to reach TokenStreamManager.startSSEStream'
    ).toHaveBeenCalledTimes(1);

    // (2) NOTHING pinned in the server payload: no key mentioning "pinned"
    // (case-insensitive) anywhere in the payload object, and the pinned
    // slide's title must not appear anywhere in its JSON.
    const payload = mockStreamManagerInstance.startSSEStream.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(
      Object.keys(payload).some((key) => key.toLowerCase().includes('pinned')),
      '[AC10-RED] the api-mode server payload must not carry any pinned-slide field — the frozen API contract has no pinned context parameter'
    ).toBe(false);
    expect(
      JSON.stringify(payload).includes('Welcome'),
      '[AC10-RED] the pinned slide title must not leak into the api-mode server payload in any form'
    ).toBe(false);

    // (3) No RAG orchestrator is ever constructed in api mode.
    expect(
      ragModule.RAGOrchestrator,
      '[AC10-RED] no RAGOrchestrator may be constructed in api mode — the pin channel is browser-local-only'
    ).not.toHaveBeenCalled();
  });
});
