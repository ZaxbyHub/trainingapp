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
 *     (the panel discloses "Stored in this browser").
 * Inside the desktop app the renderer NEVER stores the key: the desktop panel
 * sends it to the backend, which keeps it in the main-process secret store.
 *
 * Egress is off by default: no generator is constructed and nothing is
 * fetched until the config is enabled with a model and a base URL the shared
 * policy accepts (airgap builds refuse public hosts).
 */
import type { LLMService } from '../../types/llm';
import { isElectron } from '../desktop-session';
import { EXTERNAL_API_KEY_KEY, EXTERNAL_CONFIG_KEY } from '../storage/persisted-keys';
import { AnthropicCompatChatService, listAnthropicModels } from './anthropic-provider';
import { validateEndpointUrl } from './endpoint-policy';
import { OpenAICompatChatService, listOpenAIModels } from './openai-provider';
import { asProviderError, modelError, scrubSecrets, type ProviderFailureKind } from './provider-error';

export { ProviderError, scrubSecrets } from './provider-error';
export type { ProviderFailureKind } from './provider-error';

export type ExternalProtocol = 'openai' | 'anthropic';

export interface ExternalConfig {
  enabled: boolean;
  protocol: ExternalProtocol;
  baseUrl: string;
  model: string;
  /** Browser app only ('' inside the desktop app and when unset). */
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

type StoredConfig = Omit<ExternalConfig, 'apiKey'>;

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

function safeGet(storage: () => Storage, key: string): string {
  try {
    return storage().getItem(key) ?? '';
  } catch {
    return '';
  }
}

function safeRemoveSession(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function safeSetSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the key stays only in the form */
  }
}

/** Load the persisted external-model configuration (defaults when unset). */
export function loadExternalConfig(): ExternalConfig {
  const stored = readStored();
  let apiKey = '';
  if (!isElectron()) {
    apiKey = stored.rememberKey ? safeGet(() => localStorage, EXTERNAL_API_KEY_KEY) : safeGet(() => sessionStorage, EXTERNAL_API_KEY_KEY);
  }
  return { ...stored, apiKey };
}

/**
 * Persist a partial update. The key goes only where the custody rules allow:
 * nowhere inside the desktop app; localStorage only while rememberKey is on;
 * sessionStorage otherwise. Turning rememberKey off moves the key out of
 * localStorage.
 */
export function saveExternalConfig(patch: Partial<ExternalConfig>): void {
  const prev = readStored();
  const prevKey = isElectron() ? '' : loadExternalConfig().apiKey;
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
    // Desktop custody: the renderer never holds the key.
    try {
      localStorage.removeItem(EXTERNAL_API_KEY_KEY);
    } catch {
      /* storage unavailable */
    }
    safeRemoveSession(EXTERNAL_API_KEY_KEY);
    return;
  }
  const key = patch.apiKey ?? prevKey;
  if (next.rememberKey && key !== '') {
    try {
      localStorage.setItem(EXTERNAL_API_KEY_KEY, key);
    } catch {
      /* storage unavailable */
    }
    safeRemoveSession(EXTERNAL_API_KEY_KEY);
  } else {
    try {
      localStorage.removeItem(EXTERNAL_API_KEY_KEY);
    } catch {
      /* storage unavailable */
    }
    if (key !== '') safeSetSession(EXTERNAL_API_KEY_KEY, key);
    else safeRemoveSession(EXTERNAL_API_KEY_KEY);
  }
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
