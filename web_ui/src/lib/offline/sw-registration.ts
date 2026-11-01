/**
 * App-shell service-worker registration (issue #34 item 7 via #26, AC1).
 *
 * Registers public/sw.js (the offline app-shell worker: precache manifest +
 * network-first navigations + cache-first hashed assets) under strict guards
 * so hostile environments never attempt it:
 *  - `navigator.serviceWorker` must exist (jsdom and Electron's file loader
 *    have none — in jsdom that keeps every unit test a no-op);
 *  - the document protocol must be http or https. NOT file: (a static file
 *    tree has no worker scope) and NOT app: (Electron production loads the
 *    renderer from app://, a custom scheme with no service worker support —
 *    the desktop app boots from local files and needs no SW) and not about:;
 *  - not Vitest (import.meta.env.VITEST — tests that exercise this module
 *    stub the flag off deliberately; every other test file stays inert);
 *  - at most once per document (module flag).
 *
 * Errors are logged, never thrown: a failed registration must never block or
 * crash the app boot (registration runs before the first render).
 */

/** Once-per-document guard: a second call is a no-op even across imports. */
let registered = false;

/**
 * Register the app-shell service worker ('sw.js', resolved relative to the
 * document base) when every guard passes. Never throws; a rejected
 * registration (unsupported worker script, quota, shutdown race) resolves
 * with a logged warning.
 */
export function maybeRegisterServiceWorker(): void {
  try {
    if (registered) return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (typeof window === 'undefined' || typeof location === 'undefined') return;
    const protocol = location.protocol;
    // http/https only: file:, app:, about:, chrome-extension: etc. never register.
    if (protocol !== 'http:' && protocol !== 'https:') return;
    if (import.meta.env?.VITEST) return;
    registered = true;
    navigator.serviceWorker.register('sw.js').catch((error: unknown) => {
      // Registered flag stays true: a failed registration is not retried
      // per boot; the next document load tries again.
      console.warn('[sw-registration] app-shell service worker registration failed:', error);
    });
  } catch (error) {
    console.warn('[sw-registration] unexpected error while registering:', error);
  }
}
