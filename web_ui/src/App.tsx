import { useEffect, useState, type ReactNode } from 'react';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/ToastProvider';
import { InferenceModeProvider, useInferenceMode } from './lib/inference/InferenceModeContext';
import { MODEL_CONNECTION_SECTION_ID } from './lib/settings-sections';
import { seedInferenceModeForDesktop as seedInferenceModeForDesktopImpl } from './lib/inference/desktop-seed';
import {
  DesktopSessionProvider,
  fetchModelStatus,
  initDesktopSession,
  isElectron,
  resetDesktopSession,
  type DesktopSessionState,
} from './lib/desktop-session';
import { subscribeLatestModelStatus } from './lib/desktop-models-events';
import { isKnownUnsupportedBrowser } from './lib/browser/browser-compat';
import { migrateLegacyProviderToDesktop } from './lib/llm/external-migration';
import { AppLayout } from './layouts/AppLayout';
import { FirstRunGate } from './components/FirstRunWizard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Banner, Button, Dialog, IconButton, ProgressBar } from './ui';
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
import './components/blocking.css';

/**
 * Blocking boot state (Lumen phase 7, design-language.md section 5): ui/Dialog
 * (non-dismissible) with an indeterminate ui/ProgressBar while connecting, or a
 * ui/Banner tone="danger" (role="alert") with the failure and, when the caller
 * can honestly re-run the failed step, a Retry action. Nothing is mounted behind
 * it, so there is nothing to make inert.
 */
export function LoadingOverlay({
  currentStep,
  initError,
  onRetry,
  notice,
}: {
  currentStep: string;
  initError: string | null;
  /** Re-run the failed boot step. Omitted where no honest re-run exists. */
  onRetry?: () => void;
  /**
   * A non-blocking notice shown on the boot surface itself (the browser app's unsupported-browser
   * notice: PR #151 final review LOW-B). Nothing behind this modal boot dialog is visible, so a
   * notice that must be seen while boot is pending or hung has to live here. Omitted: no extra DOM.
   */
  notice?: ReactNode;
}) {
  // The live region is mounted EMPTY and filled after mount: a role=status that is
  // inserted together with its text is not reliably announced (PRR-151-041), so the
  // first boot step is only spoken if the region already exists when its text lands.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    setAnnounced(initError ? '' : currentStep);
  }, [currentStep, initError]);
  return (
    <Dialog
      open
      dismissible={false}
      layer="boot"
      headingLevel={1}
      className="blocking-gate"
      title={initError ? currentStep : 'Starting TrainingApp'}
      footer={
        initError && onRetry ? (
          <Button variant="primary" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      <div className="blocking-gate__stack">
        {/* The step text lives in a persistent polite status region so each boot step
            change (including the first) is announced; the title is stable. */}
        <p role="status" className="blocking-gate__lead">
          {announced}
        </p>
        {initError ? <Banner tone="danger">{initError}</Banner> : <ProgressBar label="Starting" />}
        {notice !== undefined && notice !== null && <LateFilledStatus>{notice}</LateFilledStatus>}
      </div>
    </Dialog>
  );
}

/**
 * A polite role=status region that is mounted EMPTY and receives its content one commit later:
 * a live region inserted together with its content is not reliably announced (PRR-151-041; the
 * same pattern as LoadingOverlay's step text).
 */
function LateFilledStatus({ children }: { children: ReactNode }) {
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    setFilled(true);
  }, []);
  return <div role="status">{filled ? children : null}</div>;
}

/**
 * B9 (issue #67): seed the inference-mode store BEFORE InferenceModeProvider
 * mounts so a desktop launch boots in `api` mode pointed at the Electron
 * backend. Extracted to lib/inference/desktop-seed for unit testing; a
 * persisted legacy 'provider' mode (PR #138) also becomes 'api' and is
 * migrated into the backend's external.* settings.
 */
function seedInferenceModeForDesktop(baseUrl: string): void {
  seedInferenceModeForDesktopImpl(baseUrl);
}

/**
 * B9 (issue #67): boot gate for the Electron shell. Discovers the loopback
 * backend + launch token once, fetches model presence for the first-run
 * gate, seeds the inference-mode store, and only then mounts the app under
 * the DesktopSessionProvider. Failures render an informative blocking state
 * (never a silently broken app). Pure-browser builds never mount this gate.
 */
