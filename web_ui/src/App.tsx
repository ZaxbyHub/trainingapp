import React, { useState } from 'react';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/ToastProvider';
import { InferenceModeProvider, useInferenceMode } from './lib/inference/InferenceModeContext';
import { AppLayout } from './layouts/AppLayout';
import { ChatPage } from './pages/ChatPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { SettingsPage } from './pages/SettingsPage';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useServiceInitialization } from './hooks/useServiceInitialization';
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
        backgroundColor: 'var(--color-background, #0f0f0f)',
        color: 'var(--color-text-primary, #ffffff)',
        fontFamily: 'var(--font-sans, system-ui, sans-serif)',
        gap: 'var(--spacing-4, 16px)',
        zIndex: 9999,
      }}
    >
      <div
        style={{
          width: '48px',
          height: '48px',
          border: '3px solid var(--color-border, #333)',
          borderTopColor: 'var(--color-accent, #6366f1)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }}
      />
      <span
        style={{
          fontSize: 'var(--font-size-base, 14px)',
          color: 'var(--color-text-secondary, #a1a1aa)',
        }}
      >
        {currentStep}
      </span>
      {initError && (
        <div
          style={{
            marginTop: 'var(--spacing-4, 16px)',
            padding: 'var(--spacing-3, 12px) var(--spacing-4, 16px)',
            backgroundColor: 'var(--color-error-bg, rgba(239, 68, 68, 0.1))',
            border: '1px solid var(--color-error, #ef4444)',
            borderRadius: 'var(--spacing-2, 8px)',
            color: 'var(--color-error, #ef4444)',
            fontSize: 'var(--font-size-sm, 12px)',
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
  const { setModelReady, setModelLoadingProgress } = useInferenceMode();

  const { isInitialized, initError, currentStep } = useServiceInitialization({
    setModelReady,
    setModelLoadingProgress,
  });

  useKeyboardShortcuts({
    onOpenSettings: () => setCurrentPage('settings'),
  });

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
        return <ChatPage />;
      case 'documents':
        return <DocumentsPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <ChatPage />;
    }
  };

  return (
    <AppLayout currentPage={currentPage} onNavigate={handleNavigate}>
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
