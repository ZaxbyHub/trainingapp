/**
 * D7 acceptance check C8 (issue #83, AC1/AC5 integration): App-level
 * integration — the pin flows through the REAL App end to end:
 *
 *   (1) TrainingPlayer's slidechange (driven through the mocked player
 *       bridge inside the REAL TrainingPlayer inside the REAL TrainingPage
 *       inside the REAL App) makes App call the slide-doc resolver with the
 *       slideId, patch the pin with the resolved section/text, and render the
 *       pinned-slide banner on the chat page with "Section > Slide title";
 *   (2) a question sent on the chat page carries options.pinnedContext
 *       containing the resolver-returned text (the resolved slide text is
 *       observable at the orchestrator boundary);
 *   (3) the App staleness producer: moving to the training page for a
 *       DIFFERENT pack marks the pin stale — the chat banner carries
 *       data-stale="true" and the next question's options.pinnedContext is
 *       undefined (a stale pin is never attached).
 *
 * FROZEN SPEC — authored by the independent check author at base f5bc456,
 * before any implementation exists. The implementer must make this pass
 * without editing it.
 *
 * Contract frozen by this spec (web_ui/src/App.tsx, AppContent):
 *
 *   - App owns the pinned-slide state: a TrainingPlayer slidechange (forwarded
 *     by TrainingPage's onSlideChange — see C1's frozen wire) sets/captures
 *     the pin and App calls
 *     resolveSlideDoc(slideId)                              // web_ui/src/lib/training/slide-doc-resolver.ts
 *     → { section?: string; text?: string } | null
 *     and patches the pin's section/text from the resolver's return value.
 *   - The pin's captured packId is the effective training pack
 *     (trainingTarget?.packId ?? the ?pack= query parameter).
 *   - App passes pinnedSlide/onDismissPinnedSlide to ChatPage, so the
 *     banner renders at the REAL render site inside the REAL App tree.
 *   - Staleness producer: while currentPage === 'training', a live pin whose
 *     packId differs from the effective pack is marked stale (stale: true) —
 *     the chat banner then carries data-stale="true" and the pin is never
 *     attached to a query (options.pinnedContext === undefined).
 *
 * Harness decisions (documented because C8 is the App-level check):
 *
 *   - App-level service mocking copies the proven recipe of src/App.test.tsx
 *     (mock db/conversations, useServiceInitialization,
 *     lib/inference/InferenceModeContext, lib/llm/llm-factory,
 *     lib/rag/rag-orchestrator, lib/streaming, StreamingIndicator,
 *     InferenceModeToggle, DocumentsPage, SettingsPage).
 *   - The player bridge module is mocked with the controllable stateQueue
 *     pattern from src/components/__tests__/TrainingPlayer.test.tsx, so the
 *     REAL TrainingPlayer emits slidechange events without a network/player.
 *   - Navigation to the training page uses the REAL App's Sidebar "Training"
 *     nav button (aria-label="Training"). The pack is selected via
 *     TrainingPage's EXISTING ?pack= query-parameter fallback
 *     (window.history.pushState('/?pack=<packId>')): the deep-link target
 *     (trainingTarget) is null on plain navigation, so the query param is the
 *     effective pack — and changing it between hops deterministically
 *     switches packs, because TrainingPage remounts on every training-page
 *     entry and re-reads window.location.search. No Learn-panel chat detour
 *     is needed, keeping this check independent of the learn pipeline.
 *   - REAL timers: the send path is pure microtasks once the mocked llm
 *     initialize resolves, and TrainingPlayer's 1000 ms poll cadence is
 *     absorbed by waitFor (the App.test.tsx convention).
 *   - The slide-doc resolver module does not exist at base. It is mocked via
 *     vi.mock with a FACTORY ONLY (no direct import of the missing module —
 *     a direct import cannot resolve at base and would fail the file for the
 *     wrong reason). The factory records the vi.fn on a hoisted control
 *     object so the assertion surface exists at base.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Import mocked modules to get typed mocks (module exists at base).
import * as ragModule from '../lib/rag/rag-orchestrator';
import * as streamingModule from '../lib/streaming';
import type { RAGEvent } from '../lib/rag/rag-orchestrator';

// ---------------------------------------------------------------------------
// Controllable fake player bridge (hoisted so vi.mock's factory can close
// over it) — identical pattern to TrainingPlayer.test.tsx / C1's wire test.
// ---------------------------------------------------------------------------
const bridge = vi.hoisted(() => {
  const ctrl = {
    frames: [] as Array<HTMLElement | undefined>,
    jumpCalls: [] as string[],
    jumpResults: new Map<string, boolean>(),
    stateQueue: [] as Array<{ slideId: string; slideTitle: string } | null>,
    readIndex: 0,
    reset() {
      ctrl.frames = [];
      ctrl.jumpCalls = [];
      ctrl.jumpResults = new Map();
      ctrl.stateQueue = [];
      ctrl.readIndex = 0;
    },
  };
  return ctrl;
});

vi.mock('../components/training-player-bridge', () => ({
  createTrainingPlayerBridge: (frame: HTMLElement) => {
    bridge.frames.push(frame);
    return {
      jumpToSlide: (slideId: string) => {
        bridge.jumpCalls.push(slideId);
        const ok = bridge.jumpResults.get(slideId) ?? false;
        return Promise.resolve(ok);
      },
      readState: () => {
        const value =
          bridge.readIndex < bridge.stateQueue.length
            ? bridge.stateQueue[bridge.readIndex++]
            : bridge.stateQueue[bridge.stateQueue.length - 1] ?? null;
        return Promise.resolve(value ?? null);
      },
    };
  },
}));

// ---------------------------------------------------------------------------
// Slide-doc resolver mock — FACTORY ONLY (the module does not exist at base;
// importing it here would fail the whole file for the wrong reason). The
// vi.fn lives in the hoisted control object so the assertion surface exists
// even at base, where nothing imports the module and the factory below never
// runs (vitest instantiates mock factories lazily, on first import).
// ---------------------------------------------------------------------------
const resolverCtrl = vi.hoisted(() => ({
  resolveSlideDoc: vi.fn(),
}));

vi.mock('../lib/training/slide-doc-resolver', () => ({
  resolveSlideDoc: resolverCtrl.resolveSlideDoc,
}));

// ---------------------------------------------------------------------------
// App-level service mocks — the App.test.tsx recipe.
// ---------------------------------------------------------------------------
vi.mock('../db/conversations', () => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(async () => undefined),
  createConversation: vi.fn(async () => undefined),
  updateConversation: vi.fn(async () => undefined),
  deleteConversation: vi.fn(async () => undefined),
  countConversations: vi.fn(async () => 0),
}));

vi.mock('../hooks/useServiceInitialization', () => ({
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

const fakeLlmService = {
  initialize: vi.fn(async () => undefined),
  generate: async function* () {
    yield 'ok';
  },
  generateComplete: async () => 'ok',
  isReady: () => true,
  getModelInfo: () => null,
  getInferenceMode: () => 'wasm' as const,
  supportsImages: () => false,
  interrupt: () => undefined,
};

vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: () => fakeLlmService,
  disposeBrowserEngine: () => undefined,
  getPreferredBrowserEngine: () => 'wllama',
}));

// Orchestrator: mock-instance pattern (ChatPage.rag.test.tsx / round-1
// ChatPage checks) so the captured query options are the assertion surface.
const mockStreamManagerInstance = vi.hoisted(() => ({
  onToken: vi.fn(),
  onDone: vi.fn(),
  onError: vi.fn(),
  pushToken: vi.fn(),
  complete: vi.fn(),
  error: vi.fn(),
  cancel: vi.fn(),
  dispose: vi.fn(),
  startSSEStream: vi.fn(),
}));

vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn(),
}));

vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(function () {
    return mockStreamManagerInstance;
  }),
}));

vi.mock('../components/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
}));
vi.mock('../components/InferenceModeToggle', () => ({
  InferenceModeToggle: () => null,
}));
vi.mock('./DocumentsPage', () => ({
  DocumentsPage: () => <div data-testid="documents-page-marker">Documents Page</div>,
}));
vi.mock('./SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page-marker">Settings Page</div>,
}));

// Import the component under test AFTER the mocks are in place.
// (App.tsx lives at src/App.tsx — src/App.test.tsx renders this default export.)
import App from '../App';

// ---------------------------------------------------------------------------
// Test-scenario constants.
// ---------------------------------------------------------------------------
const PACK_A = 'ac8-pack-alpha';
const PACK_B = 'ac8-pack-beta';
const WELCOME = { slideId: '5rN4PvXJM5d', slideTitle: 'Welcome' };
const CHAT_PLACEHOLDER =
  'Ask a question… (Enter to send, Shift+Enter for a new line)';

/** Deterministic complete-only RAG event generator (one per query call). */
async function* mockRAGEvents(events: RAGEvent[]): AsyncGenerator<RAGEvent> {
  for (const event of events) {
    yield event;
  }
}

