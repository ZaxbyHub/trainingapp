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