export function DesktopBootGate({ children }: { children: ReactNode }) {
  // Bumped by the boot-failure Retry; initDesktopSession clears its memo on
  // failure ("a failed launch must be retryable"), so re-running the effect is a
  // real second attempt, not a re-render of the same error.
  const [attempt, setAttempt] = useState(0);
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
        if (cancelled) return;
        seedInferenceModeForDesktop(session.baseUrl);
        // universal-provider-settings-overhaul: move a legacy PR #138
        // provider connection into the backend's external.* settings once,
        // BEFORE reading model status (it may switch the engine to external).
        await migrateLegacyProviderToDesktop(session.apiClient).catch(() => false);
        // Presence fetch failure is degraded-but-live: the first-run gate
        // treats null as "not blocking" and the status UI shows the error.
        const models = await fetchModelStatus(session).catch(() => null);
        if (cancelled) return;
        setState({ session, models, loading: false, error: null });
      } catch (err) {
        // initDesktopSession clears its memo only when discovery itself rejects. A
        // throw AFTER it resolved (seeding, migration) must clear it too, or Retry
        // re-resolves the same session and fails identically (PRR-151-010).
        resetDesktopSession();
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
  }, [attempt]);

  const retryBoot = () => {
    setState({ session: null, models: null, loading: true, error: null });
    setAttempt((n) => n + 1);
  };

  // universal-provider-settings-overhaul: toggling "Use external model" flips
  // the backend engine between llama.cpp and external — re-read model status
  // so the first-run gate and chat routing follow without a restart.
  const session = state.session;
  useEffect(() => {
    if (session === null) return undefined;
    // F-006: latest-request guard — an older fetch resolving after a newer
    // one never overwrites it; unsubscribing on unmount drops in-flight ones.
    return subscribeLatestModelStatus(
      () => fetchModelStatus(session),
      (models) => setState((prev) => ({ ...prev, models })),
    );
  }, [session]);

  // Keyed per state/attempt: Retry unmounts the focused button, and the loading
  // panel has nothing focusable, so remounting the Dialog re-runs its open-time focus
  // (onto the panel) instead of leaving focus on <body> with the modal trap inert.
  if (state.loading) {
    return (
      <LoadingOverlay
        key={`boot-loading-${attempt}`}
        currentStep="Connecting to the desktop backend..."
        initError={null}
      />
    );
  }
  if (state.error) {
    return (
      <LoadingOverlay
        key="boot-error"
        currentStep="Desktop backend unavailable"
        initError={state.error}
        onRetry={retryBoot}
      />
    );
  }
  return <DesktopSessionProvider value={state}>{children}</DesktopSessionProvider>;
}

