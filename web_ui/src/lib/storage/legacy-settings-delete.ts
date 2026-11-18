/**
 * deleteLegacySettingsStore — issue #367 (WI6 residual / plan RC4-02):
 * the abandoned legacy settings database `doc-qa-settings` (written by
 * pre-#317-era builds with plaintext serverUrl/theme/model; the current app
 * never reads it) is deleted at EVERY boot — unconditionally, no
 * done-marker: an absent store makes deleteDatabase a cheap no-op, and
 * every-boot execution also covers a database a rolled-back build
 * recreated. Failure is non-fatal (onerror/onblocked are logged as counts
 * and the next boot retries). Called from main.tsx in BOTH runtimes
 * (browser + Electron renderer — same bundle, same origin store), after the
 * profile prefix exists and never blocking mount.
 */

/** The legacy database name (historical; SettingsPage's Clear Cache also
 *  deletes it as one of its stores — this constant mirrors that literal). */
export const LEGACY_SETTINGS_DB_NAME = 'doc-qa-settings';

/** Boot-time delete attempt result (for the boot-delete pin tests). */
export interface LegacySettingsDeleteAttempt {
  requested: boolean;
  outcome: 'requested' | 'unavailable';
}

/** Fire the unconditional every-boot delete. Never throws. */
export function deleteLegacySettingsStore(): LegacySettingsDeleteAttempt {
  try {
    if (typeof indexedDB === 'undefined') return { requested: false, outcome: 'unavailable' };
    const deleteRequest = indexedDB.deleteDatabase(LEGACY_SETTINGS_DB_NAME);
    deleteRequest.onerror = () => {
      console.warn('[boot] legacy doc-qa-settings delete failed (retries next boot)');
    };
    deleteRequest.onblocked = () => {
      console.warn('[boot] legacy doc-qa-settings delete blocked (retries next boot)');
    };
    return { requested: true, outcome: 'requested' };
  } catch {
    // Non-fatal: the delete retries on the next boot.
    return { requested: false, outcome: 'unavailable' };
  }
}
