// FROZEN CHECK C1 companion (issue #365 AC1) - token: safety-routing.
// ChatPage-level route matrix: a clinical question reaches NONE of the three
// answer paths (desktop SSE, ungrounded external generation, orchestrator-
// backed RAG) and NEVER initializes a model; a normal question still reaches
// its path (control). Plus: the refusal renders through the REAL streaming
// contract (token flush + onDone), persists with the safety metadata, and a
// reloaded refusal renders the safety notice (no "General knowledge" badge,
// no copy/citation actions); Regenerate re-runs the classifier.
//
// Boundary mock block copied from ChatPage.streaming-persistence.test.tsx
// (the live, CI-running ChatPage harness): rag-orchestrator, llm-factory,
// inference, readiness-gate, api/auth are mocked; ../lib/streaming stays
// REAL so complete()→flushBuffer()→onToken/onDone is the production path.
import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import 'fake-indexeddb/auto';
import type { ChatMessage } from '../../../types/chat';
import type { RAGEvent } from '../rag-orchestrator';

vi.mock('../rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(function () {
    return { query: vi.fn() };
  }),
}));

vi.mock('../../llm/llm-factory', () => ({
  getLLMService: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(),
  })),
  DEFAULT_BROWSER_ENGINE: 'wllama',
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn().mockReturnValue('wllama'),
}));

vi.mock('../../inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));

vi.mock('../../llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn().mockResolvedValue(null),
  getReadinessResultSnapshot: vi.fn().mockReturnValue(null),
  resetReadinessCache: vi.fn(),
}));

vi.mock('../../api/auth', () => ({
  getToken: vi.fn().mockReturnValue(null),
}));

const route = { desktop: false, externalUngrounded: false };

import { SAFETY_REFUSAL_TEXT } from '../safety-notice';

const fakeExternalService = {
  initialize: vi.fn(async () => undefined),
  generate: vi.fn(async function* (): AsyncGenerator<string> {
    yield 'EX';
    yield 'TERNAL-answer';
  }),
  interrupt: vi.fn(),
};

const fakeSession = {
  baseUrl: 'http://127.0.0.1:1',
  token: 'launch-token',
  sseUrl: () => 'http://127.0.0.1:1/ask/stream',
  apiClient: {
    getSettings: vi.fn(async () => ({})),
    updateSettings: vi.fn(async () => ({})),
  },
};

vi.mock('../../llm/external-provider', () => ({
  loadExternalConfig: vi.fn(),
  createExternalLLMService: vi.fn(() => fakeExternalService),
  isExternalActive: vi.fn(() => route.externalUngrounded),
}));

vi.mock('../../desktop-session', () => ({
  isElectron: vi.fn(() => route.desktop),
  fetchModelStatus: vi.fn(async () => ({})),
  modelsAbsentForRealEngine: vi.fn(() => false),
  useDesktopSession: vi.fn(() => ({
    session: route.desktop ? fakeSession : null,
    models: route.desktop ? { engine: 'external', profile: 'balanced', models: [] } : null,
  })),
}));

import { ChatPage } from '../../../pages/ChatPage';
import * as ragModule from '../rag-orchestrator';
import * as inferenceModule from '../../inference';
import * as llmFactoryModule from '../../llm/llm-factory';
import * as externalModule from '../../llm/external-provider';
import { TokenStreamManager } from '../../streaming';

const CLINICAL = 'Should I take 500 mg of metformin with my breakfast?';
const NORMAL = 'What is machine learning?';

function mockExternalConfig(enabled: boolean, grounded: boolean): void {
  (externalModule.loadExternalConfig as ReturnType<typeof vi.fn>).mockReturnValue(
    enabled
      ? {
          enabled: true,
          protocol: 'openai',
          baseUrl: 'http://127.0.0.1:1/v1',
          model: 'test-model',
          apiKey: 'sk-local',
          rememberKey: false,
          grounded,
        }
      : null,
  );
}

