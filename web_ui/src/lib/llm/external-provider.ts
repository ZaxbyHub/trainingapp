/**
 * External model configuration, generator factory and connection probe for
 * the browser app (universal-provider-settings-overhaul, AC3/AC4/AC7/AC10/
 * AC11/AC13).
 *
 * Persistence (keys registered in lib/storage/persisted-keys.ts):
 *   localStorage['external-provider-config'] = JSON
 *     { enabled, protocol: 'openai' | 'anthropic', baseUrl, model,
 *       grounded (default true), rememberKey }       — never the key;
 *   the API key, browser app only: localStorage['external-provider-apikey']
 *     while rememberKey is true, otherwise sessionStorage under the same name
 *     (the panel discloses "Stored in this browser");
 *   the key's bound origin, browser app only:
 *     ['external-provider-apikey-origin'] in the SAME storage as the key.
 * Inside the desktop app the renderer NEVER stores the key: the desktop panel
 * sends it to the backend, which keeps it in the main-process secret store.
 *
 * Key-origin binding (review round 1 F2; parity with the desktop backend's
 * ExternalProviderState, ADR-0011 decision 3). The key is sent ONLY to the
 * origin (scheme://host:port, normalized by keyOriginOf) it was saved for:
 *   - a key entered in a save binds to the origin of the base URL in effect
 *     after that save; the Settings panel always sends the key TOGETHER with
 *     the base URL shown (one save) and never saves a key while the shown URL
 *     is empty or refused, so re-entering the key is what (re)binds it, and
 *     only to the URL it was typed for;
 *   - a key saved with no base URL at all is pending ('') and binds only when
 *     a later save carries a base URL (patch.baseUrl), never on a save of
 *     another field (parity with the desktop ExternalProviderState.commit);
 *   - changing, clearing or resetting the base URL NEVER rebinds or deletes
 *     the key; pointing back at the bound origin uses it again;
 *   - loadExternalConfig().apiKey / keyForBaseUrl() return the key only for
 *     the bound origin, so the generators and the connection test never
 *     receive it for another origin (loadExternalKeyState() reports the
 *     mismatch for the panel);
 *   - migration: a key stored by an earlier build (no origin entry) binds to
 *     the stored base URL's origin when there is one; otherwise it is DROPPED
 *     (it cannot be attributed to any endpoint, so it is never sent). The
 *     write happens in migrateUnboundExternalKey() (boot migration path and
 *     every save); reads are pure and evaluate the same rule without writing.
 *
 * Egress is off by default: no generator is constructed and nothing is
 * fetched until the config is enabled with a model and a base URL the shared
 * policy accepts (airgap builds refuse public hosts).
 */
import type { LLMService } from '../../types/llm';
import { isElectron } from '../desktop-session';
import { EXTERNAL_API_KEY_KEY, EXTERNAL_API_KEY_ORIGIN_KEY, EXTERNAL_CONFIG_KEY } from '../storage/persisted-keys';
import { AnthropicCompatChatService, listAnthropicModels } from './anthropic-provider';
import { validateEndpointUrl } from './endpoint-policy';
import { migrateUnboundExternalKey } from './external-migration';
import { keyOriginOf } from './key-origin';
import { OpenAICompatChatService, listOpenAIModels } from './openai-provider';
import { asProviderError, modelError, scrubSecrets, type ProviderFailureKind } from './provider-error';

export { ProviderError, scrubSecrets } from './provider-error';
export type { ProviderFailureKind } from './provider-error';
export { keyOriginOf } from './key-origin';
export { migrateUnboundExternalKey } from './external-migration';

export type ExternalProtocol = 'openai' | 'anthropic';

export interface ExternalConfig {
  enabled: boolean;
  protocol: ExternalProtocol;
  baseUrl: string;
  model: string;
  /**
   * Browser app only ('' inside the desktop app and when unset). From
   * loadExternalConfig() it is the saved key ONLY when it is bound to
   * `baseUrl`'s origin; '' otherwise.
   */
  apiKey: string;
  rememberKey: boolean;
  /** true (default) = answers go through retrieval; false = ungrounded Direct chat. */
  grounded: boolean;
}

export const DEFAULT_EXTERNAL_CONFIG: ExternalConfig = {
  enabled: false,
  protocol: 'openai',
  baseUrl: '',
  model: '',
  apiKey: '',
  rememberKey: false,
  grounded: true,
};

/** Where the saved key stands relative to a base URL (the panel's typed state). */
export type ExternalKeyState =
  | { status: 'none' }
  /** Saved before any base URL; binds to the first origin set. */
  | { status: 'pending' }
  /** Bound to this base URL's origin: it is sent. */
  | { status: 'bound'; origin: string }
  /** Bound to another origin: NOT sent here until it is re-entered. */
  | { status: 'mismatch'; boundOrigin: string; currentOrigin: string };

type StoredConfig = Omit<ExternalConfig, 'apiKey'>;

