import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

// Outermost boundary: catches errors thrown during provider construction
// (ThemeProvider/ToastProvider/InferenceModeProvider) that the App-internal
// boundary — which lives inside those providers — cannot catch. Without this,
// a provider crash unmounts the whole app to a blank page.
createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
