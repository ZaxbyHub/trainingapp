// External model configuration state for the desktop backend engine
// (universal-provider-settings-overhaul, AC7/AC10/AC12/AC14).
//
// Owns the `external.*` settings keyspace (validated BEFORE anything commits),
// the API key custody in the injected SecretStore, and the key-origin binding.
//
// Key storage (binding constraint I1): the raw key and its bound origin are
// SEPARATE SecretStore entries — `external-api-key` and
// `external-api-key-origin` — never one blob. Clearing the key deletes both.
// Binding rules (constraint I2):
//   - a key saved in a patch that also sets external.baseUrl binds to that
//     origin;
//   - a key saved alone while a base URL is configured binds to the CURRENT
//     origin;
//   - a key saved while no base URL is set binds to the first origin set
//     afterwards;
//   - a base URL change or a boot replay never deletes the key.
// Use: the key is sent only when the configured origin equals the bound
// origin (otherwise apiKeySet:false and nothing is sent); pointing back at
// the bound origin re-enables it.
// When the store cannot encrypt (set() throws), the key is kept in process
// memory for this session only (apiKeyPersisted:false) — never in a file.
import { validateEndpointUrl } from '../../security/endpoint-policy.js';
import type { SecretStore } from '../../security/secret-store.js';
import type { DnsLookup } from '../net/guarded-request.js';
import { originOf, type ExternalEndpointConfig, type ExternalProtocol } from './external-generator.js';

export const EXTERNAL_KEY_SECRET = 'external-api-key';
export const EXTERNAL_KEY_ORIGIN_SECRET = 'external-api-key-origin';

/** The settings keys this state owns (PUT /settings `external.*`). */
export const EXTERNAL_SETTING_KEYS = [
  'external.enabled',
  'external.protocol',
  'external.baseUrl',
  'external.model',
  'external.apiKey',
  'external.grounded',
] as const;

/** LlamaEngine `externalProvider` option (frozen by the trace harness). */
export interface ExternalProviderOptions {
  secretStore?: SecretStore;
  lookup?: DnsLookup;
  /** Build/installer airgap flag; TRAININGAPP_AIRGAP=1 (read at call time) can only tighten it. */
  airgap?: boolean;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/** Non-secret persisted snapshot (<profileDir>/external.json). */
export interface ExternalSnapshot {
  'external.enabled': boolean;
  'external.protocol': ExternalProtocol;
  'external.baseUrl': string;
  'external.model': string;
  'external.grounded': boolean;
}

interface Values {
  enabled: boolean;
  protocol: ExternalProtocol;
  baseUrl: string;
  model: string;
  grounded: boolean;
}

const MAX_MODEL_CHARS = 512;
const MAX_URL_CHARS = 2048;
const MAX_KEY_CHARS = 8192;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when `value` can be sent as an HTTP header value (the API key travels
 * as `Authorization: Bearer <key>` or `x-api-key: <key>`): no control
 * characters (CR/LF/NUL/TAB/DEL ...) and nothing outside Latin-1, which
 * node:http would reject with an untyped TypeError at request time.
 */
export function isHeaderSafeValue(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code > 0xff) return false;
  }
  return true;
}

/** Key-free refusal text for a key that cannot travel in a header. */
export const UNSENDABLE_KEY_MESSAGE =
  'the API key contains a character that cannot be sent in an HTTP header (a control character, a line break, or a character outside Latin-1); paste the key again';

/** In-memory store used when the host injects none (headless tools, tests). */
function memoryStore(): SecretStore {
  const data = new Map<string, string>();
  return {
    get: (name) => data.get(name) ?? null,
    set: (name, value) => {
      data.set(name, value);
    },
    delete: (name) => {
      data.delete(name);
    },
  };
}

export class ExternalProviderState {
  private values: Values = { enabled: false, protocol: 'openai', baseUrl: '', model: '', grounded: true };
  private readonly store: SecretStore;
  private readonly airgapOption: boolean | undefined;
  readonly lookup: DnsLookup | undefined;
  readonly firstByteTimeoutMs: number | undefined;
  readonly idleTimeoutMs: number | undefined;
  /** Session-only key + origin when secure storage refused (never written to disk). */
  private sessionKey: { key: string; origin: string | null } | null = null;

