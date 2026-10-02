/**
 * ChatPage external-model integration tests (universal-provider-settings-
 * overhaul; successor of PR #138's provider-mode tests — that mode is retired
 * and its direct generation lives on as the opt-in "Direct chat").
 *
 * Renders the REAL ChatPage in browser-local mode with an enabled external
 * configuration (external-provider-config) against a local OpenAI-shaped mock
 * server (real fetch, real OpenAICompatChatService) and asserts:
 *   - Direct chat POSTs `<base>/v1/chat/completions` with the desktop's
 *     EXTERNAL_SYSTEM_PROMPT first (F-004 parity), threaded history, bounded
 *     per-turn content, and streams the reply — and the local browser
 *     model's readiness does not gate it;
 *   - Direct chat never threads a retrieval-grounded answer (F-012);
 *   - a DISABLED external config never contacts the endpoint (the local
 *     engine gate applies instead);
 *   - an unreachable endpoint surfaces a classified error in the message list;
 *   - an errored prior turn never produces two consecutive user messages;
 *   - in the desktop app an external backend engine is never gated by the
 *     local-model overlay or the resident-load poll.
 * (Grounded external answers through RAGOrchestrator are pinned by the frozen
 * trace check C4; this file keeps the direct path's regression coverage.)
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ---- Boundary mocks (ChatPage's transitive graph pulls native/EWM deps) ----
vi.mock('../../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));
vi.mock('../../lib/theme', () => ({
  useTheme: vi.fn(),
}));
vi.mock('../../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn(),
}));
vi.mock('../../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn(),
  disposeBrowserEngine: vi.fn(),
}));
vi.mock('../../lib/llm/web-llm-service', () => ({
  WEBLLM_DEFAULT_MODEL_ID: 'test-webllm-model',
}));
vi.mock('../../lib/llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn(() => Promise.resolve()),
  getReadinessResultSnapshot: vi.fn(() => null),
  resetReadinessCache: vi.fn(),
}));
vi.mock('../../lib/models/model-manifest', () => ({
  LLM_MODEL_DIR: 'gemma-4-e2b-it',
}));
vi.mock('../../lib/desktop-session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/desktop-session')>();
  return {
    isElectron: vi.fn(() => false),
    initDesktopSession: vi.fn(() => Promise.reject(new Error('no desktop in tests'))),
    useDesktopSession: vi.fn(() => ({ session: null, models: null, loading: false, error: null })),
    fetchModelStatus: vi.fn(() => Promise.reject(new Error('no desktop in tests'))),
    // The REAL predicate: engine 'external' never gates on absent GGUFs.
    modelsAbsentForRealEngine: real.modelsAbsentForRealEngine,
  };
});
vi.mock('../../lib/export/conversation-export', () => ({
  downloadConversation: vi.fn(),
}));

import { ChatPage } from '../ChatPage';
import * as inferenceModule from '../../lib/inference';
import * as themeModule from '../../lib/theme';
import * as desktopSessionModule from '../../lib/desktop-session';
import type { ChatMessage } from '../../types/chat';
import {
  EXTERNAL_GROUNDED_INSTRUCTION,
  EXTERNAL_GROUNDED_QUESTION_LABEL,
  EXTERNAL_SYSTEM_PROMPT,
} from '../../lib/llm/external-prompts';
import * as ragModule from '../../lib/rag/rag-orchestrator';
import { TokenStreamManager } from '../../lib/streaming';

/** F-004: every Direct-chat request opens with the desktop's system prompt. */
const SYSTEM = { role: 'system', content: EXTERNAL_SYSTEM_PROMPT };

function mockContext(mode: string, isModelReady = false): void {
  vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
    mode,
    browserEngine: 'wllama',
    ragPreset: 'balanced',
    isServerConnected: false,
    isModelReady,
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

  vi.mocked(themeModule.useTheme).mockReturnValue({
    theme: 'light',
    themePreference: 'system',
    setTheme: vi.fn(),
    isDark: false,
  } as unknown as ReturnType<typeof themeModule.useTheme>);
}

function configureDirect(baseUrl: string, enabled = true): void {
  localStorage.setItem(
    'external-provider-config',
    JSON.stringify({ enabled, protocol: 'openai', baseUrl, model: 'local-model', grounded: false, rememberKey: false })
  );
}

interface RecordedRequest {
  url: string;
  body: {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    stream?: boolean;
  };
}

