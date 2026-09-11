/**
 * B9 (issue #67) — AC5 UI half: when the desktop backend reports a REAL
 * inference engine with NO staged models, the chat surface shows a blocking
 * informative state and a send attempt NEVER issues a /ask call. With the
 * CI/dev stub engine (which answers /ask without weights) there is NO block.
 *
 * ChatPage is rendered inside the DesktopSessionProvider with a stub session
 * (no real network); the heavy browser-local inference modules are mocked
 * because this suite exercises the desktop gate, not the browser pipeline.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ChatPage } from './pages/ChatPage';
import { InferenceModeProvider } from './lib/inference';
import { DesktopSessionProvider, type DesktopSession, type DesktopSessionState } from './lib/desktop-session';
import type { ModelStatus } from './lib/api/types';

vi.mock('./lib/rag/rag-orchestrator', () => ({ RAGOrchestrator: vi.fn() }));
vi.mock('./lib/llm/llm-factory', () => ({
  getLLMService: vi.fn(),
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn(() => 'wllama'),
}));
vi.mock('./lib/llm/web-llm-service', () => ({ WEBLLM_DEFAULT_MODEL_ID: 'test-webllm' }));
vi.mock('./lib/llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn(async () => undefined),
  getReadinessResultSnapshot: vi.fn(() => null),
  resetReadinessCache: vi.fn(),
}));
vi.mock('./lib/models/model-manifest', () => ({ LLM_MODEL_DIR: 'test-model-dir' }));
vi.mock('./lib/export/conversation-export', () => ({ downloadConversation: vi.fn() }));
vi.mock('./hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: vi.fn() }));

function makeSession(): DesktopSession {
  return {
    baseUrl: 'http://127.0.0.1:4567',
    token: 'session-token',
    mode: 'node',
    apiClient: {
      listDocuments: vi.fn(async () => ({ documents: [], total: 0 })),
    } as unknown as DesktopSession['apiClient'],
    sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
  };
}

function status(partial: Partial<ModelStatus>): ModelStatus {
  return {
    engine: 'llama.cpp',
    profile: 'auto',
    models: { quality: { present: false }, fast: { present: false } },
    ...partial,
  } as ModelStatus;
}

function renderGate(models: ModelStatus | null, session: DesktopSession = makeSession()) {
  const state: DesktopSessionState = { session, models, loading: false, error: null };
  return render(
    <InferenceModeProvider>
      <DesktopSessionProvider value={state}>
        <ChatPage
        messages={[]}
        onMessagesChange={() => undefined}
        onSaveConversation={vi.fn()}
        currentConversationId={undefined}
        setCurrentConversationId={vi.fn()}
        onNewChat={vi.fn()}
        onOpenSettings={vi.fn()}
        onNavigateToDocuments={vi.fn()}
      />
      </DesktopSessionProvider>
    </InferenceModeProvider>,
  );
}

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ChatPage desktop first-run model gate (AC5 UI)', () => {
  it('BLOCKS with an informative alertdialog when a real engine has no models', async () => {
    renderGate(status({}));
    const dialog = await waitFor(() => {
      // Scoped by accessible name: the browser-local ModelBlockedOverlay is a
      // DIFFERENT alertdialog that may legitimately render in this harness.
      const el = screen.queryByRole('alertdialog', { name: /AI models are not installed yet/i });
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(dialog.getAttribute('aria-labelledby')).toBe('desktop-model-gate-title');
  });

  it('a send attempt while blocked issues NO fetch (no doomed /ask)', async () => {
    renderGate(status({}));
    await screen.findByRole('alertdialog', { name: /AI models are not installed yet/i });

    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'why is the sky blue?' } });
    const send = screen.getByLabelText('Send message');
    fireEvent.click(send);

    await waitFor(() => {
      // The optimistic user bubble may render, but the ask path never fires.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it('does NOT block the CI/dev stub engine (it answers /ask without weights)', () => {
    renderGate(status({ engine: 'stub', profile: 'auto' }));
    expect(screen.queryByText(/AI models are not installed yet/i)).toBeNull();
  });

  it('does NOT block when either profile is present', () => {
    renderGate(
      status({ models: { quality: { present: true }, fast: { present: false } } }),
    );
    expect(screen.queryByText(/AI models are not installed yet/i)).toBeNull();
  });
});
