/**
 * F-AC7 coverage: the model-blocked overlay (ChatPage.tsx ~lines 534-682,
 * the `isModelBlocked` conditional render with `role="alertdialog"`) has
 * ZERO test coverage across the other ChatPage*.test.tsx files as of PR #28
 * review — none of them mock `../lib/llm/readiness-gate`, so the overlay
 * (when it happens to render at all in those files) only ever shows the
 * generic "Preparing the model…" fallback, never the engine-aware failure
 * headline, the real failures/recommendations lists, or the Retry/Open
 * Settings button wiring. Issue #21 AC7 requires this overlay to be tested.
 *
 * This file mocks `useInferenceMode` to force `isModelReady: false` (which
 * drives `isModelBlocked` in browser-local mode) and mocks
 * `../lib/llm/readiness-gate` so `getReadinessResultSnapshot()` returns a
 * controllable failures/recommendations payload, matching the actual data
 * flow ChatPage.tsx reads from.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell, DRAWER_MEDIA_QUERY, SideNav } from '../ui';
import { ChatPage } from './ChatPage';
import type { ReadinessResult } from '../lib/llm/model-readiness';
import { READINESS_IN_FLIGHT_EVENT } from '../lib/llm/readiness-events';
import type { BrowserEngine } from '../types/llm';

// Mutable per-test state read by the mocked modules below. Reassigned in
// each test (not just `beforeEach`) so individual tests can vary engine /
// readiness content without redeclaring the mocks.
interface InferenceState {
  mode: 'browser-local';
  browserEngine: BrowserEngine;
  ragPreset: string;
  isModelReady: boolean;
  isServerConnected: boolean;
  modelLoadingProgress: number;
  serverUrl: string;
  modeError: string | null;
}
let inferenceState: InferenceState = {
  mode: 'browser-local',
  browserEngine: 'wllama',
  ragPreset: 'balanced',
  isModelReady: false,
  isServerConnected: true,
  modelLoadingProgress: 0,
  serverUrl: '',
  modeError: null,
};
let currentReadinessResult: ReadinessResult | null = null;

const mockResetReadinessCache = vi.fn();
const mockEnsureReadinessGateChecked = vi.fn(async (_engine?: BrowserEngine) => null);

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => ({
    ...inferenceState,
    setModelLoadingProgress: vi.fn(),
    setMode: vi.fn(),
    setBrowserEngine: vi.fn(),
    setRagPreset: vi.fn(),
    setServerUrl: vi.fn(),
    checkServerConnectivity: vi.fn(),
    setModelReady: vi.fn(),
  }),
}));

vi.mock('../lib/llm/readiness-gate', () => ({
  getReadinessSnapshot: () => ({ modelCached: false, webgpuAvailable: false }),
  getReadinessResultSnapshot: () => currentReadinessResult,
  getReadinessGateInstance: () => null,
  applyReadinessFromEvent: vi.fn(),
  // Wrapped in a function (not assigned directly) so the reference to
  // mockResetReadinessCache/mockEnsureReadinessGateChecked is resolved lazily
  // at call time, not when this factory executes. `vi.mock` factories run as
  // soon as './ChatPage' is imported — which, per ESM evaluation order,
  // happens BEFORE this file's own top-level `const` declarations run — so a
  // direct property reference here would hit the TDZ (unlike the `callOrder`
  // pattern used elsewhere in this repo, which only reads the outer variable
  // from inside a further-nested closure invoked later, after the whole file
  // has finished loading).
  resetReadinessCache: () => mockResetReadinessCache(),
  ensureReadinessGateChecked: (engine?: BrowserEngine) => mockEnsureReadinessGateChecked(engine),
}));

// Not exercised while blocked, but ChatPage imports them unconditionally.
vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: () => ({
    initialize: vi.fn(async () => undefined),
    generate: async function* () { yield 'ok'; },
    generateComplete: async () => 'ok',
    isReady: () => false,
    getModelInfo: () => null,
    getInferenceMode: () => 'wasm' as const,
    supportsImages: () => false,
    interrupt: () => undefined,
  }),
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

function makeReadinessResult(overrides: Partial<ReadinessResult> = {}): ReadinessResult {
  return {
    ready: false,
    checks: {
      webgpu: false,
      modelCached: false,
      memory: { availableBytes: 1_000_000_000, requiredBytes: 2_000_000_000, sufficient: false, tier: 'LOW' },
    },
    failures: [],
    recommendations: [],
    ...overrides,
  };
}

function renderChatPage(onOpenSettings: () => void = () => {}) {
  return render(
    <ChatPage
      messages={[]}
      onMessagesChange={() => {}}
      onSaveConversation={() => {}}
      onNewChat={() => {}}
      currentConversationId={undefined}

      setCurrentConversationId={() => {}}

      onOpenSettings={onOpenSettings}
    />
  );
}

describe('ChatPage — model-blocked overlay (F-AC7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    inferenceState = {
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: false,
      isServerConnected: true,
      modelLoadingProgress: 0,
      serverUrl: '',
      modeError: null,
    };
    currentReadinessResult = null;
  });
  afterEach(() => cleanup());

  it('renders the alertdialog with the wllama-specific failure headline and the real failure/recommendation text', () => {
    currentReadinessResult = makeReadinessResult({
      failures: ['This build does not include the packaged model weights (gemma-4-e2b-it).'],
      recommendations: ['Rebuild the app with the model bundled, or contact your administrator.'],
    });

    renderChatPage();

    const dialog = screen.getByRole('alertdialog', { name: /model not ready/i });
    expect(dialog).toBeInTheDocument();

    // Engine-aware, non-generic headline for wllama.
    expect(
      screen.getByText('This build is missing the packaged model. See the Packaging guide or contact your administrator.')
    ).toBeInTheDocument();
    // Must NOT fall back to the generic "preparing" message when there's a real failure.
    expect(screen.queryByText('Preparing the model…')).not.toBeInTheDocument();

    // The actual failure/recommendation text is surfaced, not a generic message.
    expect(
      screen.getByText('This build does not include the packaged model weights (gemma-4-e2b-it).')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Rebuild the app with the model bundled, or contact your administrator.')
    ).toBeInTheDocument();
  });

  it('renders the webllm-specific failure headline when the engine is webllm', () => {
    inferenceState = { ...inferenceState, browserEngine: 'webllm' };
    currentReadinessResult = makeReadinessResult({
      failures: ['WebGPU is not available in this browser.'],
      recommendations: ['Use a WebGPU-capable browser, or switch to the wllama engine.'],
    });

    renderChatPage();

    expect(
      screen.getByText('The browser model is not available. Use Settings to download it, or switch engines.')
    ).toBeInTheDocument();
    expect(screen.getByText('WebGPU is not available in this browser.')).toBeInTheDocument();
  });

  it('shows the generic "Preparing the model…" headline and no failure/recommendation lists when there are no failures yet', () => {
    // No readiness result yet (still loading) — getReadinessResultSnapshot() returns null.
    currentReadinessResult = null;
    inferenceState = { ...inferenceState, modelLoadingProgress: 42 };

    renderChatPage();

    expect(screen.getByText('Preparing the model…')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    // No <ul> failure/recommendation lists should render when there are no failures.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('Retry button resets the readiness cache and re-triggers the gate check for the current engine', () => {
    currentReadinessResult = makeReadinessResult({
      failures: ['This build does not include the packaged model weights.'],
      recommendations: ['Rebuild the app with the model bundled.'],
    });

    renderChatPage();

    // ChatPage's own mount-time readiness effect also calls
    // ensureReadinessGateChecked once; clear that call so the assertions
    // below isolate the Retry button's own invocation.
    mockResetReadinessCache.mockClear();
    mockEnsureReadinessGateChecked.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(mockResetReadinessCache).toHaveBeenCalledTimes(1);
    expect(mockEnsureReadinessGateChecked).toHaveBeenCalledTimes(1);
    expect(mockEnsureReadinessGateChecked).toHaveBeenCalledWith('wllama');
  });

  it('PRR-151-015: Retry is single-flight: a second press while the re-check runs is ignored, Retry shows busy and keeps focus', async () => {
    currentReadinessResult = makeReadinessResult({ failures: ['No weights.'] });
    renderChatPage();
    mockResetReadinessCache.mockClear();
    mockEnsureReadinessGateChecked.mockClear();
    let finish!: (v: null) => void;
    mockEnsureReadinessGateChecked.mockImplementationOnce(() => new Promise<null>((r) => { finish = r; }));

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry); // double-click before the busy state renders
    expect(mockEnsureReadinessGateChecked).toHaveBeenCalledTimes(1);
    expect(mockResetReadinessCache).toHaveBeenCalledTimes(1);
    const busy = screen.getByRole('button', { name: 'Retry' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(busy);
    expect(mockEnsureReadinessGateChecked).toHaveBeenCalledTimes(1);

    await act(async () => { finish(null); });
    const idle = screen.getByRole('button', { name: 'Retry' });
    expect(idle).not.toHaveAttribute('aria-busy');
    fireEvent.click(idle);
    expect(mockEnsureReadinessGateChecked).toHaveBeenCalledTimes(2);
    expect(mockResetReadinessCache).toHaveBeenCalledTimes(2);
  });

  // PR #151 final review LOW-3: a reset + re-check from elsewhere (the WebGPU
  // watchdog, Settings) supersedes the Retry's check, which then settles early.
  // Retry must stay busy until the NEWEST check settles, as readiness-gate
  // announces through READINESS_IN_FLIGHT_EVENT.
  function announceInFlight(inFlight: boolean): void {
    window.dispatchEvent(new CustomEvent(READINESS_IN_FLIGHT_EVENT, { detail: { inFlight } }));
  }

  it('LOW-3: Retry stays busy when its check is superseded, until the newest check settles (either order)', async () => {
    currentReadinessResult = makeReadinessResult({ failures: ['No weights.'] });
    renderChatPage();
    mockEnsureReadinessGateChecked.mockClear();
    let finishRetry!: (v: null) => void;
    mockEnsureReadinessGateChecked.mockImplementationOnce(() => {
      announceInFlight(true); // the real module announces every check it starts
      return new Promise<null>((r) => { finishRetry = r; });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute('aria-busy', 'true');

    // The watchdog (or Settings) resets and starts a newer check: still in flight.
    act(() => announceInFlight(true));
    // The Retry's own (superseded) check settles first.
    await act(async () => { finishRetry(null); });
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockEnsureReadinessGateChecked).toHaveBeenCalledTimes(1); // still single-flight

    // The newest check settles: nothing is in flight any more.
    act(() => announceInFlight(false));
    expect(screen.getByRole('button', { name: 'Retry' })).not.toHaveAttribute('aria-busy');
  });

  it('LOW-3: a "not in flight" announcement BEFORE the own Retry check settles does not release busy early', async () => {
    currentReadinessResult = makeReadinessResult({ failures: ['No weights.'] });
    renderChatPage();
    mockEnsureReadinessGateChecked.mockClear();
    let finishRetry!: (v: null) => void;
    mockEnsureReadinessGateChecked.mockImplementationOnce(() => {
      announceInFlight(true);
      return new Promise<null>((r) => { finishRetry = r; });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // e.g. readiness-gate's own finally announces just before the Retry promise resolves
    act(() => announceInFlight(false));
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finishRetry(null); });
    expect(screen.getByRole('button', { name: 'Retry' })).not.toHaveAttribute('aria-busy');
  });

  it('Open Settings button invokes the onOpenSettings prop', () => {
    currentReadinessResult = makeReadinessResult({
      failures: ['This build does not include the packaged model weights.'],
      recommendations: ['Rebuild the app with the model bundled.'],
    });
    const onOpenSettings = vi.fn();

    renderChatPage(onOpenSettings);

    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('ChatPage — model gate scope (Lumen phase 7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    inferenceState = {
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: false,
      isServerConnected: true,
      modelLoadingProgress: 0,
      serverUrl: '',
      modeError: null,
    };
    currentReadinessResult = makeReadinessResult({ failures: ['No weights.'] });
  });
  afterEach(() => cleanup());

  it('makes the covered chat content inert while the gate is up (and only that content)', () => {
    const { container } = renderChatPage();
    const content = container.querySelector('.chat-page__content') as HTMLElement;
    expect(content).toHaveAttribute('inert');
    // Header, composer are inside the inert region; the gate dialog is not.
    // `hidden: true`: jsdom has no native inert, so the PRR-151-018 fallback has
    // taken the covered content out of the accessibility tree, as inert would.
    expect(content).toContainElement(screen.getByRole('heading', { name: 'Chat', hidden: true }));
    expect(screen.queryByRole('heading', { name: 'Chat' })).toBeNull();
    expect(content).toContainElement(screen.getByLabelText('Message input'));
    const dialog = screen.getByRole('alertdialog', { name: /model not ready/i });
    expect(content).not.toContainElement(dialog);
    expect(dialog.closest('[inert]')).toBeNull();
    // The page root itself is never inert (the gate lives inside it).
    expect(container.querySelector('.chat-page')).not.toHaveAttribute('inert');
  });

  it('lifts inert when the gate lifts (model becomes ready)', () => {
    const { container, rerender } = renderChatPage();
    expect(container.querySelector('.chat-page__content')).toHaveAttribute('inert');
    inferenceState = { ...inferenceState, isModelReady: true };
    rerender(
      <ChatPage
        messages={[]}
        onMessagesChange={() => {}}
        onSaveConversation={() => {}}
        onNewChat={() => {}}
        currentConversationId={undefined}
        setCurrentConversationId={() => {}}
        onOpenSettings={() => {}}
        onNavigateToDocuments={() => {}}
      />
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(container.querySelector('.chat-page__content')).not.toHaveAttribute('inert');
  });

  it('the gate is non-dismissible: Escape in the dialog leaves it up and the content inert', () => {
    const { container } = renderChatPage();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Retry' }), { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: /model not ready/i })).toBeInTheDocument();
    expect(container.querySelector('.chat-page__content')).toHaveAttribute('inert');
  });

  it('Ctrl+, still opens Settings while the gate is up (keyboard route out of the gate)', () => {
    const onOpenSettings = vi.fn();
    renderChatPage(onOpenSettings);
    expect(screen.getByRole('alertdialog', { name: /model not ready/i })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('the shell nav stays usable BY KEYBOARD (PRR-151-064): Shift+Tab from Retry reaches the AppShell nav, Tab never enters the covered content', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <AppShell
        productName="TrainingApp"
        collapsed={false}
        onToggleCollapsed={() => {}}
        sidebar={
          <SideNav
            label="Main navigation"
            items={[
              { id: 'chat', label: 'Chat', icon: 'message-square' },
              { id: 'documents', label: 'Documents', icon: 'file-text' },
            ]}
            activeId="chat"
            onNavigate={onNavigate}
          />
        }
      >
        <ChatPage
          messages={[]}
          onMessagesChange={() => {}}
          onSaveConversation={() => {}}
          onNewChat={() => {}}
          currentConversationId={undefined}
          setCurrentConversationId={() => {}}
          onOpenSettings={() => {}}
          onNavigateToDocuments={() => {}}
        />
      </AppShell>
    );
    const content = container.querySelector('.chat-page__content') as HTMLElement;
    const navDocuments = screen.getByRole('button', { name: 'Documents' });
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toHaveFocus();

    // Backwards out of the gate: the covered composer/header sit between the nav
    // and the gate in DOM order; they are skipped, so focus lands in the nav.
    await user.tab({ shift: true });
    expect(document.activeElement).not.toBe(document.body);
    expect(content.contains(document.activeElement)).toBe(false);
    expect(document.activeElement?.closest('nav')).not.toBeNull();
    // ...and the nav works from there.
    navDocuments.focus();
    await user.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenCalledWith('documents');

    // A full forward cycle (bound derived from the document, not a magic number)
    // visits the nav and the gate but never the covered content.
    const tabbable = container.querySelectorAll('button, input, textarea, select, a[href], [tabindex]').length;
    const visited = new Set<Element>();
    retry.focus();
    for (let i = 0; i < tabbable + 2; i++) {
      await user.tab();
      expect(content.contains(document.activeElement), `Tab #${i + 1}`).toBe(false);
      if (document.activeElement) visited.add(document.activeElement);
    }
    expect(visited.has(navDocuments)).toBe(true);
    expect(visited.has(retry)).toBe(true);
  });

  describe('with the AppShell nav drawer (inert on <main>)', () => {
    const original = window.matchMedia;
    afterEach(() => {
      window.matchMedia = original;
    });

    it('chat-content inert persists across drawer open and close; the drawer clears only <main>', async () => {
      window.matchMedia = ((query: string) => ({
        matches: query === DRAWER_MEDIA_QUERY,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
      const user = userEvent.setup();
      const { container } = render(
        <AppShell
          productName="TrainingApp"
          collapsed={false}
          onToggleCollapsed={() => {}}
          sidebar={
            <SideNav
              label="Main navigation"
              items={[
                { id: 'chat', label: 'Chat', icon: 'message-square' },
                { id: 'documents', label: 'Documents', icon: 'file-text' },
              ]}
              activeId="chat"
              onNavigate={() => {}}
            />
          }
        >
          <ChatPage
            messages={[]}
            onMessagesChange={() => {}}
            onSaveConversation={() => {}}
            onNewChat={() => {}}
            currentConversationId={undefined}
            setCurrentConversationId={() => {}}
            onOpenSettings={() => {}}
            onNavigateToDocuments={() => {}}
          />
        </AppShell>
      );
      const main = container.querySelector('main') as HTMLElement;
      const content = () => container.querySelector('.chat-page__content') as HTMLElement;
      expect(main).not.toHaveAttribute('inert');
      expect(content()).toHaveAttribute('inert');

      await user.click(screen.getByRole('button', { name: 'Open navigation' }));
      expect(main).toHaveAttribute('inert');
      expect(content()).toHaveAttribute('inert');

      const drawer = screen.getByRole('dialog', { name: 'Navigation' });
      await user.click(within(drawer).getByRole('button', { name: 'Close navigation' }));
      expect(main).not.toHaveAttribute('inert'); // AppShell cleared <main> ...
      expect(content()).toHaveAttribute('inert'); // ... but the gate's own inert persists
      expect(screen.getByRole('alertdialog', { name: /model not ready/i }).closest('[inert]')).toBeNull();
    });
  });
});
