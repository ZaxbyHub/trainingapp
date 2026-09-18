/**
 * D7 acceptance check C1 — banner half (issue #83, AC1): while a pinned slide
 * is active, the chat UI shows the pinned-slide banner with the correct
 * "Section > Slide title" (title-only when no section resolves), and the
 * banner's "Explain this step" control submits a canned question with the pin
 * attached.
 *
 * FROZEN SPEC — authored by the independent check author at base f5bc456,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Contract frozen by this spec:
 *
 * web_ui/src/components/PinnedSlideContext.tsx (new component):
 *   interface PinnedSlide {
 *     slideId: string;
 *     slideTitle: string;
 *     // Resolved from the ingested slide-doc chunk; absent when unresolved.
 *     section?: string;
 *     // AC5 staleness flag — see ChatPage.pinned-stale.test.tsx.
 *     stale?: boolean;
 *   }
 *   interface PinnedSlideContextProps {
 *     pinnedSlide: PinnedSlide;
 *     onDismiss: () => void;
 *     onExplainThisStep?: () => void;
 *   }
 *   - root element carries data-testid="pinned-slide-context"
 *   - renders the text "Currently viewing:" followed by "Section > Slide title"
 *     when section is present, or just the title when it is not
 *   - dismiss control: [data-testid="pinned-slide-dismiss"]
 *   - explain control:   [data-testid="pinned-slide-explain"], labeled
 *     "Explain this step"
 *
 * web_ui/src/pages/ChatPage.tsx (new props — the TrainingPage→App→ChatPage
 * pin channel is named here):
 *   pinnedSlide?: PinnedSlide | null;
 *   onDismissPinnedSlide?: () => void;
 *   - renders <PinnedSlideContext .../> (NOT mocked here) when pinnedSlide is
 *     non-null, and nothing when it is null/undefined
 *
 * This file renders the REAL ChatPage + the REAL PinnedSlideContext; only the
 * service boundaries are mocked (RAGOrchestrator, TokenStreamManager,
 * useInferenceMode, getLLMService), following src/pages/ChatPage.rag.test.tsx.
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

// The browser-local send path awaits llmService.initialize() before querying.
// Mock the factory so initialize resolves immediately (no real model load).
vi.mock('../lib/llm/llm-factory', () => ({
  DEFAULT_BROWSER_ENGINE: 'wllama',
  getLLMService: vi.fn(),
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn(() => 'wllama'),
}));

import { ChatPage } from './ChatPage';
import { getLLMService } from '../lib/llm/llm-factory';

/** Deterministic fake LLM service: initialize is a no-op promise. */
const fakeLlmService = {
  initialize: vi.fn(async () => undefined),
  generate: vi.fn(),
  generateComplete: vi.fn(),
  isReady: vi.fn(() => true),
};

/** Controlled RAG event generator (complete-only keeps the send cycle short). */
async function* mockRAGEvents(events: RAGEvent[]): AsyncGenerator<RAGEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('D7 C1 (banner): ChatPage pinned-slide banner (issue #83 AC1)', () => {
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

    // Real timers: the send path is pure microtasks once initialize resolves.
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

  /** Harness: lifted pinnedSlide state, dismissable like App will do. */
  function Harness(props: { pinnedSlide: unknown }) {
    const [messages, setMessages] = React.useState<ChatMessage[]>([]);
    const [pinned, setPinned] = React.useState<unknown>(props.pinnedSlide);
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
        onDismissPinnedSlide={() => setPinned(null)}
      />
    );
  }

  /** Flush the send pipeline (initialize + generator consumption) as microtasks. */
  const flushSend = async () => {
    await act(async () => {
      for (let i = 0; i < 30; i++) {
        await Promise.resolve();
      }
    });
  };

  it('renders NO pinned banner when no pin is active (base behavior preserved)', () => {
    render(<Harness pinnedSlide={null} />);
    expect(screen.queryByTestId('pinned-slide-context')).toBeNull();
  });

  it('[AC1-RED] banner shows "Currently viewing: Section > Slide title" for a resolved section', () => {
    render(
      <Harness
        pinnedSlide={{
          slideId: '5rN4PvXJM5d',
          slideTitle: 'Welcome',
          section: 'Intro Module',
        }}
      />
    );
    const banner = screen.queryByTestId('pinned-slide-context');
    expect(
      banner,
      '[AC1-RED] expected the pinned-slide banner [data-testid="pinned-slide-context"] to render while a pin is active'
    ).not.toBeNull();
    expect(
      banner!.textContent,
      '[AC1-RED] expected banner text "Currently viewing: Intro Module > Welcome"'
    ).toContain('Currently viewing:');
    expect(banner!.textContent).toContain('Intro Module > Welcome');
  });

  it('[AC1-RED] banner degrades to title-only when no section resolves', () => {
    render(
      <Harness pinnedSlide={{ slideId: '6RdggQhakWc', slideTitle: 'Roles Menu' }} />
    );
    const banner = screen.queryByTestId('pinned-slide-context');
    expect(
      banner,
      '[AC1-RED] expected the pinned-slide banner to render for a section-less pin (title-only degradation)'
    ).not.toBeNull();
    expect(
      banner!.textContent,
      '[AC1-RED] expected banner to show the slide title "Roles Menu"'
    ).toContain('Roles Menu');
    expect(
      banner!.textContent,
      '[AC1-RED] title-only degradation must not render an empty/undefined section segment'
    ).not.toContain('undefined');
    expect(banner!.textContent).not.toContain(' > ');
  });

  it('[AC1-RED] "Explain this step" submits a canned question carrying the pinned context', async () => {
    render(
      <Harness
        pinnedSlide={{
          slideId: '5rN4PvXJM5d',
          slideTitle: 'Welcome',
          section: 'Intro Module',
        }}
      />
    );
    mockOrchestratorInstance.query.mockReturnValue(
      mockRAGEvents([
        { type: 'complete', data: { answer: 'This step welcomes you.', sources: [], chunks: [], grounding: 'grounded' } },
      ])
    );

    const banner = screen.queryByTestId('pinned-slide-context');
    expect(
      banner,
      '[AC1-RED] expected the pinned-slide banner to render so the Explain control exists'
    ).not.toBeNull();
    const explain = banner!.querySelector('[data-testid="pinned-slide-explain"]');
    expect(
      explain,
      '[AC1-RED] expected an "Explain this step" control [data-testid="pinned-slide-explain"] on the banner'
    ).not.toBeNull();
    expect(explain!.textContent).toMatch(/explain this step/i);

    await act(async () => {
      fireEvent.click(explain as HTMLElement);
    });
    await flushSend();

    expect(
      mockOrchestratorInstance.query,
      '[AC1-RED] expected the Explain control to submit a canned question'
    ).toHaveBeenCalledTimes(1);
    const [submittedQuestion, options] = mockOrchestratorInstance.query.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(
      submittedQuestion,
      '[AC1-RED] expected the canned question to reference "this step"'
    ).toMatch(/this step/i);
    expect(
      typeof options.pinnedContext === 'string' && options.pinnedContext.includes('Welcome'),
      '[AC1-RED] expected the canned question to carry the pinned slide context (options.pinnedContext containing the slide title)'
    ).toBe(true);
  });
});
