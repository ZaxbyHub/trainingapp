// desktop-first-byte-budget.test.ts — issue #351 (AC4, renderer watchdog leg):
// the desktop chat first-byte budget must be max(600000, configured
// external.firstByteTimeoutMs) — a raised backend limit must not be clipped at
// the renderer (web_ui/src/lib/api/streaming.ts DESKTOP_FIRST_BYTE_TIMEOUT_MS).
//
// FROZEN ACCEPTANCE SURFACE (trace 350-351-packaged-gpu-fuse-external-timeouts,
// check C4's watchdog leg; revision 3 after plan critic r2 — the r2 probe showed
// the source-sweep passed while the constructor still received the bare 600000
// (comma-operator cheat), so the wiring is now BEHAVIOURAL: the real ChatPage is
// rendered against a desktop session whose apiClient.getSettings answers the
// dotted keys, a send fires, and the OBSERVED TokenStreamManager constructor
// argument is asserted — configured, default, failed-read, and browser lanes).
//
// Plan-pinned wiring this exercises (05-fix-plan, REVISED — CHECK_WRONG
// amendment, revision 4): F-012's one-GET-/settings-per-send pin (an existing
// repo guard in chat-provider-branch.test.tsx) conflicts with the draft's
// mount-time settings read (count becomes 2), and F-012 is authoritative — a
// pre-existing guard is never weakened. The wiring is now: ChatPage keeps
// external timeout state + a syncExternalFirstByteTimeout sink; the send flow
// hands the ONE settings response to the sink AND
// TokenStreamManager.setFirstByteTimeoutMs(desktopFirstByteBudgetMs(value)) —
// the CURRENT send uses the fresh budget because the timer arms later, at
// startSSEStream. runGeneration still constructs
// `new TokenStreamManager(desktopFirstByteBudgetMs(externalFirstByteTimeoutMs))`
// (last-known state; first-ever send constructs at the 600000 floor), and the
// browser default stays on the browser branch; a failed or key-less read
// leaves the state undefined => the 600000 floor. The behavioural rows observe
// the EFFECTIVE budget (setter call, else constructor argument).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import type { ChatMessage } from '../../../types/chat';
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  DESKTOP_FIRST_BYTE_TIMEOUT_MS,
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  desktopFirstByteBudgetMs,
} from '../../api/streaming';

// ---------- pure resolver rows (unchanged behavior contract) ----------
describe('#351 renderer desktop first-byte budget resolver', () => {
  test('the resolver is exported from lib/api/streaming', () => {
    expect(typeof desktopFirstByteBudgetMs).toBe('function');
  });

  test('a configured 900000 is NOT clipped by the hardcoded 600000', () => {
    expect(desktopFirstByteBudgetMs(900_000)).toBe(900_000);
    expect(desktopFirstByteBudgetMs(1_200_000)).toBe(1_200_000);
    expect(desktopFirstByteBudgetMs(DESKTOP_FIRST_BYTE_TIMEOUT_MS + 1)).toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS + 1);
  });

  test('values at or below the floor, and absent/garbage input, keep the 600000 default', () => {
    expect(desktopFirstByteBudgetMs(500_000)).toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS);
    expect(desktopFirstByteBudgetMs(600_000)).toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS);
    expect(desktopFirstByteBudgetMs()).toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS);
    expect(desktopFirstByteBudgetMs(undefined)).toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS);
    expect(desktopFirstByteBudgetMs(Number.NaN)).toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS);
    expect(desktopFirstByteBudgetMs(0)).toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS);
  });
});

// ---------- behavioural wiring rows (critic r2: source sweeps are cheatable) ----------
// Review finding tests-falsifiability-004 (critic-UPHELD MEDIUM): the mock
// previously recorded only the constructor argument and the setter calls while
// a Proxy turned startSSEStream into a no-op — so the load-bearing ORDERING
// invariant (the fresh budget must be applied BEFORE the timer arms at
// startSSEStream) was unobservable, and moving the setter after the stream
// start would have kept every row GREEN while production silently reverted to
// the #351 first-send clip. `events` now records the ordered lifecycle.
const captures = vi.hoisted(() => ({
  budgets: [] as Array<number | undefined>,
  setterCalls: [] as number[],
  events: [] as Array<[string, number | undefined]>,
}));

