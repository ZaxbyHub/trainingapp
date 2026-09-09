// B4 inference profile selection (issue #62).
//
// Quality/Fast auto-selection from free RAM, plus the native thread default.
// The thread default is deliberately NOT the browser WASM cap —
// web_ui/src/lib/llm/wllama-service.ts:99-101 caps wllama at
// min(navigator.hardwareConcurrency, 4) because WASM threads are expensive;
// the native desktop path has no such constraint and follows the Python
// stack's default_gguf_threads() (config.py): min(cores, 8).

export type InferenceProfileName = 'quality' | 'fast';
export type ProfileSetting = InferenceProfileName | 'auto';

/** Free-RAM threshold (GiB) above which `auto` selects the Quality profile. */
export const DEFAULT_PROFILE_THRESHOLD_GB = 6;

const GIB = 1024 ** 3;

/**
 * Resolve the effective profile. `auto` picks quality when free RAM is at or
 * above the threshold (inclusive boundary); an explicit setting always wins.
 */
export function selectProfile(
  setting: ProfileSetting,
  freeBytes: number,
  thresholdGb: number = DEFAULT_PROFILE_THRESHOLD_GB,
): InferenceProfileName {
  if (setting === 'quality' || setting === 'fast') return setting;
  return freeBytes >= thresholdGb * GIB ? 'quality' : 'fast';
}

/**
 * Native thread-count default: min(cores, 8), clamped to >= 1. Explicitly
 * not the browser 4-cap — see the module comment.
 */
export function defaultThreadCount(logicalCores: number): number {
  return Math.min(Math.max(1, logicalCores), 8);
}