function startMockOpenAI(): Promise<{
  server: http.Server;
  port: number;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: RecordedRequest['body'] = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      requests.push({ url: req.url ?? '', body });
      if ((req.url ?? '').endsWith('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frames = ['Hi', ' there'].map(
          (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`
        );
        res.end([...frames, 'data: [DONE]', ''].join('\n'));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, requests });
    });
  });
}

function msg(role: 'user' | 'assistant', content: string): ChatMessage {
  return {
    id: `${role}-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    timestamp: Date.now(),
  } as unknown as ChatMessage;
}

function renderChat(overrides: { messages?: ChatMessage[] }): void {
  // ChatPage is a CONTROLLED component: message updates flow through
  // onMessagesChange — hold real state here.
  function Harness(): React.ReactElement {
    const [messages, setMessages] = React.useState<ChatMessage[]>(overrides.messages ?? []);
    return (
      <ChatPage
        messages={messages}
        onMessagesChange={setMessages}
        onSaveConversation={vi.fn()}
        currentConversationId={undefined}
        setCurrentConversationId={vi.fn()}
        onNewChat={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );
  }
  render(<Harness />);
}

describe('ChatPage external model, Direct chat (browser app)', () => {
  let server: http.Server;
  let port: number;
  let requests: RecordedRequest[];

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    // isModelReady false: the LOCAL browser model is not loaded — an external
    // endpoint must not be gated by it.
    mockContext('browser-local', false);
    const started = await startMockOpenAI();
    server = started.server;
    port = started.port;
    requests = started.requests;
    configureDirect(`http://127.0.0.1:${port}`);
  });

  afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('a send POSTs the OpenAI body with threaded history and streams the reply', async () => {
    // A prior Direct answer as ChatPage finalizes it (grounding 'general', no
    // sources): the only assistant shape the F-012 fail-closed filter threads.
    const prior = [
      msg('user', 'What is a retriever?'),
      { ...msg('assistant', 'A retrieval component.'), grounding: 'general', sources: [] } as ChatMessage,
    ];
    renderChat({ messages: prior });
    const input = screen.getByLabelText('Message input');
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: 'and the ranker?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 10_000 });
    const req = requests[0];
    expect(req.url).toBe('/v1/chat/completions');
    expect(req.body.model).toBe('local-model');
    expect(req.body.stream).toBe(true);
    expect(req.body.messages).toEqual([
      SYSTEM,
      { role: 'user', content: 'What is a retriever?' },
      { role: 'assistant', content: 'A retrieval component.' },
      { role: 'user', content: 'and the ranker?' },
    ]);
    await waitFor(() => expect(screen.getByText('Hi there')).toBeInTheDocument(), { timeout: 10_000 });
    // Two badges: the prior Direct answer's and the new reply's.
    await waitFor(() => expect(screen.getAllByText('General knowledge')).toHaveLength(2));
  });

  test('F-012: Direct-to-Direct continuity — a finalized Direct answer threads into the next Direct send', async () => {
    // No hand-built fixture: the first answer is finalized by ChatPage itself
    // (onDone stamps grounding 'general', sources []), then must survive the
    // fail-closed filter into the second request.
    renderChat({});
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'first question' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hi there')).toBeInTheDocument(), { timeout: 10_000 });
    // The badge renders once onDone has finalized the turn (not while streaming).
    expect(await screen.findByText('General knowledge', undefined, { timeout: 10_000 })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'second question' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled(), { timeout: 10_000 });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(requests.length).toBe(2), { timeout: 10_000 });
    expect(requests[1].body.messages ?? []).toEqual([
      SYSTEM,
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'second question' },
    ]);
  });

  test('a DISABLED external config never contacts the endpoint (the local engine gate applies)', async () => {
    configureDirect(`http://127.0.0.1:${port}`, false);
    renderChat({});
    expect(screen.getByLabelText('Message input')).toBeDisabled();
    await new Promise((r) => setTimeout(r, 300));
    expect(requests.length).toBe(0);
  });

  test('an unreachable endpoint surfaces a classified error in the message list', async () => {
    configureDirect('http://127.0.0.1:1');
    renderChat({});
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/Cannot reach http:\/\/127\.0\.0\.1:1/i)).toBeInTheDocument(), {
      timeout: 15_000,
    });
  });

  test('history content is truncated to the 4000-char per-turn bound', async () => {
    const longTurn = 'x'.repeat(5000);
    renderChat({
      messages: [msg('user', longTurn), { ...msg('assistant', 'ok'), grounding: 'general', sources: [] } as ChatMessage],
    });
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'summarize' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 10_000 });
    const wireMessages = requests[0].body.messages ?? [];
    expect(wireMessages.length).toBe(4);
    expect(wireMessages[0]).toEqual(SYSTEM);
    expect(wireMessages[1].content.length).toBe(4000);
    expect(wireMessages[3].content).toBe('summarize');
  });

  test('F-004: an errored prior turn never produces two consecutive user messages', async () => {
    const prior = [
      msg('user', 'unanswered question'),
      { ...msg('assistant', 'boom'), error: 'server unreachable' } as ChatMessage,
    ];
    renderChat({ messages: prior });
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'retry the question' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(requests[0].body.messages ?? []).toEqual([SYSTEM, { role: 'user', content: 'retry the question' }]);
  });

  test('F-012: a retrieval-grounded prior answer is never threaded into Direct chat', async () => {
    const prior = [
      msg('user', 'what does the SOP say?'),
      { ...msg('assistant', 'Per the SOP [1], restart the pump.'), grounding: 'grounded' } as ChatMessage,
      msg('user', 'what is a pump?'),
      { ...msg('assistant', 'A device that moves fluid.'), grounding: 'general' } as ChatMessage,
    ];
    renderChat({ messages: prior });
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'and a valve?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(requests[0].body.messages ?? []).toEqual([
      SYSTEM,
      { role: 'user', content: 'what is a pump?' },
      { role: 'assistant', content: 'A device that moves fluid.' },
      { role: 'user', content: 'and a valve?' },
    ]);
  });
});

