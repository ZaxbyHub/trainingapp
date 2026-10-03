/**
 * Live view of the stored external-model configuration for components that
 * describe the active generator (Chat header chip, sidebar footer chip).
 *
 * useSyncExternalStore over loadExternalConfig(), re-read on:
 *  - EXTERNAL_CONFIG_CHANGED_EVENT (same tab: saveExternalConfig dispatches it);
 *  - USER_SETTINGS_CLEARED_EVENT (Settings > Clear Cache removed the stored config);
 *  - the window `storage` event (another tab or window changed it).
 * The snapshot is cached by its serialized value, so getSnapshot returns the SAME
 * object until the stored config actually changes (no render loops, and React's
 * tearing check is satisfied).
 *
 * Send-time routing (ChatPage.runGeneration) still reads loadExternalConfig()
 * directly at the moment of sending; this hook only keeps rendered state fresh.
 */
import { useSyncExternalStore } from 'react';
import { loadExternalConfig, type ExternalConfig } from './external-provider';
import { EXTERNAL_CONFIG_CHANGED_EVENT } from './external-config-events';
import { USER_SETTINGS_CLEARED_EVENT } from '../storage/persisted-keys';

let cachedKey: string | null = null;
let cachedConfig: ExternalConfig | null = null;

function getSnapshot(): ExternalConfig {
  const config = loadExternalConfig();
  const key = JSON.stringify(config);
  if (cachedConfig === null || key !== cachedKey) {
    cachedKey = key;
    cachedConfig = config;
  }
  return cachedConfig;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(EXTERNAL_CONFIG_CHANGED_EVENT, onChange);
  window.addEventListener(USER_SETTINGS_CLEARED_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EXTERNAL_CONFIG_CHANGED_EVENT, onChange);
    window.removeEventListener(USER_SETTINGS_CLEARED_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function useExternalConfig(): ExternalConfig {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