vi.mock('../../streaming', () => {
  class TokenStreamManager {
    firstByteMs?: number;
    constructor(firstByteMs?: number) {
      this.firstByteMs = firstByteMs;
      captures.budgets.push(firstByteMs);
      captures.events.push(['construct', firstByteMs]);
    }
    setFirstByteTimeoutMs(ms: number): void {
      this.firstByteMs = ms;
      captures.setterCalls.push(ms);
      captures.events.push(['set', ms]);
    }
    startSSEStream(): void {
      // The timer arms here in production (SSEStreamConsumer construction), so
      // the budget IN EFFECT at this point is the observable that pins the
      // ordering invariant.
      captures.events.push(['start', this.firstByteMs]);
    }
  }
  return {
    TokenStreamManager: new Proxy(TokenStreamManager, {
      construct(target, args) {
        const inst = new (target as new (...a: unknown[]) => object)(...args);
        return new Proxy(inst as Record<string | symbol, unknown>, {
          get: (t, p) => (p in t ? t[p] : (..._a: unknown[]) => undefined),
        });
      },
    }),
  };
});

// Boundary mocks (page-component import pulls native ESM at collection time —
// mirror of chat-provider-branch.test.tsx's block).
vi.mock('../../inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));
vi.mock('../../theme', () => ({ useTheme: vi.fn() }));
vi.mock('../../rag/rag-orchestrator', () => ({
  // Browser-lane send driver: a query generator lets runGeneration construct
  // the TokenStreamManager without the readiness gate (chat-provider-branch
  // pattern); the budget capture is the observable.
  RAGOrchestrator: vi.fn(function (this: unknown) {
    return {
      query: async function* () {
        yield { type: 'token', data: 'ok' };
        yield { type: 'complete', data: { answer: 'ok', sources: [], chunks: [], grounding: 'general', learn: [] } };
      },
    };
  }),
}));
vi.mock('../../llm/llm-factory', () => ({
  getLLMService: vi.fn(),
  disposeBrowserEngine: vi.fn(),
}));
vi.mock('../../llm/web-llm-service', () => ({ WEBLLM_DEFAULT_MODEL_ID: 'test-webllm-model' }));
vi.mock('../../llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn(() => Promise.resolve()),
  getReadinessResultSnapshot: vi.fn(() => null),
  resetReadinessCache: vi.fn(),
}));
vi.mock('../../models/model-manifest', () => ({ LLM_MODEL_DIR: 'lfm2-1.2b-rag' }));
vi.mock('../../desktop-session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../desktop-session')>();
  return {
    ...real,
    isElectron: vi.fn(() => false),
    initDesktopSession: vi.fn(() => Promise.reject(new Error('no desktop in tests'))),
    useDesktopSession: vi.fn(() => ({ session: null, models: null, loading: false, error: null })),
    fetchModelStatus: vi.fn(() => Promise.reject(new Error('no desktop in tests'))),
    modelsAbsentForRealEngine: real.modelsAbsentForRealEngine,
  };
});
vi.mock('../../export/conversation-export', () => ({ downloadConversation: vi.fn() }));

import { ChatPage } from '../../../pages/ChatPage';
import * as inferenceModule from '../../inference';
import * as themeModule from '../../theme';
import * as desktopSessionModule from '../../desktop-session';

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

// createElement (not JSX): this file is a .ts module — esbuild rejects JSX
// syntax here, and the frozen path stays .ts (CHECK_WRONG-stable).
function renderChat(): void {
  function Harness(): React.ReactElement {
    const [messages, setMessages] = React.useState<ChatMessage[]>([]);
    return React.createElement(
      ChatPage,
      {
        messages,
        onMessagesChange: setMessages,
        onSaveConversation: vi.fn(),
        currentConversationId: undefined,
        setCurrentConversationId: vi.fn(),
        onNewChat: vi.fn(),
        onOpenSettings: vi.fn(),
      },
    );
  }
  render(React.createElement(Harness));
}

