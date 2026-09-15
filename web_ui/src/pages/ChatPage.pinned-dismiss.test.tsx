/**
 * D7 acceptance check C4 (issue #83, AC4): dismissal clears the pinned-slide
 * context — after dismissing the pin, the next question carries NO slide
 * context (options.pinnedContext is undefined), and the banner is gone.
 *
 * FROZEN SPEC — authored by the independent check author at base f5bc456,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Contract frozen by this spec (see also ChatPage.pinned-banner.test.tsx):
 *
 *   ChatPage props:
 *     pinnedSlide?: PinnedSlide | null;   // { slideId, slideTitle, section?, stale? }
 *     onDismissPinnedSlide?: () => void;  // fired by the banner's dismiss control
 *
 *   - while a non-stale pin is active, orchestrator.query(text, options) must
 *     receive options.pinnedContext: a string containing at least the slide
 *     title (the prefilled slide context)
 *   - after dismissal (banner dismiss control → onDismissPinnedSlide → the
 *     owning state is nulled, exactly as App will do), the next question's
 *     options.pinnedContext must be undefined
 *
 * RAGOrchestrator is mocked (mock-instance pattern from
 * src/pages/ChatPage.rag.test.tsx) so the captured query options are the
 * assertion surface. No network, no models.
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

describe('D7 C4: dismissing the pinned slide clears the context (issue #83 AC4)', () => {
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

  /** Harness: lifted pinned-slide state; dismiss nulls it, exactly as App will. */
  function Harness(props: { pinnedSlide: unknown }) {
    const [messages, setMessages] = React.useState<ChatMessage[]>([]);
    const [pinned, setPinned] = React.useState<unknown>(props.pinnedSlide);
    const onDismissPinnedSlide = vi.fn(() => setPinned(null));
    return (
      <ChatPage
        messages={messages}
        onMessagesChange={setMessages}
        onSaveConversation={() => {}}
        onNewChat={() => {}}
        currentConversationId={undefined}
        setCurrentConversationId={() => {}}
        onOpenSettings={() => {}}
        pinnedSlide={pinned as never}
        onDismissPinnedSlide={onDismissPinnedSlide}
      />
    );
  }

  const flushSend = async () => {
    await act(async () => {
      for (let i = 0; i < 30; i++) {
        await Promise.resolve();
      }
    });
  };

  const submitMessage = (text: string) => {
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: text } });
    const sendButton = screen.getByRole('button', { name: /send message/i });
    fireEvent.click(sendButton);
  };

  it('[AC4-RED] while the pin is active, a typed question carries the pinned context', async () => {
    mockOrchestratorInstance.query.mockReturnValue(
      mockRAGEvents([
        { type: 'complete', data: { answer: 'ok', sources: [], chunks: [] } },
      ])
    );
    render(
      <Harness
        pinnedSlide={{
          slideId: '5rN4PvXJM5d',
          slideTitle: 'Welcome',
          section: 'Intro Module',
        }}
      />
    );

    await act(async () => {
      submitMessage('What does this screen do?');
    });
    await flushSend();

    expect(
      mockOrchestratorInstance.query,
      '[AC4-RED] expected the submitted question to reach orchestrator.query'
    ).toHaveBeenCalledTimes(1);
    const options = mockOrchestratorInstance.query.mock.calls[0][1] as Record<string, unknown>;
    expect(
      typeof options.pinnedContext === 'string' && options.pinnedContext.includes('Welcome'),
      '[AC4-RED] expected options.pinnedContext to be attached (string containing the slide title) while the pin is active'
    ).toBe(true);
  });

  it('[AC4-RED] dismissing the pin removes the banner and the next question carries NO slide context', async () => {
    mockOrchestratorInstance.query.mockReturnValue(
      mockRAGEvents([
        { type: 'complete', data: { answer: 'ok', sources: [], chunks: [] } },
      ])
    );
    render(
      <Harness
        pinnedSlide={{
          slideId: '5rN4PvXJM5d',
          slideTitle: 'Welcome',
          section: 'Intro Module',
        }}
      />
    );

    // Banner is up with a dismiss control.
    const banner = screen.queryByTestId('pinned-slide-context');
    expect(
      banner,
      '[AC4-RED] expected the pinned-slide banner to render while the pin is active'
    ).not.toBeNull();
    const dismiss = banner!.querySelector('[data-testid="pinned-slide-dismiss"]');
    expect(
      dismiss,
      '[AC4-RED] expected a dismiss control [data-testid="pinned-slide-dismiss"] on the banner'
    ).not.toBeNull();

    await act(async () => {
      fireEvent.click(dismiss as HTMLElement);
    });

    // Dismissal fired the lifted callback and, once the owner nulls the pin,
    // the banner is gone.
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByTestId('pinned-slide-context'),
      '[AC4-RED] expected the pinned-slide banner to be gone after dismissal'
    ).toBeNull();

    // The next question must carry NO slide context.
    await act(async () => {
      submitMessage('Unrelated follow-up question');
    });
    await flushSend();

    expect(
      mockOrchestratorInstance.query,
      '[AC4-RED] expected the post-dismissal question to reach orchestrator.query'
    ).toHaveBeenCalledTimes(1);
    const options = mockOrchestratorInstance.query.mock.calls[0][1] as Record<string, unknown>;
    expect(
      options.pinnedContext,
      '[AC4-RED] expected options.pinnedContext to be undefined after dismissal — no slide context may ride along'
    ).toBeUndefined();
  });
});
