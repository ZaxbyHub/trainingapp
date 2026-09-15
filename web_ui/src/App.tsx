import { useEffect, useState, type ReactNode } from 'react';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/ToastProvider';
import { InferenceModeProvider, useInferenceMode } from './lib/inference/InferenceModeContext';
import {
  DesktopSessionProvider,
  fetchModelStatus,
  initDesktopSession,
  isElectron,
  type DesktopSessionState,
} from './lib/desktop-session';
import { AppLayout } from './layouts/AppLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ChatPage } from './pages/ChatPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TrainingPage } from './pages/TrainingPage';
import type { PinnedSlide } from './components/PinnedSlideContext';
import { resolveSlideDoc, type ResolvedSlideDoc } from './lib/training/slide-doc-resolver';
import { useServiceInitialization } from './hooks/useServiceInitialization';
import { useConversations } from './hooks/useConversations';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './styles/theme.css';

function LoadingOverlay({
  currentStep,
  initError,
}: {
  currentStep: string;
  initError: string | null;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--color-bubble-assistant)',
        color: 'var(--color-text-primary)',
        fontFamily: 'var(--font-family)',
        gap: 'var(--spacing-xl)',
        zIndex: 9999,
      }}
    >
      <div
        style={{
          width: '48px',
          height: '48px',
          border: '3px solid var(--color-bubble-system)',
          borderTopColor: 'var(--color-primary)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }}
      />
      <span
        role="status"
        aria-live="polite"
        style={{
          fontSize: 'var(--font-size-body)',
          color: 'var(--color-text-muted)',
        }}
      >
        {currentStep}
      </span>
      {initError && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            marginTop: 'var(--spacing-xl)',
            padding: 'var(--spacing-lg) var(--spacing-xl)',
            backgroundColor: 'rgba(211, 47, 47, 0.1)',
            border: '1px solid var(--color-danger)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-danger)',
            fontSize: 'var(--font-size-caption)',
            maxWidth: '400px',
            textAlign: 'center',
          }}
        >
          {initError}
        </div>
      )}
    </div>
  );
}

/**
 * B9 (issue #67): seed the inference-mode store BEFORE InferenceModeProvider
 * mounts so a desktop launch boots in `api` mode pointed at the Electron
 * backend. The loopback port and launch token rotate on every app start, so
 * this must run with the FRESH session values each launch (loadStoredState
 * would otherwise restore a stale serverUrl from the previous run).
 */
function seedInferenceModeForDesktop(baseUrl: string): void {
  const KEY = 'inference-mode';
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    stored = {};
  }
  stored.mode = 'api';
  stored.serverUrl = baseUrl;
  localStorage.setItem(KEY, JSON.stringify(stored));
}

/**
 * B9 (issue #67): boot gate for the Electron shell. Discovers the loopback
 * backend + launch token once, fetches model presence for the first-run
 * gate, seeds the inference-mode store, and only then mounts the app under
 * the DesktopSessionProvider. Failures render an informative blocking state
 * (never a silently broken app). Pure-browser builds never mount this gate.
 */
function DesktopBootGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopSessionState>({
    session: null,
    models: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await initDesktopSession();
        // Presence fetch failure is degraded-but-live: the first-run gate
        // treats null as "not blocking" and the status UI shows the error.
        const models = await fetchModelStatus(session).catch(() => null);
        if (cancelled) return;
        seedInferenceModeForDesktop(session.baseUrl);
        setState({ session, models, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          session: null,
          models: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) {
    return <LoadingOverlay currentStep="Connecting to the desktop backend..." initError={null} />;
  }
  if (state.error) {
    return (
      <LoadingOverlay currentStep="Desktop backend unavailable" initError={state.error} />
    );
  }
  return <DesktopSessionProvider value={state}>{children}</DesktopSessionProvider>;
}

function AppContent() {
  const [currentPage, setCurrentPage] = useState('chat');
  // D6 (issue #82): lifted training navigation target so a chat-side
  // "Open in training" deep link survives the page switch and is consumed by
  // TrainingPage → TrainingPlayer's initialSlideId auto-jump.
  const [trainingTarget, setTrainingTarget] = useState<{ packId?: string; slideId: string } | null>(null);
  // D7 (issue #83): the slide currently pinned from the training player.
  // Captured from slidechange (title immediately; section/text resolved from
  // the ingested slide docs), cleared by dismissal, superseded by every new
  // slidechange, marked stale when the player moves to a different pack, and
  // naturally cleared on reload (in-memory only).
  const [pinnedSlide, setPinnedSlide] = useState<PinnedSlide | null>(null);
  const [initErrorDismissed, setInitErrorDismissed] = useState(false);
  const { setModelReady, setModelLoadingProgress, browserEngine } = useInferenceMode();

  const {
    conversations,
    currentConversationId,
    currentMessages,
    setCurrentMessages,
    setCurrentConversationId,
    selectConversation,
    newChat,
    saveMessages,
    removeConversation,
    renameConversation,
    hasMore,
    loadMore,
    persistenceError,
    clearPersistenceError,
  } = useConversations();

  const { isInitialized, initError, currentStep } = useServiceInitialization({
    setModelReady,
    setModelLoadingProgress,
    browserEngine,
    // B9 (issue #67): inside Electron the desktop backend owns documents and
    // inference — never boot the browser-local WASM/IndexedDB singletons.
    skip: isElectron(),
  });

  const openSettings = () => setCurrentPage('settings');
  const goToDocuments = () => setCurrentPage('documents');
  // D6 (issue #82): chat → training deep link ("Open in training").
  const openTraining = (target: { packId?: string; slideId: string }) => {
    setTrainingTarget(target);
    setCurrentPage('training');
  };

  // D7 (issue #83): the pack the training page will play right now — the
  // lifted target wins, else the ?pack= query parameter (TrainingPage's own
  // fallback, mirrored here for the staleness producer).
  const effectiveTrainingPack = (): string => {
    if (trainingTarget?.packId) return trainingTarget.packId;
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('pack') ?? '';
  };

  // D7 (issue #83): capture the player's slidechange as the pinned slide.
  // Title/section degrade gracefully: on-screen text and section resolve from
  // the ingested slide docs when available (never guessed); any resolver
  // failure degrades to a title-only pin.
  const handlePlayerSlideChange = (event: { slideId: string; slideTitle: string }) => {
    let resolved: ResolvedSlideDoc | null = null;
    try {
      resolved = resolveSlideDoc(event.slideId);
    } catch {
      resolved = null;
    }
    setPinnedSlide({
      slideId: event.slideId,
      slideTitle: event.slideTitle,
      packId: effectiveTrainingPack(),
      stale: false,
      ...(resolved?.section ? { section: resolved.section } : {}),
      ...(resolved?.text ? { text: resolved.text } : {}),
    });
  };

  // Global Ctrl+, (Open Settings) shortcut, registered here so it works from
  // every page (Documents, Settings, Chat), not just while ChatPage is mounted.
  // ChatPage additionally registers its own useKeyboardShortcuts for the
  // chat-scoped send/clear-chat shortcuts, and also wires the same
  // `openSettings` callback for its model-blocked overlay's "Open Settings"
  // button and its own Ctrl+, handling. When the user is on the Chat page,
  // both this hook and ChatPage's hook receive the Ctrl+, keydown and both
  // call `openSettings`, but `setCurrentPage('settings')` is idempotent when
  // called twice with the same value, so the double-firing is harmless.
  useKeyboardShortcuts({ onOpenSettings: openSettings });

  if (!isInitialized) {
    return (
      <LoadingOverlay currentStep={currentStep} initError={initError} />
    );
  }

  // D7 (issue #83) staleness producer (AC5): entering the training page for a
  // pack the pinned slide does NOT belong to means the player can no longer
  // vouch for the pin — mark it stale (visibly marked in the chat banner,
  // never attached to questions). The new pack's first slidechange supersedes
  // the pin with a fresh one. Guards: unknown packIds never stale-flag, and an
  // already-stale pin stays stale.
  useEffect(() => {
    if (currentPage !== 'training') return;
    setPinnedSlide((prev) => {
      if (prev === null || prev.stale === true) return prev;
      const packId = effectiveTrainingPack();
      return packId !== '' && prev.packId !== undefined && prev.packId !== '' && prev.packId !== packId
        ? { ...prev, stale: true }
        : prev;
    });
    // effectiveTrainingPack reads trainingTarget + window.location.search;
    // both are re-read whenever the page switches to 'training'.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, trainingTarget]);

  const handleNavigate = (page: string) => {
    // D6 (issue #82): a pending slide target never leaks across an unrelated
    // page switch (and can never be lost on a documents → training hop).
    if (page !== 'training' && trainingTarget !== null) {
      setTrainingTarget(null);
    }
    setCurrentPage(page);
  };

  // D7 (issue #83): the ChatPage element is built ONCE — both the 'chat' case
  // and the default case render the SAME element, so the pinned-slide props
  // can never be wired at one render site and forgotten at the other.
  const chatPage = (
    <ErrorBoundary>
      <ChatPage
        messages={currentMessages}
        onMessagesChange={setCurrentMessages}
        onSaveConversation={saveMessages}
        currentConversationId={currentConversationId}
        setCurrentConversationId={setCurrentConversationId}
        onNewChat={newChat}
        onOpenSettings={openSettings}
        onNavigateToDocuments={goToDocuments}
        onOpenTraining={openTraining}
        pinnedSlide={pinnedSlide}
        onDismissPinnedSlide={() => setPinnedSlide(null)}
      />
    </ErrorBoundary>
  );

  const renderPage = () => {
    switch (currentPage) {
      case 'chat':
        return chatPage;
      case 'documents':
        return (
          <ErrorBoundary>
            <DocumentsPage />
          </ErrorBoundary>
        );
      case 'settings':
        return (
          <ErrorBoundary>
            <SettingsPage />
          </ErrorBoundary>
        );
      case 'training':
        return (
          <ErrorBoundary>
            <TrainingPage
              initialPackId={trainingTarget?.packId}
              pendingSlideId={trainingTarget?.slideId}
              onSlideChange={handlePlayerSlideChange}
            />
          </ErrorBoundary>
        );
      default:
        return chatPage;
    }
  };

  return (
    <AppLayout
      currentPage={currentPage}
      onNavigate={handleNavigate}
      conversations={conversations}
      currentConversationId={currentConversationId}
      onNewChat={newChat}
      onSelectConversation={selectConversation}
      onRenameConversation={renameConversation}
      onDeleteConversation={removeConversation}
      hasMore={hasMore}
      onLoadMore={loadMore}
    >
      {persistenceError && (
        <div style={{
          padding: 'var(--spacing-sm) var(--spacing-md)',
          backgroundColor: 'rgba(211, 47, 47, 0.1)',
          border: '1px solid var(--color-danger)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--color-danger)',
          fontSize: 'var(--font-size-caption)',
          margin: 'var(--spacing-sm) var(--spacing-md)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>{persistenceError}</span>
          <button onClick={clearPersistenceError} aria-label="Dismiss error" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 'var(--font-size-body)' }}>×</button>
        </div>
      )}
      {/* U3a: boot init-error banner. useServiceInitialization sets both
          setInitError and setIsInitialized(true) in one synchronous block, so
          React 18 batches them and the !isInitialized-gated overlay never
          paints the error. This banner surfaces it POST-init so search/vector
          init failures are visible. Retry reloads the page (the most reliable
          re-init, since the hook guards against re-running in-process). */}
      {initError && !initErrorDismissed && (
        <div
          role="status"
          style={{
            padding: 'var(--spacing-sm) var(--spacing-md)',
            backgroundColor: 'rgba(234, 179, 8, 0.12)',
            border: '1px solid var(--color-warning-strong)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-warning-strong)',
            fontSize: 'var(--font-size-caption)',
            margin: 'var(--spacing-sm) var(--spacing-md)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 'var(--spacing-md)',
          }}
        >
          <span>Search is degraded — answers may miss information. ({initError})</span>
          <span style={{ display: 'flex', gap: 'var(--spacing-sm)', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ background: 'transparent', border: '1px solid currentColor', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'inherit', fontSize: 'var(--font-size-caption)', padding: '2px var(--spacing-sm)' }}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => setInitErrorDismissed(true)}
              aria-label="Dismiss degraded-search notice"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 'var(--font-size-body)' }}
            >
              ×
            </button>
          </span>
        </div>
      )}
      {renderPage()}
    </AppLayout>
  );
}

function App() {
  // B9 (issue #67): inside the Electron shell, discovery + model presence
  // resolve BEFORE the app mounts; the pure-browser tree is untouched.
  if (isElectron()) {
    return (
      <ThemeProvider>
        <ToastProvider>
          <DesktopBootGate>
            <InferenceModeProvider>
              <ErrorBoundary>
                <AppContent />
              </ErrorBoundary>
            </InferenceModeProvider>
          </DesktopBootGate>
        </ToastProvider>
      </ThemeProvider>
    );
  }
  return (
    <ThemeProvider>
      <ToastProvider>
        <InferenceModeProvider>
          <ErrorBoundary>
            <AppContent />
          </ErrorBoundary>
        </InferenceModeProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