describe('F-004: grounded external answers use the desktop prompt text', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockContext('browser-local', false);
  });
  afterEach(() => {
    cleanup();
    vi.mocked(ragModule.RAGOrchestrator).mockReset();
  });

  async function sendAndCaptureQueryOptions(external: boolean): Promise<Record<string, unknown>> {
    if (external) {
      localStorage.setItem(
        'external-provider-config',
        JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'm', grounded: true, rememberKey: false })
      );
    }
    const captured: Array<Record<string, unknown>> = [];
    vi.mocked(ragModule.RAGOrchestrator).mockImplementation(
      () =>
        ({
          query: async function* (_q: string, options: Record<string, unknown>) {
            captured.push(options);
            yield { type: 'token', data: 'ok' };
            yield {
              type: 'complete',
              data: { answer: 'ok', sources: [], chunks: [], grounding: 'general', learn: [] },
            };
          },
        }) as unknown as ragModule.RAGOrchestrator
    );
    renderChat({});
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'grounded question' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(captured.length).toBe(1), { timeout: 10_000 });
    return captured[0];
  }

  test('an external generator gets EXTERNAL_SYSTEM_PROMPT and the shared grounded framing', async () => {
    const options = await sendAndCaptureQueryOptions(true);
    expect(options.systemPrompt).toBe(EXTERNAL_SYSTEM_PROMPT);
    expect(options.groundedFraming).toEqual({
      instruction: EXTERNAL_GROUNDED_INSTRUCTION,
      questionLabel: EXTERNAL_GROUNDED_QUESTION_LABEL,
    });
  });
});

describe('desktop app: an external backend engine is never gated by local-model state', () => {
  type DesktopSessionLike = NonNullable<ReturnType<typeof desktopSessionModule.useDesktopSession>['session']>;
  const fakeSession = {
    baseUrl: 'http://127.0.0.1:4567',
    token: 'trace-token',
    mode: 'node',
    apiClient: {},
    sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
  } as unknown as DesktopSessionLike;

  beforeEach(() => {
    localStorage.clear();
    mockContext('api', false);
    vi.mocked(desktopSessionModule.useDesktopSession).mockReturnValue({
      session: fakeSession,
      models: {
        engine: 'external',
        profile: 'auto',
        models: { quality: { present: false }, fast: { present: false } },
        resident: { state: 'idle', profile: null, loadStartedAt: null },
      },
      loading: false,
      error: null,
    } as ReturnType<typeof desktopSessionModule.useDesktopSession>);
    vi.mocked(desktopSessionModule.fetchModelStatus).mockResolvedValue({
      engine: 'llama.cpp',
      profile: 'quality',
      models: { quality: { present: true }, fast: { present: true } },
      resident: { state: 'loading', profile: 'quality', loadStartedAt: 1 },
    } as unknown as Awaited<ReturnType<typeof desktopSessionModule.fetchModelStatus>>);
  });

  afterEach(() => {
    cleanup();
    vi.mocked(desktopSessionModule.useDesktopSession).mockReturnValue({
      session: null,
      models: null,
      loading: false,
      error: null,
    } as ReturnType<typeof desktopSessionModule.useDesktopSession>);
    vi.mocked(desktopSessionModule.fetchModelStatus).mockImplementation(() =>
      Promise.reject(new Error('no desktop in tests'))
    );
  });

  test('no model-blocked overlay, no resident-load poll, input enabled', async () => {
    renderChat({});
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('alertdialog', { name: /AI models are not installed yet/i })).toBeNull();
    expect(desktopSessionModule.fetchModelStatus).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message input')).not.toBeDisabled();
  });
});