function renderChatPage(options?: {
  save?: 'mock' | 'real-dexie';
}): {
  onSave: ReturnType<typeof vi.fn>;
  getMessages: () => ChatMessage[];
  savedIds: string[];
} {
  const savedIds: string[] = [];
  let activeId: string | undefined;
  // Round 3: save='real-dexie' installs a save seam that persists through the
  // REAL conversations db (createConversation/updateConversation + reread via
  // getConversation) - the same layer the production saveMessages hook
  // delegates to - instead of resolving a no-op mock.
  const onSaveConversation =
    options?.save === 'real-dexie'
      ? vi.fn(
          async (
            conversationId: string | undefined,
            messages: ChatMessage[],
            _storageTag: string,
            _engine: unknown,
            onCreate?: (newId: string) => void,
          ): Promise<void> => {
            void _storageTag;
            void _engine;
            if (messages.length === 0) return;
            const { createConversation, updateConversation, getConversation } =
              await import('../../../db/conversations');
            const target = conversationId ?? activeId;
            if (target !== undefined) {
              const existing = await getConversation(target);
              if (existing === undefined) return; // production guard: never resurrect
              await updateConversation(target, { messages, updatedAt: Date.now() });
              return;
            }
            const id = `conv-r3-${Date.now()}-${savedIds.length}`;
            await createConversation({
              id,
              title: 'safety-routing round-3 real save',
              messages,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              mode: 'wllama',
              modelUsed: 'test-model',
            } as unknown as Parameters<typeof createConversation>[0]);
            savedIds.push(id);
            activeId = id;
            onCreate?.(id);
          },
        )
      : vi.fn(
          () =>
            new Promise<void>((resolve) => {
              void Promise.resolve().then(resolve);
            }),
        );
  // Lifted view (live streaming-persistence pattern): ChatPage pushes every
  // thread update through onMessagesChange; without threading it back the
  // parent keeps messages=[] and the refusal never renders.
  let messages: ChatMessage[] = [];
  function Harness(): React.ReactElement {
    const [view, setView] = React.useState<ChatMessage[]>(messages);
    return (
      <ChatPage
        messages={view}
        onMessagesChange={(next) => {
          const resolved = typeof next === 'function' ? (next as (p: ChatMessage[]) => ChatMessage[])(view) : next;
          messages = resolved;
          setView(resolved);
        }}
        onSaveConversation={onSaveConversation}
        onNewChat={() => {}}
        currentConversationId={undefined}
        setCurrentConversationId={() => {}}
        onOpenSettings={() => {}}
      />
    );
  }
  render(<Harness />);
  return { onSave: onSaveConversation, getMessages: () => messages, savedIds };
}

// Send INSIDE the act block (live ChatPage.streaming-persistence pattern,
// REAL timers - fake timers freeze ChatInput's async draft hydration so the
// send button never enables). handleSend awaits the send-time save, so the
// click must share one act() with its settle.
async function submitMessage(text: string): Promise<void> {
  await act(async () => {
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: text } });
    const sendButton = screen.getByRole('button', { name: /send message/i });
    fireEvent.click(sendButton);
  });
  // Flush microtasks + one macrotask so the RAF token flush and the
  // completion save land inside act.
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 25));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 25));
  });
}

function assistantSaves(calls: unknown[][]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of calls) {
    const messages = call[1] as unknown;
    if (!Array.isArray(messages)) continue;
    const assistant = messages.find((m) => (m as { role?: string }).role === 'assistant') as
      | Record<string, unknown>
      | undefined;
    if (assistant !== undefined) out.push(assistant);
  }
  return out;
}