  constructor(options: ExternalProviderOptions = {}) {
    this.store = options.secretStore ?? memoryStore();
    this.airgapOption = options.airgap;
    this.lookup = options.lookup;
    this.firstByteTimeoutMs = options.firstByteTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
  }

  /** Airgap: the configured flag, tightened (never loosened) by TRAININGAPP_AIRGAP=1 at call time. */
  airgap(): boolean {
    return this.airgapOption === true || process.env.TRAININGAPP_AIRGAP === '1';
  }

  /** True while external generation replaces the local model. */
  active(): boolean {
    return this.values.enabled && this.values.baseUrl !== '' && this.values.model !== '';
  }

  grounded(): boolean {
    return this.values.grounded;
  }

  /** Validate an `external.*` patch against the CURRENT state. Commits nothing. */
  validate(patch: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const next: Values = { ...this.values };
    for (const [key, value] of Object.entries(patch)) {
      switch (key) {
        case 'external.enabled':
          if (typeof value !== 'boolean') errors.push(`${key}: expected a boolean`);
          else next.enabled = value;
          break;
        case 'external.protocol':
          if (value !== 'openai' && value !== 'anthropic') errors.push(`${key}: expected 'openai' or 'anthropic'`);
          else next.protocol = value;
          break;
        case 'external.baseUrl':
          if (typeof value !== 'string') {
            errors.push(`${key}: expected a string`);
          } else if (value.trim() !== '') {
            if (value.length > MAX_URL_CHARS) {
              errors.push(`${key}: too long`);
            } else {
              const verdict = validateEndpointUrl(value.trim(), { airgap: this.airgap() });
              if (!verdict.ok) errors.push(`${key}: ${verdict.message}`);
              else next.baseUrl = value.trim();
            }
          } else {
            next.baseUrl = '';
          }
          break;
        case 'external.model':
          if (typeof value !== 'string' || value.length > MAX_MODEL_CHARS || hasControlChars(value)) {
            errors.push(`${key}: expected a model id (text, at most ${MAX_MODEL_CHARS} characters)`);
          } else {
            next.model = value.trim();
          }
          break;
        case 'external.apiKey':
          if (typeof value !== 'string' || value.length > MAX_KEY_CHARS) {
            errors.push(`${key}: expected an API key (text, at most ${MAX_KEY_CHARS} characters)`);
          } else if (!isHeaderSafeValue(value)) {
            // Never echo the value: the message names the rule only.
            errors.push(`${key}: ${UNSENDABLE_KEY_MESSAGE}`);
          }
          break;
        case 'external.grounded':
          if (typeof value !== 'boolean') errors.push(`${key}: expected a boolean`);
          else next.grounded = value;
          break;
        default:
          errors.push(`${key}: unknown setting`);
      }
    }
    if (errors.length === 0 && next.enabled && (next.baseUrl === '' || next.model === '')) {
      errors.push('external.enabled: a base URL and a model are required to use an external model');
    }
    return errors;
  }

  /** Commit an already-validated patch. Never throws (secret-store failures degrade to session-only). */
  commit(patch: Record<string, unknown>): void {
    if (typeof patch['external.enabled'] === 'boolean') this.values.enabled = patch['external.enabled'];
    if (patch['external.protocol'] === 'openai' || patch['external.protocol'] === 'anthropic') {
      this.values.protocol = patch['external.protocol'];
    }
    if (typeof patch['external.model'] === 'string') this.values.model = patch['external.model'].trim();
    if (typeof patch['external.grounded'] === 'boolean') this.values.grounded = patch['external.grounded'];
    if (typeof patch['external.baseUrl'] === 'string') {
      this.values.baseUrl = patch['external.baseUrl'].trim();
      // A pending key (saved before any URL) binds to the first origin set.
      const origin = originOf(this.values.baseUrl);
      if (origin !== '' && this.storedKey() !== null && this.boundOrigin() === null) this.bindOrigin(origin);
    }
    if (typeof patch['external.apiKey'] === 'string') {
      const key = patch['external.apiKey'];
      if (key === '') this.clearKey();
      else this.saveKey(key, originOf(this.values.baseUrl));
    }
  }