describe('F-012 (Stage B): desktop Direct chat never threads retrieval-grounded answers to the backend', () => {
  type DesktopSessionLike = NonNullable<ReturnType<typeof desktopSessionModule.useDesktopSession>['session']>;
  type SseBody = { question?: string; history?: Array<{ role: string; content: string }> };
  let bodies: SseBody[];
  let getSettings: ReturnType<typeof vi.fn>;

  const EXTERNAL = {
    'external.enabled': true,
    'external.baseUrl': 'http://127.0.0.1:1234/v1',
    'external.model': 'm',
  };

  /** Prior turns: one retrieval-grounded answer, one general answer. */
  function prior(): ChatMessage[] {
    return [
      msg('user', 'What does the handbook say about leave?'),
      { ...msg('assistant', 'GROUNDED-ANSWER from the handbook passages'), grounding: 'grounded' } as ChatMessage,
      msg('user', 'Tell me a joke'),
      { ...msg('assistant', 'GENERAL-ANSWER a joke'), grounding: 'general' } as ChatMessage,
    ];
  }

  beforeEach(() => {
    localStorage.clear();
    mockContext('api', true);
    bodies = [];
    // The /ask/stream POST body exactly as ChatPage hands it to the SSE
    // transport (jsdom's AbortSignal realm cannot drive the real fetch here).
    vi.spyOn(TokenStreamManager.prototype, 'startSSEStream').mockImplementation(function (_url: string, body: object) {
      bodies.push(body as SseBody);
      return undefined as unknown as ReturnType<TokenStreamManager['startSSEStream']>;
    });
    getSettings = vi.fn();
    const session = {
      baseUrl: 'http://127.0.0.1:4567',
      token: 'trace-token',
      mode: 'node',
      apiClient: { getSettings },
      sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
    } as unknown as DesktopSessionLike;
    vi.mocked(desktopSessionModule.useDesktopSession).mockReturnValue({
      session,
      models: {
        engine: 'external',
        profile: 'auto',
        models: { quality: { present: false }, fast: { present: false } },
        resident: { state: 'idle', profile: null, loadStartedAt: null },
      },
      loading: false,
      error: null,
    } as ReturnType<typeof desktopSessionModule.useDesktopSession>);
  });

  afterEach(() => {
    cleanup();
    vi.mocked(TokenStreamManager.prototype.startSSEStream).mockRestore();
    vi.mocked(desktopSessionModule.useDesktopSession).mockReturnValue({
      session: null,
      models: null,
      loading: false,
      error: null,
    } as ReturnType<typeof desktopSessionModule.useDesktopSession>);
  });

  async function sendAndCapture(): Promise<string> {
    renderChat({ messages: prior() });
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'and one more?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(bodies.length).toBe(1), { timeout: 10_000 });
    expect(bodies[0].question).toBe('and one more?');
    expect(getSettings).toHaveBeenCalledTimes(1);
    return JSON.stringify(bodies[0].history ?? []);
  }

  test('backend external + grounded=false: the grounded answer is NOT in the /ask/stream history', async () => {
    getSettings.mockResolvedValue({ ...EXTERNAL, 'external.grounded': false });
    const history = await sendAndCapture();
    expect(history).not.toContain('GROUNDED-ANSWER');
    expect(history).not.toContain('handbook say about leave');
    expect(history).toContain('GENERAL-ANSWER');
  });

  test('backend external + grounded=true: the grounded answer IS threaded (retrieval context goes there anyway)', async () => {
    getSettings.mockResolvedValue({ ...EXTERNAL, 'external.grounded': true });
    const history = await sendAndCapture();
    expect(history).toContain('GROUNDED-ANSWER');
    expect(history).toContain('GENERAL-ANSWER');
  });

  test('GET /settings fails: fail closed, the grounded answer is NOT threaded', async () => {
    getSettings.mockRejectedValue(new Error('backend busy'));
    const history = await sendAndCapture();
    expect(history).not.toContain('GROUNDED-ANSWER');
    expect(history).toContain('GENERAL-ANSWER');
  });

  test('Stop pressed while GET /settings is in flight: /ask/stream is never started for that send', async () => {
    let resolveSettings!: (v: Record<string, unknown>) => void;
    getSettings.mockReturnValue(
      new Promise<Record<string, unknown>>((resolve) => {
        resolveSettings = resolve;
      })
    );
    renderChat({ messages: prior() });
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'and one more?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));
    // The GET is pending: nothing has been sent yet.
    expect(bodies).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: /stop generation/i }));
    resolveSettings({ ...EXTERNAL, 'external.grounded': false });
    // Let the awaiting continuation run before asserting the negative.
    await new Promise((r) => setTimeout(r, 100));

    expect(TokenStreamManager.prototype.startSSEStream).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(0);
  });
});