describe('safety-routing: ChatPage pre-route branch (issue #365 AC1)', () => {
  let orchestratorQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    route.desktop = false;
    route.externalUngrounded = false;

    orchestratorQuery = vi.fn();
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(function () { return ({ query: orchestratorQuery }) as unknown as ragModule.RAGOrchestrator; });
    vi.mocked(llmFactoryModule.getLLMService).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(),
    }) as unknown as ReturnType<typeof llmFactoryModule.getLLMService>);

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
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);

    mockExternalConfig(false, true);
    fakeSession.apiClient.getSettings.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('route A (orchestrator-backed): clinical never reaches query; refusal renders (safety-routing)', async () => {
    orchestratorQuery.mockImplementation(async function* (): AsyncGenerator<RAGEvent> {
      yield { type: 'token', data: 'NORMAL-' };
      yield { type: 'complete', data: { answer: 'NORMAL', sources: [], chunks: [], grounding: 'grounded' } };
    });
    const { onSave } = renderChatPage();
    await submitMessage(CLINICAL);

    expect(orchestratorQuery).not.toHaveBeenCalled();
    expect(screen.getByText(SAFETY_REFUSAL_TEXT)).toBeInTheDocument();

    // Control: the in-scope question DOES take the orchestrator route.
    await submitMessage(NORMAL);
    expect(orchestratorQuery).toHaveBeenCalled();

    // The refusal persisted through the real save path with safety metadata.
    const refusals = assistantSaves(onSave.mock.calls).filter(
      (m) => (m.safety as { category?: string } | undefined)?.category === 'clinical',
    );
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals[0].content).toBe(SAFETY_REFUSAL_TEXT);
  });

  test('route B (ungrounded external): clinical never reaches the external generator (safety-routing)', async () => {
    route.externalUngrounded = true;
    mockExternalConfig(true, false);
    renderChatPage();
    await submitMessage(CLINICAL);

    expect(fakeExternalService.generate).not.toHaveBeenCalled();
    expect(fakeExternalService.initialize).not.toHaveBeenCalled();
    expect(screen.getByText(SAFETY_REFUSAL_TEXT)).toBeInTheDocument();

    // Control: in-scope question reaches the external path.
    await submitMessage(NORMAL);
    expect(fakeExternalService.generate).toHaveBeenCalled();
  });

  test('route C (desktop SSE): clinical never starts the SSE stream or the settings read (safety-routing)', async () => {
    route.desktop = true;
    const sseSpy = vi
      .spyOn(TokenStreamManager.prototype, 'startSSEStream')
      .mockImplementation((() => undefined) as never);
    renderChatPage();
    await submitMessage(CLINICAL);

    expect(sseSpy).not.toHaveBeenCalled();
    expect(fakeSession.apiClient.getSettings).not.toHaveBeenCalled();
    expect(screen.getByText(SAFETY_REFUSAL_TEXT)).toBeInTheDocument();

    // Control: in-scope question starts the SSE stream.
    await submitMessage(NORMAL);
    expect(sseSpy).toHaveBeenCalled();
  });

  test('reloaded refusal renders the safety notice without the grounding badge or copy actions (safety-routing)', async () => {
    const reloaded: ChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: SAFETY_REFUSAL_TEXT,
        timestamp: Date.now(),
        grounding: 'general',
        safety: { category: 'clinical', matchedRules: ['dosing-personal-take'] },
      },
    ];
    render(
      <ChatPage
        messages={reloaded}
        onMessagesChange={() => {}}
        onSaveConversation={async () => {}}
        onNewChat={() => {}}
        currentConversationId={'conv-1'}
        setCurrentConversationId={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    await flush();

    expect(screen.getByText(SAFETY_REFUSAL_TEXT)).toBeInTheDocument();
    expect(screen.getByTestId('safety-notice')).toBeInTheDocument();
    expect(screen.queryByText('General knowledge')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^copy message$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^copy source$/i })).not.toBeInTheDocument();
  });

  test('a REAL ChatPage send/completion with canary content leaks nothing into the audit rows (safety-routing)', async () => {
    // Review rounds 2+3: the no-leak proof rides the REAL send/completion
    // flow with the REAL Dexie conversation save, and the audit-row read is
    // guarded NONEMPTY (a governance row seeded through the real writer)
    // so the not-contains assertions cannot pass vacuously on an empty
    // table.
    const audit = await import('../../../db/audit');
    await audit.appendAuditEvent('app_start', null); // the app-shell lifecycle row
    const { savedIds } = renderChatPage({ save: 'real-dexie' });
    const USER_CANARY = 'user-canary-zq81XT send this exact text';
    const ASSISTANT_CANARY = 'assistant-canary-wm52YL grounded answer text';
    orchestratorQuery.mockImplementation(async function* (): AsyncGenerator<RAGEvent> {
      yield { type: 'token', data: ASSISTANT_CANARY };
      yield { type: 'complete', data: { answer: ASSISTANT_CANARY, sources: [], chunks: [], grounding: 'grounded' } };
    });
    await submitMessage(USER_CANARY);
    // The REAL conversation db carries both canaries (round 3: the save
    // rode createConversation, not a mock capture). The real save settles
    // on real timers (migration + write-lock + key probe), so poll.
    const { getConversation } = await import('../../../db/conversations');
    let conv: Awaited<ReturnType<typeof getConversation>>;
    await waitFor(
      () => {
        expect(savedIds.length, 'the real save must have created a conversation').toBeGreaterThan(0);
      },
      { timeout: 3000, interval: 50 },
    );
    await waitFor(
      async () => {
        conv = await getConversation(savedIds[savedIds.length - 1]);
        expect(
          (conv?.messages ?? []).some((m) => m.role === 'assistant' && m.content.includes(ASSISTANT_CANARY)),
          'the completion save must have landed the assistant answer',
        ).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );
    expect(conv, 'the conversation row must exist').toBeDefined();
    const convText = JSON.stringify(conv);
    expect(convText).toContain(USER_CANARY);
    expect(convText).toContain(ASSISTANT_CANARY);
    // The audit db rows (same realm, different db) carry none of it - and
    // they are NONEMPTY (the precondition that makes not-contains mean
    // something).
    const rows = await audit.auditDb.events.toArray();
    expect(rows.length, 'audit rows must exist for the no-leak read to be meaningful').toBeGreaterThan(0);
    expect(rows.some((r) => r.event === 'app_start')).toBe(true);
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain('zq81XT');
    expect(raw).not.toContain('wm52YL');
  });

  test('the refusal persists through the REAL conversation db and re-reads with its safety metadata (safety-routing)', async () => {
    // Review round 3: the reread must ride the REAL Dexie save/read path
    // (createConversation at the send-time save, updateConversation at the
    // completion save, getConversation to reread) - the same layer the
    // production saveMessages hook uses - so a persistence layer dropping
    // the safety metadata would fail this leg, which the captured mock
    // payload could never detect.
    const { savedIds } = renderChatPage({ save: 'real-dexie' });
    await submitMessage(CLINICAL);
    await flush();
    // The real save settles on real timers (migration + write-lock + key
    // probe), so poll instead of a fixed flush.
    await waitFor(
      () => {
        expect(savedIds.length, 'the send-time save must have created the conversation').toBeGreaterThan(0);
      },
      { timeout: 3000, interval: 50 },
    );
    const { getConversation } = await import('../../../db/conversations');
    let conv: Awaited<ReturnType<typeof getConversation>>;
    await waitFor(
      async () => {
        conv = await getConversation(savedIds[savedIds.length - 1]);
        expect(
          (conv?.messages ?? []).some((m) => m.role === 'assistant' && m.content === SAFETY_REFUSAL_TEXT),
          'the completion save must have landed the refusal answer',
        ).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );
    const persistedAssistant = (conv as { messages: ChatMessage[] }).messages.find(
      (m) => m.role === 'assistant',
    );
    expect(persistedAssistant, 'the persisted assistant row must exist').toBeDefined();
    expect(persistedAssistant?.content).toBe(SAFETY_REFUSAL_TEXT);
    expect((persistedAssistant?.safety as { category?: string } | undefined)?.category).toBe('clinical');
    expect((persistedAssistant?.safety as { matchedRules?: string[] } | undefined)?.matchedRules).toContain(
      'dosing-personal-take',
    );
    // Unmount the send-phase tree before rendering the reloaded row (the
    // refusal text would otherwise appear twice).
    cleanup();
    // Render the rows REREAD FROM THE DB (not the in-memory thread, not a
    // mock capture).
    render(
      <ChatPage
        messages={(conv as { messages: ChatMessage[] }).messages}
        onMessagesChange={() => {}}
        onSaveConversation={async () => {}}
        onNewChat={() => {}}
        currentConversationId={'conv-r3-reread'}
        setCurrentConversationId={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    await flush();
    expect(screen.getByText(SAFETY_REFUSAL_TEXT)).toBeInTheDocument();
    expect(screen.getByTestId('safety-notice')).toBeInTheDocument();
    expect(screen.queryByText('General knowledge')).not.toBeInTheDocument();
    // The refusal message's OWN actions are suppressed; the USER message in
    // the reread thread legitimately keeps its copy affordance, so the
    // absence assertions are scoped to the assistant container.
    const assistantRegion = document.querySelector('[data-role="assistant"]') as HTMLElement;
    expect(assistantRegion).toBeDefined();
    expect(within(assistantRegion).queryByRole('button', { name: /^copy message$/i })).not.toBeInTheDocument();
    expect(within(assistantRegion).queryByRole('button', { name: /^copy source$/i })).not.toBeInTheDocument();
  });

  test('Regenerate on a refusal re-runs the classifier and never touches the route (safety-routing)', async () => {
    const { onSave } = renderChatPage();
    await submitMessage(CLINICAL);
    const refusalsAfterFirst = assistantSaves(onSave.mock.calls).filter(
      (m) => (m.safety as { category?: string } | undefined)?.category === 'clinical',
    );
    expect(refusalsAfterFirst.length).toBeGreaterThan(0);
    expect(orchestratorQuery).not.toHaveBeenCalled();

    // The Regenerate affordance is REQUIRED here (review round: a Send
    // fallback would not prove the Regenerate entry re-runs the classifier).
    const regen = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /regenerate response/i });
      return btn;
    });
    await act(async () => {
      fireEvent.click(regen);
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(orchestratorQuery).not.toHaveBeenCalled();
    const refusals = assistantSaves(onSave.mock.calls).filter(
      (m) => (m.safety as { category?: string } | undefined)?.category === 'clinical',
    );
    expect(refusals.length).toBeGreaterThan(1);
  });
});