const completeEvents = () =>
  mockRAGEvents([{ type: 'complete', data: { answer: 'ok', sources: [], chunks: [] } }]);

const originalPathname = window.location.pathname;
const originalSearch = window.location.search;

/** Select the effective training pack via TrainingPage's ?pack= fallback. */
const setPackQueryParam = (packId: string) => {
  window.history.pushState({}, '', `/?pack=${encodeURIComponent(packId)}`);
};

/** Replace the bridge's readable player state (queue + read cursor). */
const setBridgeStates = (states: Array<{ slideId: string; slideTitle: string } | null>) => {
  bridge.stateQueue = states;
  bridge.readIndex = 0;
};

const clickNav = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};

const submitMessage = (text: string) => {
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /send message/i }));
};

/** Flush the send pipeline (initialize + generator consumption) as microtasks. */
const flushSend = async () => {
  await act(async () => {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
  });
};

describe('D7 C8: App-level pinned-slide integration (issue #83)', () => {
  let mockOrchestratorInstance: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    bridge.reset();

    // CHECK_WRONG amendment (2026-09-15, issue #83 trace): afterEach's
    // vi.restoreAllMocks() wipes this file's module-scope TokenStreamManager
    // mockImplementation, so from the SECOND test on, `new TokenStreamManager()`
    // returned an empty object and the send pipeline died before ever reaching
    // the orchestrator (onToken is not a function). The round-1 ChatPage
    // harnesses re-register this exact implementation in beforeEach — this
    // file must too. No discriminating assertion changes.
    vi.mocked(streamingModule.TokenStreamManager).mockImplementation(function () {
      return mockStreamManagerInstance as unknown as streamingModule.TokenStreamManager;
    });

    // Resolver returns a deterministic section + resolved slide text.
    resolverCtrl.resolveSlideDoc.mockReturnValue({
      section: 'Intro Module',
      text: 'AC8-RESOLVED-TEXT',
    });

    // Orchestrator mock instance (captures query options).
    mockOrchestratorInstance = { query: vi.fn() };
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () => mockOrchestratorInstance as unknown as ragModule.RAGOrchestrator
    );
    mockOrchestratorInstance.query.mockImplementation(() => completeEvents());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.pushState({}, '', originalPathname + originalSearch);
  });

  /**
   * Shared scenario prefix: land the app on the training page for PACK_A,
   * let the (real) TrainingPlayer report the Welcome slide through the fake
   * bridge, and wait for App to run the slide-doc resolver.
   */
  const pinWelcomeSlideOnPackA = async () => {
    setPackQueryParam(PACK_A);
    setBridgeStates([WELCOME]);
    render(<App />);
    // Chat is the default page; wait past the (mocked) init gate.
    await screen.findByPlaceholderText(CHAT_PLACEHOLDER);

    clickNav('Training');
    await waitFor(
      () => {
        expect(
          resolverCtrl.resolveSlideDoc,
          '[AC8-RED] expected App to call resolveSlideDoc on the player slidechange — App does not wire TrainingPage.onSlideChange into pin state yet'
        ).toHaveBeenCalled();
      },
      { timeout: 3000 }
    );
    expect(
      resolverCtrl.resolveSlideDoc,
      '[AC8-RED] expected resolveSlideDoc to be called with the changed slideId'
    ).toHaveBeenCalledWith(WELCOME.slideId);
  };

  it('[AC8-RED] slidechange → resolver → pin: chat banner shows the resolver-patched "Intro Module > Welcome"', async () => {
    await pinWelcomeSlideOnPackA();

    clickNav('Chat');
    await waitFor(
      () => {
        const banner = screen.queryByTestId('pinned-slide-context');
        expect(
          banner !== null && banner.textContent!.includes('Intro Module > Welcome'),
          '[AC8-RED] expected the pinned-slide banner to render on the chat page with the resolver-patched section ("Intro Module > Welcome") — the resolver→pin→App→ChatPage wiring is missing'
        ).toBe(true);
      },
      { timeout: 3000 }
    );
  });

  it('[AC8-RED] a question sent on chat carries the RESOLVER-returned slide text in options.pinnedContext', async () => {
    await pinWelcomeSlideOnPackA();

    clickNav('Chat');
    await screen.findByPlaceholderText(CHAT_PLACEHOLDER);

    await act(async () => {
      submitMessage('What does this welcome screen do?');
    });
    await flushSend();

    expect(
      mockOrchestratorInstance.query,
      '[AC8-RED] expected the submitted question to reach orchestrator.query'
    ).toHaveBeenCalled();
    const options = mockOrchestratorInstance.query.mock.calls[
      mockOrchestratorInstance.query.mock.calls.length - 1
    ][1] as Record<string, unknown>;
    expect(
      typeof options.pinnedContext === 'string' &&
        options.pinnedContext.includes('AC8-RESOLVED-TEXT'),
      '[AC8-RED] expected options.pinnedContext to carry the resolver-returned slide text ("AC8-RESOLVED-TEXT") — the resolved PinnedSlide.text is not reaching the query options'
    ).toBe(true);
  });

  it('[AC8-RED] moving to training for a DIFFERENT pack marks the pin stale: banner data-stale="true" and the next question carries NO pinnedContext', async () => {
    await pinWelcomeSlideOnPackA();

    // Back to chat: the pin is live (banner present).
    clickNav('Chat');
    await screen.findByPlaceholderText(CHAT_PLACEHOLDER);

    // Switch the effective training pack to PACK_B and re-enter training.
    // The fresh player reports NO state for the new pack (queue [null]), so
    // nothing supersedes the pin — only the staleness producer may act.
    setPackQueryParam(PACK_B);
    setBridgeStates([null]);
    clickNav('Training');
    // Let the staleness producer's effect run while on the training page.
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });

    clickNav('Chat');
    await screen.findByPlaceholderText(CHAT_PLACEHOLDER);

    const banner = screen.queryByTestId('pinned-slide-context');
    expect(
      banner,
      '[AC8-RED] expected the pinned-slide banner to still render on the chat page after the pack switch (now visibly stale)'
    ).not.toBeNull();
    expect(
      banner!.getAttribute('data-stale'),
      '[AC8-RED] expected the App staleness producer to mark the pin stale after entering training for a different pack — banner must carry data-stale="true"'
    ).toBe('true');

    await act(async () => {
      submitMessage('A totally unrelated question after the pack switch');
    });
    await flushSend();

    expect(
      mockOrchestratorInstance.query,
      '[AC8-RED] expected the submitted question to reach orchestrator.query'
    ).toHaveBeenCalled();
    const options = mockOrchestratorInstance.query.mock.calls[
      mockOrchestratorInstance.query.mock.calls.length - 1
    ][1] as Record<string, unknown>;
    expect(
      options.pinnedContext,
      '[AC8-RED] a stale pin must never be attached — expected options.pinnedContext to be undefined after the app moved to a different training pack'
    ).toBeUndefined();
  });
});
