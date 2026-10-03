/**
 * "The stored external-model configuration changed" signal (browser app).
 *
 * saveExternalConfig writes the config to storage and dispatches this. Components
 * that DESCRIBE the active generator (the Chat header model chip and the sidebar
 * footer connection chip) stay mounted across that write
 * (the sidebar is always mounted while Settings is open), so they subscribe to
 * this same-tab event instead of reading storage once per render. Cross-tab
 * changes arrive through the browser's `storage` event (see useExternalConfig).
 * The one-time legacy migration (external-migration.ts) deliberately does NOT
 * dispatch: it runs inside InferenceModeProvider's useState initializer (render
 * phase) before any chip mounts, and the chips read the migrated value on their
 * first render anyway. Kept dependency-free so writers can import it without a cycle.
 */
export const EXTERNAL_CONFIG_CHANGED_EVENT = 'trainingapp:external-config-changed';

export function notifyExternalConfigChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(EXTERNAL_CONFIG_CHANGED_EVENT));
}
