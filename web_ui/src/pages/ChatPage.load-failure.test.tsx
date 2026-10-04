/**
 * A browser-local model load that fails (or is aborted) partway must reset the shared
 * modelLoadingProgress to 0, otherwise InferenceModeToggle keeps saying "Loading…"
 * (0 < progress < 100) for a load that is no longer in flight (PR #149 review).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { ChatPage } from './ChatPage';

const setProgress = vi.hoisted(() => vi.fn());
const initImpl = vi.hoisted(() => ({ fn: null as null | ((onProgress: (p: { progress: number }) => void) => Promise<void>) }));

const fakeLlmService = {
  initialize: vi.fn(async (_id: string, onProgress: (p: { progress: number }) => void) => initImpl.fn!(onProgress)),
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
    setModelLoadingProgress: setProgress,
    setMode: vi.fn(),
    setBrowserEngine: vi.fn(),
    setRagPreset: vi.fn(),
    setServerUrl: vi.fn(),
    checkServerConnectivity: vi.fn(),
    setModelReady: vi.fn(),
    modeError: null,
  }),
}));
vi.mock('../components/StreamingIndicator', () => ({ StreamingIndicator: () => null }));
vi.mock('../components/InferenceModeToggle', () => ({ InferenceModeToggle: () => null }));
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

async function sendMessage(container: HTMLElement) {
  fireEvent.change(container.querySelector('textarea')!, { target: { value: 'hello' } });
  const sendButton = screen.getByRole('button', { name: /send|send message/i }) as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(sendButton);
  });
}

function renderChat() {
  return render(
    <ChatPage
      messages={[]}
      onMessagesChange={() => {}}
      onSaveConversation={() => {}}
      onNewChat={() => {}}
      currentConversationId={undefined}
      setCurrentConversationId={() => {}}
      onOpenSettings={() => {}}
    />
  );
}

describe('ChatPage resets model-load progress when a browser-local load fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });
  afterEach(() => cleanup());

  it('a load that reports 40% then rejects ends with setModelLoadingProgress(0)', async () => {
    initImpl.fn = async (onProgress) => {
      onProgress({ progress: 0.4 });
      throw new Error('model failed to load');
    };
    const { container } = renderChat();
    await sendMessage(container);
    await waitFor(() => expect(setProgress).toHaveBeenCalledWith(40));
    await waitFor(() => expect(setProgress.mock.calls[setProgress.mock.calls.length - 1][0]).toBe(0));
  });

  it('a successful load does not reset progress to 0 after it reports 100', async () => {
    initImpl.fn = async (onProgress) => {
      onProgress({ progress: 1 });
    };
    const { container } = renderChat();
    await sendMessage(container);
    await waitFor(() => expect(setProgress).toHaveBeenCalledWith(100));
    expect(setProgress.mock.calls[setProgress.mock.calls.length - 1][0]).toBe(100);
  });
});
