/**
 * ChatPage provider-branch integration test (trace
 * external-llm-provider-settings, AC1's runtime half).
 *
 * Renders the REAL ChatPage in provider mode against a local OpenAI-shaped
 * mock server (real fetch, real OpenAICompatChatService) and asserts:
 *   - a send reaches `<base>/v1/chat/completions` with an OpenAI body;
 *   - conversation history is threaded (multi-turn: the prior user/assistant
 *     exchange precedes the current question in `messages`);
 *   - streamed deltas reach the message list;
 *   - an unconfigured provider surfaces the actionable error instead of
 *     attempting a request;
 *   - an unreachable server surfaces the failure through the message list.
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
const gateState = vi.hoisted(() => ({ modelsAbsent: false }));
vi.mock('../../lib/desktop-session', () => ({
  isElectron: vi.fn(() => false),
  initDesktopSession: vi.fn(() => Promise.reject(new Error('no desktop in tests'))),
  useDesktopSession: vi.fn(() => ({ session: null, models: null, loading: false, error: null })),
  fetchModelStatus: vi.fn(() => Promise.reject(new Error('no desktop in tests'))),
  modelsAbsentForRealEngine: vi.fn(() => gateState.modelsAbsent),
}));
vi.mock('../../lib/export/conversation-export', () => ({
  downloadConversation: vi.fn(),
}));

import { ChatPage } from '../ChatPage';
import * as inferenceModule from '../../lib/inference';
import * as themeModule from '../../lib/theme';
import type { ChatMessage } from '../../types/chat';

function mockContext(mode: string): void {
  vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
    mode,
    browserEngine: 'wllama',
    ragPreset: 'balanced',
    isServerConnected: false,
    isModelReady: false,
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

function renderChat(overrides: {
  messages?: ChatMessage[];
}): void {
  // ChatPage is a CONTROLLED component: message updates flow through
  // onMessagesChange. A vi.fn() stub would silently discard every streamed
  // token, error card, and user turn — hold real state here.
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

async function send(text: string): Promise<void> {
  const input = screen.getByLabelText('Message input');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form') ?? input);
  await waitFor(() => {
    const send = screen.getByRole('button', { name: /send/i });
    expect(send).not.toBeDisabled();
  });
}

describe('ChatPage provider mode (direct generation, AC1 runtime half)', () => {
  let server: http.Server;
  let port: number;
  let requests: RecordedRequest[];

  beforeEach(async () => {
    localStorage.clear();
    mockContext('provider');
    const started = await startMockOpenAI();
    server = started.server;
    port = started.port;
    requests = started.requests;
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({
        mode: 'provider',
        serverUrl: '',
        browserEngine: 'wllama',
        ragPreset: 'balanced',
        providerConfig: { baseUrl: `http://127.0.0.1:${port}`, model: 'local-model' },
      })
    );
  });

  afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('a send POSTs the OpenAI body with threaded history and streams the reply', async () => {
    // The current user turn is NOT pre-added — handleSend appends it. Prior
    // turns only, so the snapshot is exactly [prior user, prior assistant].
    const prior = [msg('user', 'What is a retriever?'), msg('assistant', 'A retrieval component.')];
    renderChat({ messages: prior });
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'and the ranker?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 10_000 });
    const req = requests[0];
    expect(req.url).toBe('/v1/chat/completions');
    expect(req.body.model).toBe('local-model');
    expect(req.body.stream).toBe(true);
    // Multi-turn: the bounded prior exchange precedes the current question.
    expect(req.body.messages).toEqual([
      { role: 'user', content: 'What is a retriever?' },
      { role: 'assistant', content: 'A retrieval component.' },
      { role: 'user', content: 'and the ranker?' },
    ]);
    // Streamed deltas land in the message list.
    await waitFor(() => expect(screen.getByText('Hi there')).toBeInTheDocument(), {
      timeout: 10_000,
    });
  });

  test('an unconfigured provider surfaces the actionable error without a request', async () => {
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({ mode: 'provider', serverUrl: '', providerConfig: { baseUrl: '', model: '' } })
    );
    renderChat({});
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(
      () => expect(screen.getByText(/Provider server is not configured/i)).toBeInTheDocument(),
      { timeout: 10_000 }
    );
    expect(requests.length).toBe(0);
  });

  test('an unreachable server surfaces the failure in the message list', async () => {
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({
        mode: 'provider',
        serverUrl: '',
        providerConfig: { baseUrl: 'http://127.0.0.1:1', model: 'm' },
      })
    );
    renderChat({});
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(
      () =>
        expect(
          screen.getByText(/Cannot reach the provider server/i)
        ).toBeInTheDocument(),
      { timeout: 15_000 }
    );
  });
});

describe('provider mode + reviewer-round-1 fixes', () => {
  let server: http.Server;
  let port: number;
  let requests: RecordedRequest[];

  beforeEach(async () => {
    localStorage.clear();
    mockContext('provider');
    gateState.modelsAbsent = false;
    const started = await startMockOpenAI();
    server = started.server;
    port = started.port;
    requests = started.requests;
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({
        mode: 'provider',
        serverUrl: '',
        providerConfig: { baseUrl: `http://127.0.0.1:${port}`, model: 'local-model' },
      })
    );
  });

  afterEach(async () => {
    cleanup();
    gateState.modelsAbsent = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('provider chat still sends when the B9 model gate reports models absent', async () => {
    gateState.modelsAbsent = true;
    renderChat({ messages: [] });
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'provider send' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(requests[0].url).toBe('/v1/chat/completions');
  });

  test('history content is truncated to the api-parity 4000-char per-turn bound', async () => {
    const longTurn = 'x'.repeat(5000);
    const prior = [msg('user', longTurn), msg('assistant', 'ok')];
    renderChat({ messages: prior });
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'summarize' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 10_000 });
    const wireMessages = requests[0].body.messages ?? [];
    expect(wireMessages.length).toBe(3);
    expect(wireMessages[0].content.length).toBe(4000);
    expect(wireMessages[2].content).toBe('summarize');
  });
});