function AppContent() {
  const [currentPage, setCurrentPage] = useState('chat');
  // settings-wiring-honesty (AC10): the Settings section a navigation asked
  // for (null = top of the page), e.g. the model-blocked overlay's external
  // model action.
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  // Bumped on every openSettings call so a repeated request for the section Settings
  // already targets (same state value, no re-render) still scrolls and focuses it.
  const [settingsRequest, setSettingsRequest] = useState(0);
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
  // The init-error text the user dismissed. A later, different failure (the hook appends
  // new ones to the same string) re-arms the notice instead of staying latched off.
  const [dismissedInitError, setDismissedInitError] = useState<string | null>(null);
  // Upfront unsupported-browser notice (browser app only; Electron is never "a browser").
  // Classified once, in a mount effect rather than during render (PR #151 final review LOW-B):
  // the polite region that shows it is already mounted, empty, when the notice lands, so the
  // notice is a content change inside an existing live region. Dismissal is for this session only.
  const [browserUnsupported, setBrowserUnsupported] = useState(false);
  const [browserNoticeDismissed, setBrowserNoticeDismissed] = useState(false);
  // HOOK-ORDER NOTE: above the `if (!isInitialized)` early return, like every hook here.
  useEffect(() => {
    setBrowserUnsupported(!isElectron() && isKnownUnsupportedBrowser());
  }, []);
  const showBrowserNotice = browserUnsupported && !browserNoticeDismissed;
  const browserNotice = (className?: string) => (
    <Banner
      tone="warning"
      live={false}
      className={className}
      action={
        <IconButton
          icon="x"
          size="sm"
          aria-label="Dismiss unsupported-browser notice"
          onClick={() => setBrowserNoticeDismissed(true)}
        />
      }
    >
      This browser isn&apos;t supported. Use a current Chrome, Edge or Firefox.
    </Banner>
  );
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
    searchQuery,
    setSearchQuery,
    searchResults,
    searchTruncated,
    isSearching,
  } = useConversations();

  const { isInitialized, initError, currentStep } = useServiceInitialization({
    setModelReady,
    setModelLoadingProgress,
    browserEngine,
    // B9 (issue #67): inside Electron the desktop backend owns documents and
    // inference — never boot the browser-local WASM/IndexedDB singletons.
    skip: isElectron(),
  });

  // settings-wiring-honesty (AC10): an optional section id scrolls Settings to
  // that section. Callers that bind this directly as an onClick handler pass
  // a click event, so only a string counts as a section request.
  const openSettings = (section?: unknown) => {
    setSettingsSection(typeof section === 'string' ? section : null);
    setSettingsRequest((n) => n + 1);
    setCurrentPage('settings');
  };
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

  // D7 (issue #83) staleness producer (AC5): entering the training page for a
  // pack the pinned slide does NOT belong to means the player can no longer
  // vouch for the pin — mark it stale (visibly marked in the chat banner,
  // never attached to questions). The new pack's first slidechange supersedes
  // the pin with a fresh one. Guards: unknown packIds never stale-flag, and an
  // already-stale pin stays stale.
  //
  // HOOK-ORDER NOTE: this effect MUST stay above the `if (!isInitialized)`
  // early return below. Registered after that conditional return, the hook
  // count would grow when the boot gate lifts (isInitialized false → true),
  // crashing the renderer with React error #310 ("Rendered more hooks than
  // during the previous render") exactly at the end of first-run init —
  // caught by the Playwright-under-Electron smoke, invisible to unit suites
  // that mock the gate as always-initialized.
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

  if (!isInitialized) {
    // No onRetry: useServiceInitialization exposes no re-init, and it reports
    // initError together with isInitialized=true (see the init-error banner
    // below), so this overlay is the in-progress state in practice. A Retry
    // here would have nothing honest to call.
    // The unsupported-browser notice is shown ON the boot surface (LOW-B): it must be seen
    // even while init is pending or hung, and nothing behind this modal dialog is visible.
    return (
      <LoadingOverlay
        currentStep={currentStep}
        initError={initError}
        notice={showBrowserNotice ? browserNotice() : undefined}
      />
    );
  }

  const handleNavigate = (page: string) => {
    // D6 (issue #82): a pending slide target never leaks across an unrelated
    // page switch (and can never be lost on a documents → training hop).
    if (page !== 'training' && trainingTarget !== null) {
      setTrainingTarget(null);
    }
    // Sidebar navigation opens Settings at the top, never at a stale section.
    setSettingsSection(null);
    setCurrentPage(page);
  };

  // D7 (issue #83): the ChatPage element is built ONCE — both the 'chat' case
  // and the default case render the SAME element, so the pinned-slide props
  // can never be wired at one render site and forgotten at the other.
  const chatPage = (
    <ErrorBoundary resetKeys={[currentPage]}>
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
          <ErrorBoundary resetKeys={[currentPage]}>
            <DocumentsPage />
          </ErrorBoundary>
        );
      case 'settings':
        return (
          <ErrorBoundary resetKeys={[currentPage]}>
            <SettingsPage initialSection={settingsSection ?? undefined} sectionRequest={settingsRequest} />
          </ErrorBoundary>
        );
      case 'training':
        return (
          <ErrorBoundary resetKeys={[currentPage]}>
            <TrainingPage
              initialPackId={trainingTarget?.packId}
              pendingSlideId={trainingTarget?.slideId}
              onSlideChange={handlePlayerSlideChange}
              // Lumen phase 6: the player page's Back releases the lifted deep
              // link, so the course library (and the course picked there) shows.
              onLeaveDeepLink={() => setTrainingTarget(null)}
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
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchResults={searchResults}
      searchTruncated={searchTruncated}
      isSearching={isSearching}
      onOpenModelSettings={() => openSettings(MODEL_CONNECTION_SECTION_ID)}
    >
      {/* E2 (issue #85): first-run validation wizard gate — renders the
          overlay only when a first run (or drift re-run) is needed. */}
      <FirstRunGate />
      {persistenceError && (
        <Banner
          tone="danger"
          className="app-notice"
          action={
            <IconButton icon="x" size="sm" aria-label="Dismiss error" onClick={clearPersistenceError} />
          }
        >
          {persistenceError}
        </Banner>
      )}
      {/* U3a: boot init-error banner. useServiceInitialization sets both
          setInitError and setIsInitialized(true) in one synchronous block, so
          React 18 batches them and the !isInitialized-gated overlay never
          paints the error. This banner surfaces it POST-init so search/vector
          init failures are visible. Retry reloads the page (the most reliable
          re-init, since the hook guards against re-running in-process).
          Polite status region (it is not an interruption), so the Banner's own
          alert role is switched off (live={false}) inside it. */}
      {/* The polite region is always mounted so the notice (and a later, different failure)
          is a content change inside an existing live region, not an inserted-with-content one. */}
      <div role="status">
        {showBrowserNotice && browserNotice('app-notice')}
        {initError && initError !== dismissedInitError && (
          <Banner
            tone="warning"
            live={false}
            className="app-notice"
            action={
              <>
                <Button size="sm" onClick={() => window.location.reload()}>
                  Retry
                </Button>
                <IconButton
                  icon="x"
                  size="sm"
                  aria-label="Dismiss degraded-search notice"
                  onClick={() => setDismissedInitError(initError)}
                />
              </>
            }
          >
            Search is degraded — answers may miss information. ({initError})
          </Banner>
        )}
      </div>
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
