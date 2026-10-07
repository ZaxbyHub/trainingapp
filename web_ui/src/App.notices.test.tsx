/**
 * Lumen phase 7: the App-level non-blocking notices (persistence error, degraded
 * search) are ui/Banner with Lumen tokens and no inline styles; dismiss/retry are
 * real buttons found by role.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import App from './App';

const state = vi.hoisted(() => ({
  // false = service init still pending (the boot overlay is up); reset to true before each test.
  isInitialized: true,
  initError: null as string | null,
  // Overrides the boot step text the init hook reports (null = derived from isInitialized).
  currentStep: null as string | null,
  persistenceError: null as string | null,
  clearPersistenceError: vi.fn(),
}));

vi.mock('./hooks/useConversations', () => ({
  useConversations: () => ({
    conversations: [],
    currentConversationId: undefined,
    currentMessages: [],
    setCurrentMessages: vi.fn(),
    setCurrentConversationId: vi.fn(),
    selectConversation: vi.fn(),
    newChat: vi.fn(),
    saveMessages: vi.fn(),
    removeConversation: vi.fn(),
    renameConversation: vi.fn(),
    hasMore: false,
    loadMore: vi.fn(),
    persistenceError: state.persistenceError,
    clearPersistenceError: state.clearPersistenceError,
    searchQuery: '',
    setSearchQuery: vi.fn(),
    searchResults: null,
    searchTruncated: false,
    isSearching: false,
  }),
}));
vi.mock('./hooks/useServiceInitialization', () => ({
  useServiceInitialization: () => ({
    isInitialized: state.isInitialized,
    initError: state.initError,
    currentStep: state.currentStep ?? (state.isInitialized ? 'Ready' : 'Initializing search services...'),
    servicesReady: { embeddings: true, vectorIndex: true, keywordIndex: true, modelCached: true, webgpuAvailable: false },
  }),
}));
vi.mock('./db/conversations', () => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(async () => undefined),
  createConversation: vi.fn(async () => undefined),
  updateConversation: vi.fn(async () => undefined),
  deleteConversation: vi.fn(async () => undefined),
  countConversations: vi.fn(async () => 0),
}));
vi.mock('./lib/inference/InferenceModeContext', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => ({
    mode: 'browser-local',
    browserEngine: 'wllama',
    ragPreset: 'balanced',
    isModelReady: true,
    isServerConnected: true,
    modelLoadingProgress: 100,
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

// --- ChatPage's LLM/RAG/streaming dependencies: same mocking convention as
// ChatPage.init.test.tsx, so real ChatPage renders and a real send actually
// produces a user + assistant message pair without pulling in the WASM/
// edgevec-backed RAG pipeline. ---
const fakeLlmService = {
  initialize: vi.fn(async () => undefined),
  generate: async function* () { yield 'ok'; },
  generateComplete: async () => 'ok',
  isReady: () => true,
  getModelInfo: () => null,
  getInferenceMode: () => 'wasm' as const,
  supportsImages: () => false,
  interrupt: () => undefined,
};

vi.mock('./lib/llm/llm-factory', () => ({
  getLLMService: () => fakeLlmService,
  disposeBrowserEngine: () => undefined,
  getPreferredBrowserEngine: () => 'wllama',
}));

vi.mock('./lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(() => ({
    query: async function* () {
      yield { type: 'complete', data: { answer: 'Assistant reply', sources: [], chunks: [] } };
    },
  })),
}));

vi.mock('./components/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
}));
vi.mock('./components/InferenceModeToggle', () => ({
  InferenceModeToggle: () => null,
}));
vi.mock('./lib/streaming', () => ({
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

// --- Documents/Settings pages: irrelevant to the AC2 regression under test
// (they have their own heavy IndexedDB/model-management dependencies) —
// replaced with trivial markers so navigation can be asserted without
// pulling those subsystems in. ---
vi.mock('./pages/DocumentsPage', () => ({
  DocumentsPage: () => <div data-testid="documents-page-marker">Documents Page</div>,
}));
vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page-marker">Settings Page</div>,
}));


beforeEach(() => {
  state.isInitialized = true;
  state.initError = null;
  state.currentStep = null;
  state.persistenceError = null;
  state.clearPersistenceError = vi.fn();
});
afterEach(() => {
  cleanup();
  // PRR-151-061: undo stubGlobal here so a failing assertion can never leak the
  // `location` stub into the next test.
  vi.unstubAllGlobals();
});

describe('App notices (Lumen phase 7)', () => {
  it('persistence error: a danger Banner (alert) with a Dismiss button that clears it', () => {
    state.persistenceError = 'Could not save the conversation';
    render(<App />);
    const alert = screen.getByText('Could not save the conversation').closest('.ui-banner') as HTMLElement;
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveClass('ui-banner--danger', 'app-notice');
    expect(alert.querySelectorAll('[style]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(state.clearPersistenceError).toHaveBeenCalledTimes(1);
  });

  it('degraded search: a polite status Banner with Retry (reload) and Dismiss', () => {
    state.initError = 'vector index failed';
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<App />);
    const banner = screen.getByText(/Search is degraded/).closest('.ui-banner') as HTMLElement;
    expect(banner).toHaveTextContent('vector index failed');
    expect(banner).toHaveClass('ui-banner--warning');
    // Announced by the enclosing polite status region, not as a second alert.
    expect(banner).not.toHaveAttribute('role');
    const status = banner.parentElement as HTMLElement;
    expect(status).toHaveAttribute('role', 'status');
    expect(status.querySelectorAll('[style]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss degraded-search notice' }));
    expect(screen.queryByText(/Search is degraded/)).toBeNull();
  });

  it('PRR-151-011: a dismissed degraded-search notice re-arms on a NEW distinct failure, not on the same one', () => {
    state.initError = 'vector index failed';
    const { rerender } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss degraded-search notice' }));
    expect(screen.queryByText(/Search is degraded/)).toBeNull();
    // Same error again: stays dismissed.
    rerender(<App />);
    expect(screen.queryByText(/Search is degraded/)).toBeNull();
    // The hook appends later failures to the same string: a distinct failure re-arms.
    state.initError = 'vector index failed; keyword index failed';
    rerender(<App />);
    expect(screen.getByText(/Search is degraded/)).toHaveTextContent('keyword index failed');
  });

  it('PRR-151-012: the degraded-search polite region is mounted before the notice and its text changes in place', () => {
    const { rerender } = render(<App />);
    const before = Array.from(document.querySelectorAll('[role="status"]'));
    state.initError = 'vector index failed';
    rerender(<App />);
    const banner = screen.getByText(/Search is degraded/).closest('.ui-banner') as HTMLElement;
    // The notice sits in a region element that already existed (inserted-with-content would be a new node).
    expect(before).toContain(banner.parentElement);
  });

  it('renders neither notice when there is no error', () => {
    render(<App />);
    expect(screen.queryByText(/Search is degraded/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss error' })).toBeNull();
  });
});

// Upfront unsupported-browser notice. The REAL browser-compat classifier runs (no mock):
// only navigator.userAgent / window.desktopApi are varied.
describe('App unsupported-browser notice', () => {
  const NOTICE = /This browser isn.t supported/;
  const UA = {
    safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    iosWebKit: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    fxios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121 Mobile/15E148 Safari/604.1',
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    oldFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:111.0) Gecko/20100101 Firefox/111.0',
    firefox112: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:112.0) Gecko/20100101 Firefox/112.0',
    oldChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
  };
  const setUa = (ua: string) =>
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });

  afterEach(() => {
    // Remove the own-property override so the prototype (jsdom) UA is back.
    delete (window.navigator as { userAgent?: string }).userAgent;
    delete (window as { desktopApi?: unknown }).desktopApi;
  });

  it.each([
    ['Safari', UA.safari],
    ['an iOS WebKit browser', UA.iosWebKit],
    ['Firefox on iOS (FxiOS)', UA.fxios],
    ['Chrome below 113', UA.oldChrome],
    ['Firefox 111', UA.oldFirefox],
  ])('%s: shows a dismissible warning Banner inside the always-mounted polite region', (_name, ua) => {
    setUa(ua);
    render(<App />);
    const banner = screen.getByText(NOTICE).closest('.ui-banner') as HTMLElement;
    expect(banner).toHaveTextContent('Use a current Chrome, Edge or Firefox.');
    expect(banner).toHaveClass('ui-banner--warning', 'app-notice');
    expect(banner).not.toHaveAttribute('role');
    expect(banner.parentElement).toHaveAttribute('role', 'status');
    expect(banner.parentElement?.querySelectorAll('[style]')).toHaveLength(0);
  });

  it.each([
    ['Chrome', UA.chrome],
    ['Edge', UA.edge],
    ['Firefox', UA.firefox],
    ['Firefox 112', UA.firefox112],
  ])('%s: no notice', (_name, ua) => {
    setUa(ua);
    render(<App />);
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss unsupported-browser notice' })).toBeNull();
  });

  it('Electron: no notice even when the UA would classify as unsupported', async () => {
    setUa(UA.safari);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ engine: 'stub', profile: 'auto', models: {} }), { status: 200 })),
    );
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      getBackendInfo: vi.fn(async () => ({ url: 'http://127.0.0.1:4567', mode: 'node' })),
      getAuthToken: vi.fn(async () => 'tok'),
      onFirstRunRequired: vi.fn(() => () => undefined),
      getFirstRunStatus: vi.fn(async () => ({ needed: false })),
    };
    render(<App />);
    // The boot gate resolves and the app shell mounts (so absence is not just "still booting").
    await screen.findByRole('main');
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('Dismiss hides the notice', () => {
    setUa(UA.safari);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss unsupported-browser notice' }));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  // PR #151 final review LOW-B: the notice is upfront, i.e. on the boot surface while service
  // init is still pending (or hung), not only after init completes.
  describe('while service init is still pending (LOW-B)', () => {
    beforeEach(() => {
      state.isInitialized = false;
    });

    it('shows the notice inside the boot dialog, the only visible surface', () => {
      setUa(UA.safari);
      render(<App />);
      const boot = screen.getByRole('dialog', { name: 'Starting TrainingApp' });
      const banner = screen.getByText(NOTICE).closest('.ui-banner') as HTMLElement;
      expect(boot).toContainElement(banner);
      expect(banner).toBeVisible();
      expect(banner).toHaveClass('ui-banner--warning');
      expect(banner).not.toHaveAttribute('role');
      expect(banner.parentElement).toHaveAttribute('role', 'status');
      expect(screen.getByRole('button', { name: 'Dismiss unsupported-browser notice' })).toBeInTheDocument();
    });

    it('the boot surface polite region is mounted empty and then filled (not inserted with its content)', () => {
      setUa(UA.safari);
      const observer = new MutationObserver(() => undefined);
      observer.observe(document.body, { childList: true, subtree: true });
      render(<App />);
      const banner = screen.getByText(NOTICE).closest('.ui-banner') as HTMLElement;
      const region = banner.parentElement as HTMLElement;
      const records = observer.takeRecords();
      observer.disconnect();
      expect(region).toHaveAttribute('role', 'status');
      // The banner was added INTO the already-inserted region element.
      expect(records.some((r) => r.target === region && Array.from(r.addedNodes).includes(banner))).toBe(true);
    });

    // critic-final-2 P1: "announced once" on the boot surface. A boot step change re-renders the
    // dialog; the notice's region must stay the SAME node (a re-keyed or re-created region is a new
    // live region inserted with its content, which re-announces the notice on every step).
    it('a boot step change keeps the notice region and banner as the same nodes (no re-announce)', () => {
      setUa(UA.safari);
      state.currentStep = 'Initializing search services...';
      const { rerender } = render(<App />);
      const boot = screen.getByRole('dialog', { name: 'Starting TrainingApp' });
      const banner = screen.getByText(NOTICE).closest('.ui-banner') as HTMLElement;
      const region = banner.parentElement as HTMLElement;
      expect(region).toHaveAttribute('role', 'status');
      expect(within(boot).getByText('Initializing search services...')).toBeInTheDocument();

      state.currentStep = 'Loading the language model...';
      rerender(<App />);
      // The step really changed (the dialog re-rendered with the new step)...
      expect(within(boot).getByText('Loading the language model...')).toBeInTheDocument();
      // ...and the notice region and its banner are the very same elements, still attached.
      const bannerAfter = screen.getByText(NOTICE).closest('.ui-banner') as HTMLElement;
      expect(bannerAfter).toBe(banner);
      expect(bannerAfter.parentElement).toBe(region);
      expect(region.isConnected).toBe(true);
    });

    it('a supported browser gets no extra DOM on the boot surface (the step text stays its only status region)', () => {
      setUa(UA.chrome);
      render(<App />);
      const boot = screen.getByRole('dialog', { name: 'Starting TrainingApp' });
      expect(within(boot).getAllByRole('status')).toHaveLength(1);
      expect(screen.queryByText(NOTICE)).toBeNull();
    });

    it('init completing moves the notice to the shell without a crash; a dismissal made while pending sticks', () => {
      setUa(UA.safari);
      const { rerender } = render(<App />);
      expect(screen.getByText(NOTICE)).toBeInTheDocument();
      // Init completes: the hook count must not change across the gate (React #310).
      state.isInitialized = true;
      rerender(<App />);
      expect(screen.queryByRole('dialog', { name: 'Starting TrainingApp' })).toBeNull();
      expect(screen.getByRole('main')).toBeInTheDocument();
      const shellBanner = screen.getByText(NOTICE).closest('.ui-banner') as HTMLElement;
      expect(shellBanner).toHaveClass('app-notice');
      expect(shellBanner.parentElement).toHaveAttribute('role', 'status');

      // A second boot: dismiss on the boot surface, then init completes.
      cleanup();
      state.isInitialized = false;
      const second = render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss unsupported-browser notice' }));
      expect(screen.queryByText(NOTICE)).toBeNull();
      state.isInitialized = true;
      second.rerender(<App />);
      expect(screen.getByRole('main')).toBeInTheDocument();
      expect(screen.queryByText(NOTICE)).toBeNull();
    });
  });

  it('LOW-B: with init already done, the shell polite region exists before the notice lands in it', () => {
    setUa(UA.safari);
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { childList: true, subtree: true });
    render(<App />);
    const banner = screen.getByText(NOTICE).closest('.ui-banner') as HTMLElement;
    const region = banner.parentElement as HTMLElement;
    const records = observer.takeRecords();
    observer.disconnect();
    expect(region).toHaveAttribute('role', 'status');
    expect(records.some((r) => r.target === region && Array.from(r.addedNodes).includes(banner))).toBe(true);
  });

  // critic-final-2 P13: "announced once" in the shell. The shell copy of the notice is announced by
  // the ONE always-mounted polite region it shares with the degraded-search notice: no live region
  // of its own (no nested, late-filled or separate status region), and it is not itself an alert.
  it('the shell notice has exactly one live-region ancestor: the always-mounted region shared with the degraded-search notice', () => {
    setUa(UA.safari);
    state.initError = 'vector index failed';
    render(<App />);
    const banner = screen.getByText(NOTICE).closest('.ui-banner') as HTMLElement;
    const liveAncestors: HTMLElement[] = [];
    for (let el = banner.parentElement; el; el = el.parentElement) {
      if (el.hasAttribute('role') && ['status', 'alert', 'log'].includes(el.getAttribute('role') as string)) liveAncestors.push(el);
      else if (el.hasAttribute('aria-live')) liveAncestors.push(el);
    }
    expect(liveAncestors).toHaveLength(1);
    const region = liveAncestors[0];
    expect(region).toHaveAttribute('role', 'status');
    expect(region).not.toHaveAttribute('aria-live');
    // The banner sits directly in that region, and is not a live region itself.
    expect(banner.parentElement).toBe(region);
    expect(banner).not.toHaveAttribute('role');
    expect(banner).not.toHaveAttribute('aria-live');
    expect(banner.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    // It is the always-mounted shell region: the same element the degraded-search notice lives in.
    const degraded = screen.getByText(/Search is degraded/).closest('.ui-banner') as HTMLElement;
    expect(degraded.parentElement).toBe(region);
  });

  // PR #151 final review LOW-C: a throwing userAgent getter must not crash the app for a
  // cosmetic notice; it is an unknown browser, so no notice.
  it.each([
    ['init done', true],
    ['init pending', false],
  ])('LOW-C: a throwing userAgent getter renders the app (%s) with no notice and no crash fallback', (_name, initialized) => {
    state.isInitialized = initialized;
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      get() {
        throw new Error('userAgent getter blew up');
      },
    });
    render(<App />);
    expect(screen.queryByRole('heading', { name: 'Something went wrong' })).toBeNull();
    expect(
      initialized ? screen.getByRole('main') : screen.getByRole('dialog', { name: 'Starting TrainingApp' })
    ).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
