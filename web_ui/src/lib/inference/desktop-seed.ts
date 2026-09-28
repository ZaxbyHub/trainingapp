/**
 * B9 (issue #67) desktop inference-mode seeding, extracted from App.tsx
 * (trace external-llm-provider-settings) so the persistence behavior is
 * unit-testable without mounting the App import graph.
 *
 * Seeds the inference-mode store BEFORE InferenceModeProvider mounts so a
 * desktop launch boots in `api` mode pointed at the Electron backend. The
 * loopback port and launch token rotate on every app start, so this must run
 * with the FRESH session values each launch.
 *
 * A persisted 'provider' mode SURVIVES the re-seed: provider chat ignores the
 * loopback backend entirely, so forcing mode back to 'api' on every launch
 * would silently discard the user's provider selection (the AC1 persistence
 * defect). `serverUrl` is still refreshed unconditionally — it belongs to
 * 'api' mode and switching back should target the live backend.
 */

const STORAGE_KEY = 'inference-mode';

export function seedInferenceModeForDesktop(baseUrl: string): void {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    stored = {};
  }
  if (stored.mode !== 'provider') {
    stored.mode = 'api';
  }
  stored.serverUrl = baseUrl;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}
