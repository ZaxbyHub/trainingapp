import { useState } from 'react';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/ToastProvider';
import { InferenceModeProvider, useInferenceMode } from './lib/inference/InferenceModeContext';
import { AppLayout } from './layouts/AppLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ChatPage } from './pages/ChatPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { SettingsPage } from './pages/SettingsPage';
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
        style={{
          fontSize: 'var(--font-size-body)',
          color: 'var(--color-text-muted)',
        }}
      >
        {currentStep}
      </span>
      {initError && (
        <div
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

function AppContent() {
  const [currentPage, setCurrentPage] = useState('chat');
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
  });

  const openSettings = () => setCurrentPage('settings');
  const goToDocuments = () => setCurrentPage('documents');

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

  const handleNavigate = (page: string) => {
    setCurrentPage(page);
  };

  const renderPage = () => {
    switch (currentPage) {
      case 'chat':
        return (
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
            />
          </ErrorBoundary>
        );
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
      default:
        return (
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
            />
          </ErrorBoundary>
      );
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
