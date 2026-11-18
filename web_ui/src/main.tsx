// Diagnostics logging (issue #248) FIRST — before App and every runtime
// import: the install module's body runs at module evaluation, so its console
// wrapper captures dependency-evaluation-time output and the level resolves
// (browser localStorage read / Electron getState) before the first gated entry.
import './lib/logging/install';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { maybeRegisterServiceWorker } from './lib/offline/sw-registration';
import { startBrowserTraining } from './lib/packs/browser-training';
import { deleteLegacySettingsStore } from './lib/storage/legacy-settings-delete';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

// Issue #367 (WI6 residual / plan RC4-02 contract): the ABANDONED legacy
// settings database is deleted at EVERY boot — unconditionally, no
// done-marker (an absent store makes deleteDatabase a cheap no-op, and
// every-boot execution also covers a database a rolled-back build
// recreated). Failure is non-fatal and retries next boot. Runs in BOTH
// runtimes (browser + Electron renderer — same bundle, same origin store),
// after the profile prefix exists (db/index module init) and never blocks
// mounting.
deleteLegacySettingsStore();

// Lumen component gallery (dev only): `vite` + `/?gallery`. `import.meta.env.DEV`
// is the literal `false` in production builds, so the dynamic import below is
// dead-code-eliminated and the gallery chunk is never emitted.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('gallery')) {
  void import('./ui/gallery/mount').then((m) => m.mountGallery(rootElement));
} else {
  // App-shell offline resilience (issue #34 item 7, AC1): register the
  // app-shell service worker BEFORE the first render so the offline fallback
  // is installed as early as possible. Guard-wrapped: jsdom (every unit
  // test), file: and app:// documents never register.
  maybeRegisterServiceWorker();

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

  // Browser app only (inert inside Electron): resolve the dedicated course
  // player origin once and register its service worker early
  // (browser-training-parity, ADR-0012).
  void startBrowserTraining().catch((error: unknown) => {
    console.warn('[training] player start-up failed:', error);
  });
}
