import { useState } from 'react';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/ToastProvider';
import { InferenceModeProvider, useInferenceMode } from './lib/inference/InferenceModeContext';
import { AppLayout } from './layouts/AppLayout';
import { ChatPage } from './pages/ChatPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { SettingsPage } from './pages/SettingsPage';
import { useServiceInitialization } from './hooks/useServiceInitialization';
import { useConversations } from './hooks/useConversations';
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
  const { setModelReady, setModelLoadingProgress, browserEngine } = useInferenceMode();

  const {
    conversations,
    currentConversationId,
    currentMessages,
    setCurrentMessages,
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

  if (!isInitialized) {
    return (
      <LoadingOverlay currentStep={currentStep} initError={initError} />
    );
  }

  const handleNavigate = (page: string) => {
    setCurrentPage(page);
  };

  const openSettings = () => setCurrentPage('settings');

  const renderPage = () => {
    switch (currentPage) {
      case 'chat':
        return (
          <ChatPage
            messages={currentMessages}
            onMessagesChange={setCurrentMessages}
            onSaveConversation={saveMessages}
            onNewChat={newChat}
            onOpenSettings={openSettings}
          />
        );
      case 'documents':
        return <DocumentsPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return (
          <ChatPage
            messages={currentMessages}
            onMessagesChange={setCurrentMessages}
            onSaveConversation={saveMessages}
            onNewChat={newChat}
            onOpenSettings={openSettings}
          />
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
      {renderPage()}
    </AppLayout>
  );
}

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <InferenceModeProvider>
          <AppContent />
        </InferenceModeProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