async function sendOnce(): Promise<void> {
  // Settle pending effects before the send (revision 4: the budget no longer
  // depends on a mount-time read; the send flow itself applies the fresh
  // budget through the setter before the timer arms at startSSEStream).
  await act(async () => {});
  const input = screen.getByLabelText('Message input');
  fireEvent.change(input, { target: { value: 'budget probe question' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await waitFor(() => expect(captures.budgets.length).toBeGreaterThan(0), { timeout: 10_000 });
}

function desktopSessionWith(getSettings: ReturnType<typeof vi.fn>): void {
  vi.mocked(desktopSessionModule.isElectron).mockReturnValue(true);
  vi.mocked(desktopSessionModule.useDesktopSession).mockReturnValue({
    session: {
      baseUrl: 'http://127.0.0.1:4567',
      token: 't',
      mode: 'node',
      apiClient: { getSettings } as never,
      sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
    } as never,
    models: {
      engine: 'external',
      profile: 'auto',
      models: { quality: { present: false }, fast: { present: false } },
      resident: { state: 'idle', profile: null, loadStartedAt: null },
    } as never,
    loading: false,
    error: null,
  } as never);
}

describe('#351 ChatPage uses the budget resolver at the desktop construction site (behavioural)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    captures.budgets.length = 0;
    captures.setterCalls.length = 0;
    captures.events.length = 0;
    mockContext('api');
    // The SSE transport: never resolves (the manager is constructed BEFORE the
    // stream; the budget is observable at construction time regardless).
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(desktopSessionModule.useDesktopSession).mockReturnValue({
      session: null, models: null, loading: false, error: null,
    } as never);
    vi.mocked(desktopSessionModule.isElectron).mockReturnValue(false);
  });

  test('desktop lane with configured 900000: the manager receives 900000 (not clipped)', async () => {
    desktopSessionWith(vi.fn(async () => ({
      'external.enabled': true,
      'external.protocol': 'openai',
      'external.baseUrl': 'http://127.0.0.1:9',
      'external.model': 'm1',
      'external.firstByteTimeoutMs': 900_000,
      'external.idleTimeoutMs': 130_000,
    })));
    renderChat();
    await waitFor(() => expect(desktopSessionModule.useDesktopSession).toHaveBeenCalled());
    await sendOnce();
    expect(
      captures.setterCalls[0] ?? captures.budgets[0],
      'the configured first-byte timeout must reach the CURRENT send (effective budget = setter, else constructor)',
    ).toBe(900_000);
  });

  test('desktop lane without configured timeouts: the 600000 default is kept', async () => {
    desktopSessionWith(vi.fn(async () => ({
      'external.enabled': true,
      'external.protocol': 'openai',
      'external.baseUrl': 'http://127.0.0.1:9',
      'external.model': 'm1',
    })));
    renderChat();
    await sendOnce();
    expect(
      captures.setterCalls[0] ?? captures.budgets[0],
      'a key-less read still applies the floor through the setter',
    ).toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS);
  });

  test('desktop lane with a FAILED settings read: the 600000 floor, never 0/undefined', async () => {
    desktopSessionWith(vi.fn(async () => { throw new Error('settings unavailable'); }));
    renderChat();
    await sendOnce();
    expect(captures.setterCalls, 'a failed read never reaches the setter').toHaveLength(0);
    expect(captures.budgets[0]).toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS);
  });

  test('a stopped send publishes NOTHING from its late settings response, so a later failed read keeps the floor (Phase-4.5 F-1)', async () => {
    // Per-call settings: send A's read stays PENDING until we resolve it late
    // (after A has been stopped and superseded); send B's read fails. The
    // identity-gated sink must publish nothing for A, so B constructs at the
    // floor and keeps it (no setter call ever carries the stale 900000).
    let resolveA!: (value: unknown) => void;
    const getSettings = vi.fn()
      .mockImplementationOnce(() => new Promise<unknown>((res) => { resolveA = res; }))
      .mockImplementationOnce(async () => { throw new Error('settings unavailable'); });
    desktopSessionWith(getSettings);
    renderChat();
    await act(async () => {});
    const input = screen.getByLabelText('Message input');
    const send = screen.getByRole('button', { name: /send/i });
    // Send A; runGeneration reaches the pending settings await.
    fireEvent.change(input, { target: { value: 'first question' } });
    fireEvent.click(send);
    await act(async () => {});
    expect(captures.budgets.length, 'send A constructed its manager').toBe(1);
    // Stop A (terminalize nulls tokenStreamManagerRef).
    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
    await act(async () => {});
    // A's late settings answer: the gated sink must publish NOTHING.
    resolveA({
      'external.enabled': true,
      'external.protocol': 'openai',
      'external.baseUrl': 'http://127.0.0.1:9',
      'external.model': 'm1',
      'external.firstByteTimeoutMs': 900_000,
    });
    await act(async () => {});
    expect(captures.setterCalls, 'the stopped send must not publish its settings').toHaveLength(0);
    // Send B: read fails; B must construct at (and keep) the floor.
    fireEvent.change(input, { target: { value: 'second question' } });
    fireEvent.click(send);
    await waitFor(() => expect(captures.budgets.length).toBe(2), { timeout: 10_000 });
    await act(async () => {});
    expect(captures.setterCalls, 'no stale 900000 ever reached the setter').toHaveLength(0);
    expect(captures.budgets[1], 'the later failed read keeps the floor').toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS);
  });

  test('a prior SUCCESSFUL raised read carries into a later FAILED read (last-known contract, Phase-4.5 r2 F-1)', async () => {
    desktopSessionWith(vi.fn()
      .mockImplementationOnce(async () => ({
        'external.enabled': true,
        'external.protocol': 'openai',
        'external.baseUrl': 'http://127.0.0.1:9',
        'external.model': 'm1',
        'external.firstByteTimeoutMs': 900_000,
      }))
      .mockImplementationOnce(async () => { throw new Error('settings unavailable'); }));
    renderChat();
    await act(async () => {});
    const input = screen.getByLabelText('Message input');
    const send = screen.getByRole('button', { name: /send/i });
    fireEvent.change(input, { target: { value: 'first question' } });
    fireEvent.click(send);
    await waitFor(() => expect(captures.setterCalls.length).toBe(1), { timeout: 10_000 });
    expect(captures.setterCalls[0], 'send 1 applies the raised budget').toBe(900_000);
    // The mocked stream never completes, so send 1 stays busy: stop it before
    // send 2 (a stop does not touch the budget state, which is the point).
    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
    await act(async () => {});
    fireEvent.change(input, { target: { value: 'second question' } });
    fireEvent.click(send);
    await waitFor(() => expect(captures.budgets.length).toBe(2), { timeout: 10_000 });
    await act(async () => {});
    // A REJECTED read never reaches the sink (onSettings fires on resolution
    // only): the last-known budget reaches send 2 through the CONSTRUCTION
    // path (state from send 1), so no further setter call happens.
    expect(captures.setterCalls, 'no further setter call on a rejected read').toHaveLength(1);
    expect(captures.budgets[1], 'send 2 constructs at the LAST SUCCESSFUL reading, not the floor').toBe(900_000);
  });

  test('a KEY-LESS response after a raised success keeps the last-known budget (Phase-4.5 r3 F-1)', async () => {
    desktopSessionWith(vi.fn()
      .mockImplementationOnce(async () => ({
        'external.enabled': true,
        'external.protocol': 'openai',
        'external.baseUrl': 'http://127.0.0.1:9',
        'external.model': 'm1',
        'external.firstByteTimeoutMs': 900_000,
      }))
      .mockImplementationOnce(async () => ({ 'external.enabled': true })));
    renderChat();
    await act(async () => {});
    const input = screen.getByLabelText('Message input');
    const send = screen.getByRole('button', { name: /send/i });
    fireEvent.change(input, { target: { value: 'first question' } });
    fireEvent.click(send);
    await waitFor(() => expect(captures.setterCalls.length).toBe(1), { timeout: 10_000 });
    expect(captures.setterCalls[0]).toBe(900_000);
    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
    await act(async () => {});
    fireEvent.change(input, { target: { value: 'second question' } });
    fireEvent.click(send);
    await waitFor(() => expect(captures.budgets.length).toBe(2), { timeout: 10_000 });
    await act(async () => {});
    expect(captures.setterCalls[1], 'the key-less read applies the LAST-KNOWN budget, never a reset to the floor').toBe(900_000);
    expect(captures.budgets[1]).toBe(900_000);
  });

  test('an OUT-OF-RANGE integer response after a raised success keeps the last-known budget (Phase-4.5 r4 F-1)', async () => {
    desktopSessionWith(vi.fn()
      .mockImplementationOnce(async () => ({
        'external.enabled': true,
        'external.protocol': 'openai',
        'external.baseUrl': 'http://127.0.0.1:9',
        'external.model': 'm1',
        'external.firstByteTimeoutMs': 900_000,
      }))
      .mockImplementationOnce(async () => ({ 'external.enabled': true, 'external.firstByteTimeoutMs': 999 })));
    renderChat();
    await act(async () => {});
    const input = screen.getByLabelText('Message input');
    const send = screen.getByRole('button', { name: /send/i });
    fireEvent.change(input, { target: { value: 'first question' } });
    fireEvent.click(send);
    await waitFor(() => expect(captures.setterCalls.length).toBe(1), { timeout: 10_000 });
    expect(captures.setterCalls[0]).toBe(900_000);
    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
    await act(async () => {});
    fireEvent.change(input, { target: { value: 'second question' } });
    fireEvent.click(send);
    await waitFor(() => expect(captures.budgets.length).toBe(2), { timeout: 10_000 });
    await act(async () => {});
    expect(captures.setterCalls[1], 'an out-of-range response applies the LAST-KNOWN budget, never 999').toBe(900_000);
    expect(captures.budgets[1]).toBe(900_000);
  });

  test('the fresh budget is applied BEFORE the timer arms at startSSEStream (ordering invariant, review tests-falsifiability-004)', async () => {
    // The load-bearing invariant of the whole #351 renderer leg: the setter
    // must run before startSSEStream builds the SSEStreamConsumer (which reads
    // the budget). A setter moved after the stream start leaves the stale
    // constructor budget armed and re-creates the first-send clip — and until
    // this row existed, no test could see that.
    desktopSessionWith(vi.fn(async () => ({
      'external.enabled': true,
      'external.protocol': 'openai',
      'external.baseUrl': 'http://127.0.0.1:9',
      'external.model': 'm1',
      'external.firstByteTimeoutMs': 900_000,
    })));
    renderChat();
    await sendOnce();
    await waitFor(() => expect(captures.events.some(([kind]) => kind === 'start')).toBe(true), { timeout: 10_000 });
    const kinds = captures.events.map(([kind]) => kind);
    expect(kinds, `the setter must run before the stream starts (events: ${JSON.stringify(captures.events)})`).toContain('set');
    expect(kinds.indexOf('set'), 'set must precede start').toBeLessThan(kinds.indexOf('start'));
    const start = captures.events.find(([kind]) => kind === 'start');
    expect(start?.[1], 'the budget IN EFFECT when the timer arms must be the configured 900000').toBe(900_000);
  });

  test('a raised reading does NOT outlive the external endpoint: once external is off, the local watchdog returns to 600000 (review reliability-performance-001)', async () => {
    // The external first-byte setting describes the external endpoint's
    // transport; responseFields() reports it even when external.enabled is
    // false, so an ungated read let an endpoint knob govern the local-model
    // watchdog for up to ~24.8 days. Both the construction path and the sink
    // must now return to the 600000 ceiling.
    desktopSessionWith(vi.fn()
      .mockImplementationOnce(async () => ({
        'external.enabled': true,
        'external.protocol': 'openai',
        'external.baseUrl': 'http://127.0.0.1:9',
        'external.model': 'm1',
        'external.firstByteTimeoutMs': 900_000,
      }))
      .mockImplementationOnce(async () => ({
        'external.enabled': false,
        'external.protocol': 'openai',
        'external.baseUrl': 'http://127.0.0.1:9',
        'external.model': 'm1',
        'external.firstByteTimeoutMs': 900_000,
      })));
    renderChat();
    await act(async () => {});
    const input = screen.getByLabelText('Message input');
    const send = screen.getByRole('button', { name: /send/i });
    fireEvent.change(input, { target: { value: 'first question' } });
    fireEvent.click(send);
    await waitFor(() => expect(captures.setterCalls.length).toBe(1), { timeout: 10_000 });
    expect(captures.setterCalls[0], 'send 1 (external active) raises the budget').toBe(900_000);
    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
    await act(async () => {});
    fireEvent.change(input, { target: { value: 'second question' } });
    fireEvent.click(send);
    await waitFor(() => expect(captures.budgets.length).toBe(2), { timeout: 10_000 });
    await act(async () => {});
    expect(captures.setterCalls[1], 'send 2 (external off) must not raise the local watchdog').toBe(DESKTOP_FIRST_BYTE_TIMEOUT_MS);
    // The EFFECTIVE budget is the setter's (it applies before startSSEStream
    // arms the timer). The construction path is engine-gated — the loaded
    // models still report 'external' until the next status fetch — so a
    // transient constructor value is corrected by the sink above; a failed
    // read never reaches the sink and keeps the last-known value, which is
    // the pre-existing Phase-4.5 contract.
    expect(captures.setterCalls.length, 'send 2 reached the sink').toBe(2);
  });

  test('browser lane: the 30s browser default stays untouched (RAGOrchestrator-driven send)', async () => {
    vi.mocked(desktopSessionModule.isElectron).mockReturnValue(false);
    mockContext('browser-local');
    localStorage.setItem(
      'external-provider-config',
      JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'm', grounded: true, rememberKey: false }),
    );
    renderChat();
    await act(async () => {});
    await sendOnce();
    expect(captures.budgets[0], 'the browser lane keeps the 30s default (never the desktop budget)').toBe(DEFAULT_FIRST_BYTE_TIMEOUT_MS);
  });

  test('the resolver result is the constructor argument (no discarded-helper cheat)', () => {
    // Structural anti-cheat paired with the behavioural rows above: the desktop
    // branch expression must pass desktopFirstByteBudgetMs(...) DIRECTLY as the
    // sole desktop-arm argument (balanced-paren extraction; the comma-operator
    // cheat — helper called then value discarded — fails the DIRECT-argument
    // test: the argument token sequence must START with the call). The arm is
    // extracted with depth tracking so a nested ternary INSIDE the resolver
    // call (review reliability-performance-001: the engine gate) cannot break
    // the scan the way a naive split('?')/split(':') did.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'pages', 'ChatPage.tsx'),
      'utf8',
    );
    const at = src.indexOf('new TokenStreamManager(');
    expect(at, 'the construction site exists').toBeGreaterThanOrEqual(0);
    let depth = 0;
    let end = -1;
    for (let i = at + 'new '.length; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const call = src.slice(at + 'new TokenStreamManager('.length, end).trim();
    // Top-level '?' of the constructor's ternary, then its matching ':'.
    const topLevel = (from: number, targets: string[]): number => {
      let d = 0;
      for (let i = from; i < call.length; i++) {
        const ch = call[i];
        if (ch === '(' || ch === '[' || ch === '{') d++;
        else if (ch === ')' || ch === ']' || ch === '}') d--;
        else if (d === 0 && targets.includes(ch)) return i;
      }
      return -1;
    };
    const q = topLevel(0, ['?']);
    expect(q, 'the constructor call carries a desktop/browser ternary').toBeGreaterThanOrEqual(0);
    const colon = topLevel(q + 1, [':']);
    expect(colon, 'the ternary has a browser arm').toBeGreaterThan(q);
    const desktopArm = call.slice(q + 1, colon).trim();
    expect(desktopArm.startsWith('desktopFirstByteBudgetMs('), `desktop arm must BE the resolver call, got: ${desktopArm}`).toBe(true);
    expect(desktopArm, 'the resolver must receive the external first-byte timeout value (CHECK_WRONG: /i — the ChatPage state identifier capitalizes First)').toMatch(/firstByteTimeoutMs/i);
    expect(call, 'no bare desktop constant inside the constructor call').not.toMatch(/DESKTOP_FIRST_BYTE_TIMEOUT_MS/);
  });
});
