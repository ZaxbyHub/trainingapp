/**
 * D7 acceptance check C5 (issue #83, AC5): staleness handled — when the player
 * session ends without explicit dismissal, the pin is never SILENTLY reused to
 * contextualize a later question. The AC allows two branches:
 *   (a) the pin clears automatically, or
 *   (b) the pin is visibly marked stale.
 *
 * FROZEN SPEC — authored by the independent check author at base f5bc456,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Contract frozen by this spec (the concrete, deterministically testable
 * staleness observable — the "never silently reused" invariant):
 *
 *   PinnedSlide carries `stale?: boolean` (see ChatPage.pinned-banner.test.tsx
 *   for the full shape). App owns setting it (player session end / slide doc
 *   no longer resolvable) — this check pins what the chat side must do with it:
 *
 *   1. ChatPage must treat pinnedSlide.stale === true as "do not attach":
 *      orchestrator.query(text, options).pinnedContext must be undefined.
 *      (This holds whichever branch App chose — a cleared pin never reaches
 *      ChatPage at all, and a marked-stale one must be inert.)
 *   2. If a banner is still rendered for a stale pin, it must be VISIBLY
 *      marked stale: the [data-testid="pinned-slide-context"] element carries
 *      data-stale="true". A stale pin must never present as a live one.
 *
 * RAGOrchestrator is mocked (mock-instance pattern from
 * src/pages/ChatPage.rag.test.tsx). No network, no models.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Import mocked modules to get typed mocks
import * as ragModule from '../lib/rag/rag-orchestrator';
import * as inferenceModule from '../lib/inference';
import * as streamingModule from '../lib/streaming';
import type { RAGEvent } from '../lib/rag/rag-orchestrator';
import type { ChatMessage } from '../types/chat';

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
};

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

// The browser-local send path awaits llmService.initialize() before querying.
vi.mock('../lib/llm/llm-factory', () => ({
  DEFAULT_BROWSER_ENGINE: 'wllama',
  getLLMService: vi.fn(),
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn(() => 'wllama'),
}));

import { ChatPage } from './ChatPage';
import { getLLMService } from '../lib/llm/llm-factory';

const fakeLlmService = {
  initialize: vi.fn(async () => undefined),
  generate: vi.fn(),
  generateComplete: vi.fn(),
  isReady: vi.fn(() => true),
};

async function* mockRAGEvents(events: RAGEvent[]): AsyncGenerator<RAGEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('D7 C5: a stale pin is never silently reused (issue #83 AC5)', () => {
  let mockOrchestratorInstance: {
    query: ReturnType<typeof vi.fn>;
  };

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
    };

    vi.mocked(streamingModule.TokenStreamManager).mockImplementation(function () {
      return mockStreamManagerInstance as unknown as streamingModule.TokenStreamManager;
    });

    mockOrchestratorInstance = {
      query: vi.fn(),
    };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => mockOrchestratorInstance as unknown as ragModule.RAGOrchestrator
    );

    vi.mocked(getLLMService).mockReturnValue(
      fakeLlmService as unknown as ReturnType<typeof getLLMService>
    );

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
    vi.restoreAllMocks();
  });

  const LIVE_PIN = {
    slideId: '5rN4PvXJM5d',
    slideTitle: 'Welcome',
    section: 'Intro Module',
  };

  const submitAndCaptureOptions = async (question: string): Promise<Record<string, unknown>> => {
    const callCountBefore = mockOrchestratorInstance.query.mock.calls.length;
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: question } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });
    await act(async () => {
      for (let i = 0; i < 30; i++) {
        await Promise.resolve();
      }
    });
    expect(
      mockOrchestratorInstance.query.mock.calls.length,
      '[AC5-RED] expected the submitted question to reach orchestrator.query'
    ).toBe(callCountBefore + 1);
    const call = mockOrchestratorInstance.query.mock.calls[
      mockOrchestratorInstance.query.mock.calls.length - 1
    ];
    return call[1] as Record<string, unknown>;
  };

  it('[AC5-RED] a question sent against a stale pin carries NO slide context (never silently reused)', async () => {
    // A fresh generator per call so multiple sends each get events.
    mockOrchestratorInstance.query.mockImplementation(() =>
      mockRAGEvents([{ type: 'complete', data: { answer: 'ok', sources: [], chunks: [], grounding: 'grounded' } }])
    );

    // CONTROL LEG (red at base, before the feature exists): with a LIVE pin,
    // the pinned context IS attached. Without this leg, the stale-leg
    // "undefined" assertion below would pass vacuously on a tree where the
    // pin channel does not exist at all.
    const { unmount } = render(
      <ChatPage
        messages={[]}
        onMessagesChange={() => {}}
        onSaveConversation={() => {}}
        onNewChat={() => {}}
        currentConversationId={undefined}
        setCurrentConversationId={() => {}}
        onOpenSettings={() => {}}
        pinnedSlide={LIVE_PIN as never}
        onDismissPinnedSlide={() => {}}
      />
    );
    const liveOptions = await submitAndCaptureOptions('A question while the pin is live');
    expect(
      typeof liveOptions.pinnedContext === 'string' && liveOptions.pinnedContext.includes('Welcome'),
      '[AC5-RED] control leg: a LIVE pin must attach options.pinnedContext — the stale-leg assertion below is only meaningful once the pin channel exists'
    ).toBe(true);
    unmount();

    // STALE LEG: the same pin, now marked stale (player session ended without
    // dismissal). The next question must carry NO slide context.
    render(
      <ChatPage
        messages={[]}
        onMessagesChange={() => {}}
        onSaveConversation={() => {}}
        onNewChat={() => {}}
        currentConversationId={undefined}
        setCurrentConversationId={() => {}}
        onOpenSettings={() => {}}
        pinnedSlide={{ ...LIVE_PIN, stale: true } as never}
        onDismissPinnedSlide={() => {}}
      />
    );
    const staleOptions = await submitAndCaptureOptions('A totally unrelated later question');
    expect(
      staleOptions.pinnedContext,
      '[AC5-RED] a stale pin must never be silently reused — expected options.pinnedContext to be undefined'
    ).toBeUndefined();
  });

  it('[AC5-RED] a banner rendered for a stale pin is visibly marked stale (never presented live)', () => {
    render(
      <ChatPage
        messages={[]}
        onMessagesChange={() => {}}
        onSaveConversation={() => {}}
        onNewChat={() => {}}
        currentConversationId={undefined}
        setCurrentConversationId={() => {}}
        onOpenSettings={() => {}}
        pinnedSlide={{ ...LIVE_PIN, stale: true } as never}
        onDismissPinnedSlide={() => {}}
      />
    );

    const banner = screen.queryByTestId('pinned-slide-context');
    // Branch (a) of AC5 — the pin may be cleared automatically (no banner at
    // all). Only when a banner IS rendered does the stale marking apply.
    if (banner !== null) {
      expect(
        banner.getAttribute('data-stale'),
        '[AC5-RED] a banner for a stale pin must carry data-stale="true" — a stale pin may never present as a live one'
      ).toBe('true');
      expect(
        banner.textContent,
        '[AC5-RED] expected the stale banner to still identify the slide it refers to'
      ).toContain('Welcome');
    }
  });
});
