/**
 * ChatPage.model-loading.test.tsx — #133 round 4: chat is DISABLED with an
 * explanatory banner while the desktop backend reports a resident-model load
 * in flight (GET /status/models -> resident.state === 'loading'); it enables
 * the moment the load completes ('ready'). The old elapsed-time heuristic
 * (any >8s generation shows a load notice) is gone.
 *
 * Uses the ChatPage test-harness mock recipe (db/conversations,
 * useServiceInitialization, RAG orchestrator, streaming TokenStreamManager).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const statusResident = vi.hoisted(() => vi.fn());
const sessionStub = vi.hoisted(() => ({
  session: {
    baseUrl: 'http://127.0.0.1:1',
    token: 't',
    sseUrl: () => 'http://127.0.0.1:1/ask/stream',
    apiClient: {},
  },
  models: null,
}));

vi.mock('../lib/desktop-session', () => ({
  useDesktopSession: () => sessionStub,
  modelsAbsentForRealEngine: () => false,
  fetchModelStatus: statusResident,
  isElectron: () => true,
}));

vi.mock('../lib/storage/db/conversations', () => ({
  conversationDb: { getAll: async () => [], put: async () => {}, delete: async () => {} },
}));
vi.mock('../hooks/useServiceInitialization', () => ({
  useServiceInitialization: () => ({ isInitialized: true, error: null }),
}));
vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(() => ({ query: vi.fn() })),
}));
vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn().mockReturnValue({ streamQuery: vi.fn() }),
}));
vi.mock('../lib/streaming', () => {
  const TokenStreamManager = vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    cancel: vi.fn(),
    onToken: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    complete: vi.fn(),
  }));
  return { TokenStreamManager };
});
vi.mock('../lib/api/client');
vi.mock('../lib/inference', () => ({
  useInferenceMode: () => ({
    mode: 'desktop',
    browserEngine: null,
    ragPreset: 'balanced',
    isModelReady: true,
    isServerConnected: true,
    modelLoadingProgress: 0,
    serverUrl: null,
    setModelLoadingProgress: vi.fn(),
  }),
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { ChatPage } from './ChatPage';

// ChatPage requires a messages array prop (and its conversation callbacks).
const baseProps = {
  messages: [] as never[],
  onMessagesChange: vi.fn(),
  onSaveConversation: vi.fn(),
  currentConversationId: undefined as string | undefined,
  setCurrentConversationId: vi.fn(),
  onNewChat: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenTraining: vi.fn(),
};

beforeEach(() => {
  statusResident.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The payload shape mirrors llama-engine's residentLoadStatus() exactly:
// during 'loading' the engine reports the profile BEING loaded (its
// loadingProfile capture — resident is null until ready), so the banner can
// name the model; 'ready' reports the resident profile; 'idle' reports null.
const resident = (state: 'idle' | 'loading' | 'ready', profile: string) => ({
  engine: 'llama.cpp',
  profile,
  models: { quality: { present: true }, fast: { present: true } },
  resident: { state, profile, loadStartedAt: state === 'loading' ? Date.now() - 45_000 : null },
});

describe('ChatPage model-load gating (#133 round 4)', () => {
  it('disables input and shows the loading banner while resident.state === loading', async () => {
    statusResident.mockResolvedValue(resident('loading', 'quality'));
    render(<ChatPage {...baseProps} />);
    const banner = await screen.findByTestId('chat-model-loading');
    expect(banner.textContent).toContain('Loading the AI model');
    expect(banner.textContent).toContain('quality profile');
    expect(banner.textContent).toContain('chat is disabled');
    expect(banner.textContent).toContain('Documents and Training');
    // Type text first so the ONLY remaining disabled reason is the load gate
    // (the send button is disabled for an empty input by design).
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    const send = await screen.findByRole('button', { name: /send message/i });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables input once the load completes (ready)', async () => {
    statusResident.mockResolvedValueOnce(resident('loading', 'quality')).mockResolvedValue(resident('ready', 'quality'));
    render(<ChatPage {...baseProps} />);
    await screen.findByTestId('chat-model-loading');
    // The poll runs on a 2s interval — the banner clears on the next tick
    // after the status flips to ready.
    await waitFor(
      () => {
        expect(screen.queryByTestId('chat-model-loading')).toBeNull();
      },
      { timeout: 5_000 },
    );
    // With text typed and the load complete, the ONLY disabled reasons are
    // gone — the send button must be enabled.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    const send = screen.getByRole('button', { name: /send message/i });
    expect((send as HTMLButtonElement).disabled).toBe(false);
  });

  it('never gates when the backend omits resident (older builds / stub)', async () => {
    statusResident.mockResolvedValue({
      engine: 'stub',
      profile: 'auto',
      models: { quality: { present: false }, fast: { present: false } },
    });
    render(<ChatPage {...baseProps} />);
    // Give the poll a chance; the banner must never appear.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId('chat-model-loading')).toBeNull();
  });
});
