/**
 * F1 integration test: a cold-state browser-local send must initialize the LLM
 * service BEFORE the orchestrator calls generate(). Issue #21 acceptance
 * criterion #1: "A fresh page load in browser-local/wllama mode can send a
 * message and receive a streamed answer without any manual Settings
 * interaction." (PR #28 PRR-001)
 *
 * Mocks llm-factory (controllable fake LLMService) and RAGOrchestrator (no real
 * pipeline), then asserts ORDERING: initialize() is awaited before query().
 *
 * F-TEST (PR #28 review): the original ordering assertion compared the index
 * of two SYNCHRONOUS pushes into `callOrder` — one made at initialize() call
 * time, one made at query() call time. Because nothing ever yielded control to
 * the event loop between those two pushes, a REGRESSED ChatPage.tsx that
 * fires `llmService.initialize(...)` WITHOUT awaiting it before calling
 * `orchestrator.query(...)` still passed this test (verified empirically).
 * The fix below makes the fake initialize() cross a real macrotask boundary
 * (`setTimeout(0)`) before marking itself complete, and has the mocked
 * query() record whether that completion had actually happened by the moment
 * it was invoked. A regressed (non-awaited) ChatPage.tsx calls query()
 * synchronously right after firing initialize(), before the macrotask ever
 * fires, so the recorded value is observably `false` and the test fails for
 * the right reason.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { ChatPage } from './ChatPage';

// Call-order log shared between the fake service and the orchestrator mock.
const callOrder: string[] = [];
// Flipped to true ONLY after the fake initialize()'s macrotask delay
// resolves — never at call time. query() reads this at the moment it's
// invoked so the test can detect whether ChatPage actually awaited
// initialize() before calling query().
let initCompleted = false;
let initCompletedAtQueryTime: boolean | null = null;

// Every TokenStreamManager instance ChatPage constructs, in creation order,
// so a test can inspect the specific instance a given send used (e.g. to
// assert `.error(...)` was invoked on it for the negative-path test).
interface FakeStreamManager {
  onToken: ReturnType<typeof vi.fn>;
  onDone: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  pushToken: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}
const streamManagerInstances: FakeStreamManager[] = [];

const fakeLlmService = {
  initialize: vi.fn(async () => {
    callOrder.push('initialize-start');
    // Force a real macrotask boundary. With a CORRECT ChatPage.tsx (awaits
    // initialize() before calling query()), initCompleted will be true by
    // the time query() runs below. With a REGRESSED ChatPage.tsx (fires
    // initialize() without awaiting), query() runs synchronously right
    // after this call — before this timeout ever fires.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    initCompleted = true;
    callOrder.push('initialize-complete');
  }),
  generate: async function* () { yield 'ok'; },
  generateComplete: async () => 'ok',
  isReady: () => false,
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

vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(() => ({
    query: async function* () {
      callOrder.push('query');
      initCompletedAtQueryTime = initCompleted;
      yield { type: 'complete', data: { answer: 'ok', sources: [], chunks: [] } };
    },
  })),
}));

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => ({
    mode: 'browser-local',
    browserEngine: 'wllama',
    ragPreset: 'balanced',
    isModelReady: true,
    isServerConnected: true,
    modelLoadingProgress: 0,
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

vi.mock('../components/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
}));
vi.mock('../components/InferenceModeToggle', () => ({
  InferenceModeToggle: () => null,
}));
vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(() => {
    const instance: FakeStreamManager = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      pushToken: vi.fn(),
      complete: vi.fn(),
      error: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    };
    streamManagerInstances.push(instance);
    return instance;
  }),
}));

async function sendMessage(container: HTMLElement) {
  const textarea = container.querySelector('textarea')!;
  fireEvent.change(textarea, { target: { value: 'hello' } });
  const sendButton = screen.getByRole('button', { name: /send|send message/i }) as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(sendButton);
  });
}

describe('ChatPage F1 — LLM init before generation (cold send)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    initCompleted = false;
    initCompletedAtQueryTime = null;
    streamManagerInstances.length = 0;
    cleanup();
  });
  afterEach(() => cleanup());

  it('awaits llmService.initialize() before orchestrator.query() on a cold send', async () => {
    const { container } = render(
      <ChatPage
        messages={[]}
        onMessagesChange={() => {}}
        onSaveConversation={() => {}}
        onNewChat={() => {}}
        onOpenSettings={() => {}}
      />
    );

    await sendMessage(container);

    await waitFor(() => {
      expect(fakeLlmService.initialize).toHaveBeenCalled();
      expect(callOrder).toContain('query');
    });

    const initIdx = callOrder.indexOf('initialize-start');
    const queryIdx = callOrder.indexOf('query');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(queryIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeLessThan(queryIdx);

    // The load-bearing assertion: initialize()'s internal work had actually
    // finished (crossed the macrotask boundary and flipped initCompleted)
    // by the time query() ran — proving ChatPage awaited initialize() rather
    // than firing it and moving on. A regressed ChatPage.tsx would observe
    // `false` here even though the two weaker index assertions above still
    // pass.
    expect(initCompletedAtQueryTime).toBe(true);
  });

  // F-MISSING-NEGATIVE-TEST: the file previously only exercised the happy
  // path (initialize() resolves). Cover the cold-send failure path too —
  // when initialize() itself rejects, ChatPage's try/catch (see
  // ChatPage.tsx runGeneration's browser-local IIFE) must route the failure
  // to the stream's error surface instead of ever reaching the orchestrator.
  it('routes an initialize() rejection to the stream error path without calling query()', async () => {
    fakeLlmService.initialize.mockImplementationOnce(async () => {
      callOrder.push('initialize-start');
      throw new Error('model failed to load');
    });

    const { container } = render(
      <ChatPage
        messages={[]}
        onMessagesChange={() => {}}
        onSaveConversation={() => {}}
        onNewChat={() => {}}
        onOpenSettings={() => {}}
      />
    );

    await sendMessage(container);

    await waitFor(() => {
      expect(streamManagerInstances.length).toBeGreaterThan(0);
    });
    const instance = streamManagerInstances[streamManagerInstances.length - 1];

    await waitFor(() => {
      expect(instance.error).toHaveBeenCalledWith('model failed to load');
    });

    // The orchestrator must never be reached when initialize() itself fails.
    expect(callOrder).not.toContain('query');
  });
});
