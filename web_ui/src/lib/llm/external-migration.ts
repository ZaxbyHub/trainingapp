/**
 * One-time migration of PR #138's "Provider server (OpenAI-compatible)" mode
 * into the external-model configuration (universal-provider-settings-overhaul).
 *
 * #138 stored `inference-mode.mode === 'provider'`, the connection under
 * `inference-mode.providerConfig = {baseUrl, model}` and the key in
 * localStorage['openai-provider-apikey']. That mode is retired: the External
 * model region's "Use external model" switch is the single control now.
 *
 *   Browser app: migrateLegacyProviderBlob() runs while the inference-mode
 *     blob is loaded. Legacy provider state becomes `external-provider-config`
 *     {enabled: <was provider mode>, protocol 'openai', baseUrl, model,
 *     grounded: false (#138 was ungrounded direct chat), rememberKey: true}
 *     plus the key under `external-provider-apikey`, bound to the migrated
 *     base URL's origin (`external-provider-apikey-origin`); the mode becomes
 *     browser-local and the legacy fields/key are deleted. An existing
 *     external configuration is never overwritten.
 *   Desktop app: desktop-seed moves a stored 'provider' mode to 'api' (the
 *     backend owns generation) and marks the blob; once the desktop session
 *     exists, migrateLegacyProviderToDesktop() PUTs the legacy connection
 *     (+ key) into the backend's external.* settings, then deletes the legacy
 *     renderer state. A transient failure (backend unreachable) keeps the
 *     legacy state for the next launch; a refusal (4xx) drops it.
 */
import type { ApiClient } from '../api';
import { ApiError } from '../api/types';
import { isElectron } from '../desktop-session';
import {
  EXTERNAL_API_KEY_KEY,
  EXTERNAL_API_KEY_ORIGIN_KEY,
  EXTERNAL_CONFIG_KEY,
  INFERENCE_MODE_KEY,
  PROVIDER_API_KEY_KEY,
} from '../storage/persisted-keys';
import { keyOriginOf } from './key-origin';

/**
 * Browser app, boot migration (review round 2 ruling e): a key saved by an
 * earlier build of this branch without a bound origin is bound to the stored
 * base URL's origin, or DROPPED when there is no usable base URL (it cannot be
 * attributed to an endpoint, so it is never sent). Runs from the inference-mode
 * boot path next to the PR #138 migration and at the start of every
 * saveExternalConfig(); reads in external-provider.ts evaluate the same rule
 * without writing, so render stays pure.
 */
export function migrateUnboundExternalKey(): void {
  if (isElectron()) return;
  let baseUrl = '';
  let remember = false;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(EXTERNAL_CONFIG_KEY) ?? '{}');
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const cfg = raw as { baseUrl?: unknown; rememberKey?: unknown };
      baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '';
      remember = cfg.rememberKey === true;
    }
  } catch {
    /* unreadable config: treated as no base URL */
  }
  try {
    const storage = remember ? localStorage : sessionStorage;
    const key = storage.getItem(EXTERNAL_API_KEY_KEY) ?? '';
    if (key === '' || storage.getItem(EXTERNAL_API_KEY_ORIGIN_KEY) !== null) return;
    const origin = keyOriginOf(baseUrl);
    if (origin !== '') {
      if (remember) localStorage.setItem(EXTERNAL_API_KEY_ORIGIN_KEY, origin);
      else sessionStorage.setItem(EXTERNAL_API_KEY_ORIGIN_KEY, origin);
      return;
    }
    localStorage.removeItem(EXTERNAL_API_KEY_KEY);
    localStorage.removeItem(EXTERNAL_API_KEY_ORIGIN_KEY);
    sessionStorage.removeItem(EXTERNAL_API_KEY_KEY);
    sessionStorage.removeItem(EXTERNAL_API_KEY_ORIGIN_KEY);
  } catch {
    /* storage unavailable: nothing persisted to migrate */
  }
}

/** Blob marker desktop-seed sets when it moved a stored 'provider' mode to 'api'. */
export const LEGACY_PROVIDER_MARKER = 'legacyProviderMode';

interface LegacyProviderConfig {
  baseUrl: string;
  model: string;
}

