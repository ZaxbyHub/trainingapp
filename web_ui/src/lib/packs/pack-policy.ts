// pack-policy.ts — build-time pack trust policy for the browser app, trace
// browser-training-parity AC2/AC8.
//
// Same names and semantics as the desktop TRAININGAPP_PACKS_* environment
// (desktop/main/backend/packs/pack-extract.ts resolvePacksSecurity), baked at
// BUILD time through Vite (`import.meta.env.VITE_*` is inlined into the
// bundle): a runtime-editable trust anchor would itself be the vulnerability,
// so nothing here reads storage, the URL, or any runtime file.
//   VITE_TRAININGAPP_PACKS_REQUIRE_SIGNATURE   '1' | 'true' -> require a signature
//   VITE_TRAININGAPP_PACKS_TRUSTED_KEYS        JSON [{key_id, public_key}] (base64 DER SPKI)
//   VITE_TRAININGAPP_PACKS_EMBEDDING_MODEL_ID  embedding-model pin (default bge-small-en-v1.5)
//   VITE_TRAININGAPP_UPDATE_TRUSTED_KEYS       JSON TrustedKey[] for the update feed
//                                              (default: the desktop baked feed key)
import { DEFAULT_PACK_EMBEDDING_MODEL_ID, type ManifestGateConfig } from './pack-manifest';
import type { TrustedPackKey } from './pack-verify';

/** Desktop UPDATE_FEED_PUBLIC_KEY (desktop/main/update-checker.ts), the default feed anchor. */
export const UPDATE_FEED_PUBLIC_KEY: TrustedPackKey = {
  key_id: 'trainingapp-update-feed-2026-09',
  public_key: 'MCowBQYDK2VwAyEADMDkiyQsDNMPSdRlmNxr+dePysmqGTFGyG6EkF9yvXQ=',
};

/** Desktop envBool: '1' or 'true' (trimmed, case-insensitive) enable; anything else is off. */
export function parseBoolFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Desktop envTrustedKeys: a JSON array of {key_id, public_key}; malformed
 * input trusts NOTHING (fail closed), entries without both strings are dropped.
 */
export function parseTrustedKeys(raw: string | undefined): TrustedPackKey[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is { key_id: string; public_key: string } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as Record<string, unknown>)['key_id'] === 'string' &&
          typeof (entry as Record<string, unknown>)['public_key'] === 'string',
      )
      .map((entry) => ({ key_id: entry.key_id, public_key: entry.public_key }));
  } catch {
    return [];
  }
}

const env = import.meta.env as Record<string, string | undefined>;

/** The pack install gate configuration baked into this build. */
export function packGateConfig(): ManifestGateConfig {
  return {
    requireSignature: parseBoolFlag(env.VITE_TRAININGAPP_PACKS_REQUIRE_SIGNATURE),
    trustedKeys: parseTrustedKeys(env.VITE_TRAININGAPP_PACKS_TRUSTED_KEYS),
    embeddingModelId: env.VITE_TRAININGAPP_PACKS_EMBEDDING_MODEL_ID?.trim() || DEFAULT_PACK_EMBEDDING_MODEL_ID,
  };
}

/** The update-feed trust anchor baked into this build (defaults to the desktop key). */
export function updateFeedTrustedKeys(): TrustedPackKey[] {
  const raw = env.VITE_TRAININGAPP_UPDATE_TRUSTED_KEYS;
  if (raw === undefined || raw.trim().length === 0) return [UPDATE_FEED_PUBLIC_KEY];
  return parseTrustedKeys(raw);
}
