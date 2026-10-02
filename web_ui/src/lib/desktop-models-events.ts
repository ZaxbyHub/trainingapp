/**
 * Desktop app: "the backend's /status/models answer may have changed" signal
 * (universal-provider-settings-overhaul). The boot gate fetches model status
 * once; toggling "Use external model" flips the engine between 'llama.cpp'
 * and 'external', so the Settings panel announces the change and the boot
 * gate re-reads /status/models. Kept outside lib/desktop-session so pages that
 * mock that module are unaffected.
 */
export const DESKTOP_MODELS_CHANGED_EVENT = 'trainingapp:desktop-models-changed';

export function notifyDesktopModelsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(DESKTOP_MODELS_CHANGED_EVENT));
}

export function onDesktopModelsChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(DESKTOP_MODELS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(DESKTOP_MODELS_CHANGED_EVENT, listener);
}

/**
 * Re-fetch model status on every models-changed signal and apply ONLY the
 * newest request's answer (F-006, PR #142 review). Two quick toggles start
 * two fetches; if the older one resolves last, its stale answer must not
 * overwrite the newer one. A newer request that fails also retires every
 * older in-flight request. Returns the unsubscribe; after it runs nothing
 * applies.
 */
export function subscribeLatestModelStatus<T>(
  fetchStatus: () => Promise<T>,
  apply: (status: T) => void,
): () => void {
  let latest = 0;
  let disposed = false;
  const off = onDesktopModelsChanged(() => {
    latest += 1;
    const seq = latest;
    void fetchStatus()
      .then((status) => {
        if (!disposed && seq === latest) apply(status);
      })
      .catch(() => undefined);
  });
  return () => {
    disposed = true;
    off();
  };
}