function legacyConfigOf(blob: Record<string, unknown>): LegacyProviderConfig | null {
  const raw = blob.providerConfig;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cfg = raw as { baseUrl?: unknown; model?: unknown };
  return {
    baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
    model: typeof cfg.model === 'string' ? cfg.model : '',
  };
}

function readLegacyKey(): string {
  try {
    return localStorage.getItem(PROVIDER_API_KEY_KEY) ?? '';
  } catch {
    return '';
  }
}

function removeLegacyKey(): void {
  try {
    localStorage.removeItem(PROVIDER_API_KEY_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Browser app: rewrite a legacy #138 blob in place (and persist it). Returns
 * the migrated blob; a blob without legacy provider state is returned as is.
 */
export function migrateLegacyProviderBlob(blob: Record<string, unknown>): Record<string, unknown> {
  const legacy = legacyConfigOf(blob);
  const wasProvider = blob.mode === 'provider';
  if (!wasProvider && legacy === null && readLegacyKey() === '') return blob;
  const key = readLegacyKey();
  let hasExternal = false;
  try {
    hasExternal = localStorage.getItem(EXTERNAL_CONFIG_KEY) !== null;
  } catch {
    hasExternal = false;
  }
  if (!hasExternal && legacy !== null && legacy.baseUrl.trim() !== '') {
    try {
      localStorage.setItem(
        EXTERNAL_CONFIG_KEY,
        JSON.stringify({
          enabled: wasProvider,
          protocol: 'openai',
          baseUrl: legacy.baseUrl,
          model: legacy.model,
          grounded: false,
          rememberKey: true,
        }),
      );
      // The migrated key is bound to the migrated base URL's origin (key-origin
      // binding); a base URL without an http(s) origin gets no key at all.
      const origin = keyOriginOf(legacy.baseUrl);
      if (key !== '' && origin !== '') {
        localStorage.setItem(EXTERNAL_API_KEY_ORIGIN_KEY, origin);
        localStorage.setItem(EXTERNAL_API_KEY_KEY, key);
      }
    } catch {
      /* storage unavailable — the legacy state is dropped below regardless */
    }
  }
  const migrated: Record<string, unknown> = { ...blob };
  if (wasProvider) migrated.mode = 'browser-local';
  delete migrated.providerConfig;
  delete migrated[LEGACY_PROVIDER_MARKER];
  try {
    localStorage.setItem(INFERENCE_MODE_KEY, JSON.stringify(migrated));
  } catch {
    /* storage unavailable — the in-memory state is still migrated */
  }
  removeLegacyKey();
  return migrated;
}

function readBlob(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(INFERENCE_MODE_KEY) ?? '{}');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return {};
}

function scrubDesktopLegacy(): void {
  const blob = readBlob();
  delete blob.providerConfig;
  delete blob[LEGACY_PROVIDER_MARKER];
  try {
    localStorage.setItem(INFERENCE_MODE_KEY, JSON.stringify(blob));
  } catch {
    /* storage unavailable */
  }
  removeLegacyKey();
  // #138 never wrote these in the desktop app, but a renderer key must never
  // linger there either way (AC7).
  try {
    localStorage.removeItem(EXTERNAL_API_KEY_KEY);
    localStorage.removeItem(EXTERNAL_API_KEY_ORIGIN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Desktop app: move legacy #138 provider state into the backend's external.*
 * settings. Resolves true when something was migrated.
 */
export async function migrateLegacyProviderToDesktop(apiClient: Pick<ApiClient, 'updateSettings'>): Promise<boolean> {
  const blob = readBlob();
  const legacy = legacyConfigOf(blob);
  const key = readLegacyKey();
  if (legacy === null || legacy.baseUrl.trim() === '') {
    if (key !== '' || blob[LEGACY_PROVIDER_MARKER] !== undefined) scrubDesktopLegacy();
    return false;
  }
  const patch: Record<string, unknown> = {
    'external.enabled': blob[LEGACY_PROVIDER_MARKER] === true,
    'external.protocol': 'openai',
    'external.baseUrl': legacy.baseUrl,
    'external.model': legacy.model,
    'external.grounded': false,
  };
  if (key !== '') patch['external.apiKey'] = key;
  try {
    await apiClient.updateSettings(patch);
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      console.warn('[external-migration] the desktop backend refused the legacy provider settings; dropping them', err.detail);
      scrubDesktopLegacy();
    }
    return false;
  }
  scrubDesktopLegacy();
  return true;
}