  /** settings-wiring-honesty `reset` for external.* keys (validated by the caller). */
  reset(keys: string[]): void {
    for (const key of keys) {
      switch (key) {
        case 'external.apiKey':
          this.clearKey();
          break;
        case 'external.enabled':
          this.values.enabled = false;
          break;
        case 'external.protocol':
          this.values.protocol = 'openai';
          break;
        case 'external.baseUrl':
          this.values.baseUrl = '';
          this.values.enabled = false;
          break;
        case 'external.model':
          this.values.model = '';
          this.values.enabled = false;
          break;
        case 'external.grounded':
          this.values.grounded = true;
          break;
        default:
          break;
      }
    }
  }

  private storedKey(): string | null {
    if (this.sessionKey !== null) return this.sessionKey.key;
    try {
      return this.store.get(EXTERNAL_KEY_SECRET);
    } catch {
      return null;
    }
  }

  private boundOrigin(): string | null {
    if (this.sessionKey !== null) return this.sessionKey.origin;
    try {
      return this.store.get(EXTERNAL_KEY_ORIGIN_SECRET);
    } catch {
      return null;
    }
  }

  private bindOrigin(origin: string): void {
    if (this.sessionKey !== null) {
      this.sessionKey.origin = origin;
      return;
    }
    try {
      this.store.set(EXTERNAL_KEY_ORIGIN_SECRET, origin);
    } catch {
      // The key itself is in the store but the origin cannot be saved:
      // keep both for the session only.
      const key = this.storedKey();
      if (key !== null) this.sessionKey = { key, origin };
    }
  }

  private saveKey(key: string, origin: string): void {
    this.sessionKey = null;
    try {
      this.store.set(EXTERNAL_KEY_SECRET, key);
      if (origin !== '') this.store.set(EXTERNAL_KEY_ORIGIN_SECRET, origin);
      else this.store.delete(EXTERNAL_KEY_ORIGIN_SECRET);
    } catch {
      // Secure storage unavailable: never fall back to plaintext on disk.
      try {
        this.store.delete(EXTERNAL_KEY_SECRET);
        this.store.delete(EXTERNAL_KEY_ORIGIN_SECRET);
      } catch {
        /* nothing stored */
      }
      this.sessionKey = { key, origin: origin === '' ? null : origin };
    }
  }

  private clearKey(): void {
    this.sessionKey = null;
    try {
      this.store.delete(EXTERNAL_KEY_SECRET);
    } catch {
      /* already gone */
    }
    try {
      this.store.delete(EXTERNAL_KEY_ORIGIN_SECRET);
    } catch {
      /* already gone */
    }
  }

  /** The key to send to `baseUrl`'s origin, or null (none saved / bound elsewhere). */
  keyFor(baseUrl: string): string | null {
    const key = this.storedKey();
    if (key === null || key === '') return null;
    const bound = this.boundOrigin();
    const origin = originOf(baseUrl);
    return bound !== null && origin !== '' && bound === origin ? key : null;
  }

  /** Endpoint config for generation (key only when bound to this origin). */
  endpoint(): ExternalEndpointConfig {
    return {
      protocol: this.values.protocol,
      baseUrl: this.values.baseUrl,
      model: this.values.model,
      apiKey: this.keyFor(this.values.baseUrl),
    };
  }

  /** GET /settings fields — never the key. */
  responseFields(): Record<string, unknown> {
    return {
      'external.enabled': this.values.enabled,
      'external.protocol': this.values.protocol,
      'external.baseUrl': this.values.baseUrl,
      'external.model': this.values.model,
      'external.grounded': this.values.grounded,
      'external.apiKeySet': this.keyFor(this.values.baseUrl) !== null,
      'external.apiKeyPersisted': this.sessionKey === null,
      'external.apiKeyBoundOrigin': this.storedKey() !== null ? (this.boundOrigin() ?? '') : '',
      'external.airgap': this.airgap(),
    };
  }

  snapshot(): ExternalSnapshot {
    return {
      'external.enabled': this.values.enabled,
      'external.protocol': this.values.protocol,
      'external.baseUrl': this.values.baseUrl,
      'external.model': this.values.model,
      'external.grounded': this.values.grounded,
    };
  }

  /** Human-readable backend description for /stats (never the key). */
  describe(): string {
    return `external (${this.values.protocol}) model=${this.values.model} endpoint=${originOf(this.values.baseUrl)}`;
  }
}
