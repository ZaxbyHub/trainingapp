/**
 * F1 integration test: a cold-state browser-local send must initialize the LLM
 * service BEFORE the orchestrator calls generate(). Issue #21 acceptance
 * criterion #1: "A fresh page load in browser-local/wllama mode can send a
 * message and receive a streamed answer without any manual Settings
 * interaction." (PR #28 PRR-001)
 *
 * Mocks llm-factory (controllable fake LLMService) and RAGOrchestrator (no real
 * pipeline), then asserts ORDERING: initialize() is awaited before query().
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { ChatPage } from './ChatPage';

// Call-order log shared between the fake service and the orchestrator mock.
const callOrder: string[] = [];
const initMock = vi.fn(async () => undefined);

const fakeLlmService = {
  initialize: vi.fn(async () => {
    callOrder.push('initialize');
    await initMock();
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

describe('ChatPage F1 — LLM init before generation (cold send)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
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

    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'hello' } });
    const sendButton = screen.getByRole('button', { name: /send|send message/i }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(sendButton);
    });

    await waitFor(() => {
      expect(fakeLlmService.initialize).toHaveBeenCalled();
      expect(callOrder).toContain('query');
    });

    const initIdx = callOrder.indexOf('initialize');
    const queryIdx = callOrder.indexOf('query');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(queryIdx).toBeGreaterThanOrEqual(0);
    // The load-bearing assertion: initialize ran before query.
    expect(initIdx).toBeLessThan(queryIdx);
  });
});
