import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

// Lumen component gallery (dev only): `vite` + `/?gallery`. `import.meta.env.DEV`
// is the literal `false` in production builds, so the dynamic import below is
// dead-code-eliminated and the gallery chunk is never emitted.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('gallery')) {
  void import('./ui/gallery/mount').then((m) => m.mountGallery(rootElement));
} else {
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
}
