/**
 * Registry of every key the app persists in localStorage
 * (settings-wiring-honesty). Every `localStorage.setItem`/`removeItem` in
 * web_ui/src names its key through an identifier imported from this module —
 * pinned by the AST guardrail in persisted-keys.test.ts — so Settings →
 * Clear Cache can never silently miss a newly added user setting.
 *
 * This module deliberately imports nothing: it is the leaf every storage
 * owner (contexts, profile, providers, pages) depends on.
 */

/** Inference mode blob: mode, browser engine, response-quality preset, provider connection (and, inside the desktop app only, the backend URL). */
export const INFERENCE_MODE_KEY = 'inference-mode';
/** Explicit light/dark theme ('system' is the absence of this key). */
export const THEME_PREFERENCE_KEY = 'theme-preference';
/**
 * LEGACY (PR #138) provider API key. Read once by the external-model
 * migration (lib/llm/external-migration.ts) and then removed; still cleared by
 * Clear Cache so a never-migrated profile cannot keep it.
 */
export const PROVIDER_API_KEY_KEY = 'openai-provider-apikey';
/**
 * External model connection (universal-provider-settings-overhaul):
 * {enabled, protocol, baseUrl, model, grounded, rememberKey} — NEVER the key.
 */
export const EXTERNAL_CONFIG_KEY = 'external-provider-config';
/**
 * External model API key. Browser app only: in localStorage only while
 * "Remember API key" is on, otherwise in sessionStorage under the same name.
 * The desktop app never stores it in the renderer (main-process secret store).
 */
export const EXTERNAL_API_KEY_KEY = 'external-provider-apikey';
/**
 * The origin (scheme://host:port) the external API key is bound to, kept in
 * the SAME storage as the key (it moves with "Remember API key"). The key is
 * sent only to this origin. '' = saved before any base URL (binds to the
 * first origin set). Browser app only.
 */
export const EXTERNAL_API_KEY_ORIGIN_KEY = 'external-provider-apikey-origin';
/** Sidebar open/closed state. */
export const SIDEBAR_OPEN_KEY = 'sidebarOpen';
/** Last course opened on the Training page. */
export const LAST_PACK_KEY = 'training.lastPackDir';
/** Furthest slide reached per course on the Training page: {[courseId]: 1-based position}. */
export const TRAINING_PROGRESS_KEY = 'training.progress';
/**
 * Browser app pack update channel opt-in {optIn, feedUrl?}
 * (browser-training-parity AC8; desktop keeps it in the profile's updates.json).
 */
export const PACK_UPDATES_STATE_KEY = 'pack-updates';

/** User settings: Clear Cache removes every one of these. */
export const USER_SETTING_KEYS: readonly string[] = [
  INFERENCE_MODE_KEY,
  THEME_PREFERENCE_KEY,
  PROVIDER_API_KEY_KEY,
  EXTERNAL_CONFIG_KEY,
  EXTERNAL_API_KEY_KEY,
  EXTERNAL_API_KEY_ORIGIN_KEY,
  SIDEBAR_OPEN_KEY,
  LAST_PACK_KEY,
  TRAINING_PROGRESS_KEY,
  PACK_UPDATES_STATE_KEY,
];

/** Session-scoped user settings (sessionStorage): Clear Cache removes these too. */
export const SESSION_SETTING_KEYS: readonly string[] = [EXTERNAL_API_KEY_KEY, EXTERNAL_API_KEY_ORIGIN_KEY];

/** Stable profile id that names this browser profile's storage namespace. */
export const PROFILE_KEY = 'doc-qa-profile-id';
/** Marker that the one-time orphan-namespace migration ran. */
export const MIGRATION_KEY = 'doc-qa-profile-migrated';
/** One-time "re-add your documents" notice flag (vector index version change). */
export const REINDEX_FLAG_KEY = 'rag-reindex-required';

/**
 * Internal bookkeeping, not user settings: Clear Cache keeps these. The
 * profile id and migration marker identify the (now emptied) storage
 * namespace, so the next session reuses it instead of minting an orphan.
 */
export const INTERNAL_KEYS: readonly string[] = [PROFILE_KEY, MIGRATION_KEY, REINDEX_FLAG_KEY];

/**
 * Remove every registered user setting from `storage`. Returns the keys that
 * were present (and are now gone). Storage failures (private mode, disabled
 * storage) are swallowed per key — there is nothing left to clear then.
 */
export function clearUserSettings(storage: Pick<Storage, 'getItem' | 'removeItem'> = localStorage): string[] {
  const removed: string[] = [];
  for (const key of USER_SETTING_KEYS) {
    try {
      if (storage.getItem(key) !== null) removed.push(key);
      storage.removeItem(key);
    } catch {
      /* storage unavailable — nothing persisted to clear */
    }
  }
  return removed;
}

/** Remove every session-scoped user setting (the session-only external API key). */
export function clearSessionSettings(storage: Pick<Storage, 'removeItem'> = sessionStorage): void {
  for (const key of SESSION_SETTING_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
}