/** Raw saved key and binding: origin null = no origin entry (legacy). */
interface KeyRecord {
  key: string;
  origin: string | null;
}

function readStored(): StoredConfig {
  let parsed: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(EXTERNAL_CONFIG_KEY) ?? '{}');
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    enabled: parsed.enabled === true,
    protocol: parsed.protocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
    model: typeof parsed.model === 'string' ? parsed.model : '',
    rememberKey: parsed.rememberKey === true,
    // Direct chat is never the silent default: only an explicit false opts out.
    grounded: parsed.grounded !== false,
  };
}

/**
 * Read one key-record entry from the storage the Remember rule selects (null
 * when unset or when storage is unavailable). It branches per call instead of
 * handing a Storage object around, so the persisted-keys guardrail (PR #140
 * review FB140-009: a bare storage reference is a violation) sees every
 * localStorage use as a member call.
 */
function readKeyEntry(remember: boolean, name: string): string | null {
  try {
    return (remember ? localStorage.getItem(name) : sessionStorage.getItem(name)) ?? null;
  } catch {
    return null;
  }
}

/** Remove the key and its origin from BOTH storages. */
function removeKeyEverywhere(): void {
  try {
    localStorage.removeItem(EXTERNAL_API_KEY_KEY);
    localStorage.removeItem(EXTERNAL_API_KEY_ORIGIN_KEY);
  } catch {
    /* storage unavailable */
  }
  try {
    sessionStorage.removeItem(EXTERNAL_API_KEY_KEY);
    sessionStorage.removeItem(EXTERNAL_API_KEY_ORIGIN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Write the key and its origin to the storage the Remember rule selects. The
 * old key and origin are removed from BOTH storages first, then the origin is
 * written, then the key: a storage failure part-way can leave no key (or an
 * origin without a key), never an old key next to a new origin, and never a
 * key without its origin (which would read as a legacy, unbound key). An
 * empty key just removes both everywhere.
 */
function writeKeyRecord(rec: KeyRecord, remember: boolean): void {
  removeKeyEverywhere();
  if (rec.key === '') return;
  const origin = rec.origin ?? '';
  try {
    if (remember) {
      localStorage.setItem(EXTERNAL_API_KEY_ORIGIN_KEY, origin);
      localStorage.setItem(EXTERNAL_API_KEY_KEY, rec.key);
    } else {
      sessionStorage.setItem(EXTERNAL_API_KEY_ORIGIN_KEY, origin);
      sessionStorage.setItem(EXTERNAL_API_KEY_KEY, rec.key);
    }
  } catch {
    /* storage unavailable — the key stays only in the form */
  }
}

/**
 * The saved key and its binding (browser app only). PURE (no storage
 * writes; safe in render): a key saved by an earlier build without an origin
 * entry is evaluated as migrateUnboundExternalKey() would persist it (bound
 * to the stored base URL's origin, or no key when there is none).
 */
function readKeyRecord(stored: StoredConfig): KeyRecord {
  const key = readKeyEntry(stored.rememberKey, EXTERNAL_API_KEY_KEY) ?? '';
  if (key === '') return { key: '', origin: null };
  const origin = readKeyEntry(stored.rememberKey, EXTERNAL_API_KEY_ORIGIN_KEY);
  if (origin !== null) return { key, origin };
  const migrated = keyOriginOf(stored.baseUrl);
  return migrated === '' ? { key: '', origin: null } : { key, origin: migrated };
}

/**
 * THE key-origin comparison (the only place it is made): the saved key, but
 * only when it is bound to `baseUrl`'s origin; '' otherwise.
 */
function boundKeyFor(rec: KeyRecord, baseUrl: string): string {
  if (rec.key === '' || rec.origin === null || rec.origin === '') return '';
  const origin = keyOriginOf(baseUrl);
  return origin !== '' && origin === rec.origin ? rec.key : '';
}

/**
 * The saved key to send to `baseUrl`, or '' (none saved, pending, bound to
 * another origin, or inside the desktop app).
 */
export function keyForBaseUrl(baseUrl: string): string {
  if (isElectron()) return '';
  return boundKeyFor(readKeyRecord(readStored()), baseUrl);
}

/** Where the saved key stands relative to `baseUrl` (default: the stored base URL). */
export function loadExternalKeyState(baseUrl?: string): ExternalKeyState {
  if (isElectron()) return { status: 'none' };
  const stored = readStored();
  const rec = readKeyRecord(stored);
  if (rec.key === '') return { status: 'none' };
  if (rec.origin === null || rec.origin === '') return { status: 'pending' };
  const url = baseUrl ?? stored.baseUrl;
  if (boundKeyFor(rec, url) !== '') return { status: 'bound', origin: rec.origin };
  return { status: 'mismatch', boundOrigin: rec.origin, currentOrigin: keyOriginOf(url) };
}

/** Load the persisted external-model configuration (defaults when unset). */
export function loadExternalConfig(): ExternalConfig {
  const stored = readStored();
  const apiKey = isElectron() ? '' : boundKeyFor(readKeyRecord(stored), stored.baseUrl);
  return { ...stored, apiKey };
}

/**
 * Persist a partial update. The key goes only where the custody rules allow:
 * nowhere inside the desktop app; localStorage only while rememberKey is on;
 * sessionStorage otherwise; its bound origin travels with it. Turning
 * rememberKey off moves both out of localStorage.
 *
 * `patch.apiKey` is a (re-)entry: a non-empty value binds to the origin of
 * the base URL in effect after this save (send `baseUrl` in the same patch to
 * bind to the URL the key was typed for); '' clears the key. Without
 * `patch.apiKey` the saved key keeps its binding, whatever the base URL
 * becomes; a pending key (saved with no base URL) binds only when this patch
 * carries a base URL.
 */
export function saveExternalConfig(patch: Partial<ExternalConfig>): void {
  migrateUnboundExternalKey();
  const prev = readStored();
  const prevRec: KeyRecord = isElectron() ? { key: '', origin: null } : readKeyRecord(prev);
  const next: StoredConfig = {
    enabled: patch.enabled ?? prev.enabled,
    protocol: patch.protocol ?? prev.protocol,
    baseUrl: patch.baseUrl ?? prev.baseUrl,
    model: patch.model ?? prev.model,
    rememberKey: patch.rememberKey ?? prev.rememberKey,
    grounded: patch.grounded ?? prev.grounded,
  };
  try {
    localStorage.setItem(EXTERNAL_CONFIG_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — settings stay in memory for this view */
  }
  if (isElectron()) {
    // Desktop custody: the renderer never holds the key (nor its binding).
    removeKeyEverywhere();
    return;
  }
  let rec: KeyRecord = prevRec;
  if (patch.apiKey !== undefined) {
    rec = patch.apiKey === '' ? { key: '', origin: null } : { key: patch.apiKey, origin: keyOriginOf(next.baseUrl) };
  } else if (rec.key !== '' && rec.origin === '' && patch.baseUrl !== undefined) {
    // A pending key binds only to a base URL saved explicitly (not to one
    // already stored when some other field is saved).
    const first = keyOriginOf(patch.baseUrl);
    if (first !== '') rec = { key: rec.key, origin: first };
  }
  writeKeyRecord(rec, next.rememberKey);
}

/** True when the browser app would answer through an external endpoint. */
export function isExternalActive(cfg: ExternalConfig): boolean {
  return cfg.enabled && cfg.model.trim() !== '' && validateEndpointUrl(cfg.baseUrl).ok;
}

/**
 * Construct the generator for a config, or null when egress is not enabled
 * (disabled, no model, or a base URL the policy refuses — including public
 * hosts in airgap builds). Never throws and never touches the network.
 */
export function createExternalLLMService(cfg: ExternalConfig): LLMService | null {
  if (!isExternalActive(cfg)) return null;
  const opts = { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey };
  return cfg.protocol === 'anthropic' ? new AnthropicCompatChatService(opts) : new OpenAICompatChatService(opts);
}

export interface ProbeResult {
  ok: boolean;
  kind?: ProviderFailureKind;
  message: string;
  models?: string[];
}

/**
 * Connection test for the browser panel: list the endpoint's models and check
 * the chosen model is among them. Classified like chat failures (auth / model
 * / network / timeout), never containing the key. Uses the same policy,
 * redirect refusal and timeouts as generation and persists nothing.
 */
export async function probeExternalEndpoint(
  cfg: { protocol: ExternalProtocol; baseUrl: string; model: string; apiKey?: string },
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<ProbeResult> {
  const verdict = validateEndpointUrl(cfg.baseUrl);
  if (!verdict.ok) return { ok: false, kind: 'other', message: verdict.message };
  const listOpts = { timeoutMs: opts?.timeoutMs ?? 15_000, signal: opts?.signal, model: cfg.model };
  let models: string[];
  try {
    models =
      cfg.protocol === 'anthropic'
        ? await listAnthropicModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }, listOpts)
        : await listOpenAIModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }, listOpts);
  } catch (err) {
    const e = asProviderError(err, { origin: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey });
    return { ok: false, kind: e.kind, message: scrubSecrets(e.message, cfg.apiKey) };
  }
  const model = cfg.model.trim();
  if (model !== '' && !models.includes(model)) {
    let origin = cfg.baseUrl;
    try {
      origin = new URL(cfg.baseUrl).origin;
    } catch {
      /* validated above */
    }
    const e = modelError({ origin, model, apiKey: cfg.apiKey });
    return { ok: false, kind: 'model', message: e.message, models };
  }
  return {
    ok: true,
    message:
      model === ''
        ? `Connected: ${models.length} model${models.length === 1 ? '' : 's'} available. Choose one.`
        : `Connected: ${model} is available.`,
    models,
  };
}
