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
// The Settings panel (both apps, review round 2 R2-F1) never relies on the
// key-alone form: it PUTs a typed key only together with the base URL shown
// (one patch, so a refused URL commits neither) and holds the key while the
// shown URL is empty or refused. The key-alone form stays as the approved API
// contract (I2) for callers that address the configured endpoint.
// Use: the key is sent only when the configured origin equals the bound
// origin (otherwise apiKeySet:false and nothing is sent); pointing back at
// the bound origin re-enables it.
// When the store cannot encrypt (set() throws), the key is kept in process
// memory for this session only (apiKeyPersisted:false) — never in a file.
// Rollback (PR #142 rebase RB-001): captureState()/restoreState() cover the
// values, the session key AND the two SecretStore entries, so a settings save
// that fails after the key was written or deleted is undone. A SecretStore
// delete that fails is surfaced (thrown), never swallowed (F-014): the caller
// rolls back and answers 500 instead of reporting a key as cleared while it
// is still on disk.
// Binding integrity (PR #142 Stage B RB-001): saving a key deletes the old
// key, then writes the origin, then writes the key, so no sequence of partial
// failures stores a key next to an origin it was not entered for. If the
// rollback's own SecretStore write fails, the stored key is not used at all
// (fail closed) until a key is saved or cleared successfully.
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
  /** Aggregate deadline of one connection test (default PROBE_TOTAL_TIMEOUT_MS). */
  probeTimeoutMs?: number;
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

/**
 * ExternalProviderState.captureState() snapshot (PR #142 rebase RB-001). It
 * holds the plaintext key while a settings request is in flight (the
 * SecretStore already caches it in memory); it is never serialized.
 */
export interface ExternalProviderSettingsState {
  readonly values: Readonly<Values>;
  readonly sessionKey: { readonly key: string; readonly origin: string | null } | null;
  /** The SecretStore entries; null when the store could not be read (restore then leaves it alone). */
  readonly secrets: { readonly key: string | null; readonly origin: string | null } | null;
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
  readonly probeTimeoutMs: number | undefined;
  /** Session-only key + origin when secure storage refused (never written to disk). */
  private sessionKey: { key: string; origin: string | null } | null = null;
  /**
   * True after restoreState() failed to write the SecretStore back (Stage B
   * RB-001): the stored key and origin may not be one consistent pair, so the
   * stored key is not used until saveKey()/clearKey() succeeds. Deliberately
   * outside captureState()/restoreState(): a snapshot never clears it.
   */
  private storeUntrusted = false;

  constructor(options: ExternalProviderOptions = {}) {
    this.store = options.secretStore ?? memoryStore();
    this.airgapOption = options.airgap;
    this.lookup = options.lookup;
    this.firstByteTimeoutMs = options.firstByteTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.probeTimeoutMs = options.probeTimeoutMs;
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

  /**
   * Commit an already-validated patch. A key the store cannot encrypt
   * degrades to session-only; a SecretStore delete that fails (clearing the
   * key, or removing an older key behind a session-only one) THROWS — the
   * caller restores a captureState() snapshot and reports the failure.
   */
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
    // Fail closed after a rollback whose SecretStore write threw.
    if (this.storeUntrusted) return null;
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

  /**
   * Store `key` bound to `origin`. Write order (PR #142 Stage B RB-001):
   * delete the old key, THEN write (or delete) the origin, THEN write the new
   * key. A failure at any step therefore leaves either no key at all or a
   * key next to the origin it was entered for — never the new key next to
   * the old origin (which the old key-first order could leave behind when
   * the origin write, the fallback delete and the rollback all failed).
   */
  private saveKey(key: string, origin: string): void {
    this.sessionKey = null;
    try {
      this.store.delete(EXTERNAL_KEY_SECRET);
      if (origin !== '') this.store.set(EXTERNAL_KEY_ORIGIN_SECRET, origin);
      else this.store.delete(EXTERNAL_KEY_ORIGIN_SECRET);
      this.store.set(EXTERNAL_KEY_SECRET, key);
    } catch {
      // Secure storage unavailable: never fall back to plaintext on disk.
      // Remove what is stored so an OLDER key cannot resurface at the next
      // start behind this session-only one. If even that fails, it throws
      // (F-014): the caller rolls back rather than report a saved key.
      this.store.delete(EXTERNAL_KEY_SECRET);
      this.store.delete(EXTERNAL_KEY_ORIGIN_SECRET);
      this.sessionKey = { key, origin: origin === '' ? null : origin };
    }
    // Both branches above leave the store consistent (a bound pair, or empty).
    this.storeUntrusted = false;
  }

  /** Delete both entries (key first: no key is ever left bound elsewhere). Throws on a failed delete (F-014). */
  private clearKey(): void {
    this.sessionKey = null;
    this.store.delete(EXTERNAL_KEY_SECRET);
    this.store.delete(EXTERNAL_KEY_ORIGIN_SECRET);
    this.storeUntrusted = false;
  }

  /** Everything commit()/reset() can change (PR #142 rebase RB-001). */
  captureState(): ExternalProviderSettingsState {
    let secrets: ExternalProviderSettingsState['secrets'];
    try {
      secrets = { key: this.store.get(EXTERNAL_KEY_SECRET), origin: this.store.get(EXTERNAL_KEY_ORIGIN_SECRET) };
    } catch {
      secrets = null;
    }
    return {
      values: { ...this.values },
      // Copied: bindOrigin() mutates the live session key in place.
      sessionKey: this.sessionKey === null ? null : { ...this.sessionKey },
      secrets,
    };
  }

  /**
   * Restore a captureState() snapshot: the values and the session key in
   * memory first (never fails), then the SecretStore entries that differ.
   * Write order never leaves a key bound to an origin it was not saved for:
   * a changed key is deleted first, then the origin is restored, then the
   * old key. Throws when a SecretStore write fails.
   *
   * Fail closed (Stage B RB-001): when a write here throws, the stored
   * entries are no longer known to be one consistent pair, so the stored key
   * is not used (keyFor() answers null) until a later saveKey()/clearKey()
   * succeeds. A restored session-only key is unaffected (memory, not store).
   */
  restoreState(snapshot: ExternalProviderSettingsState): void {
    this.values = { ...snapshot.values };
    this.sessionKey = snapshot.sessionKey === null ? null : { ...snapshot.sessionKey };
    const want = snapshot.secrets;
    if (want === null) return;
    try {
      const currentKey = this.store.get(EXTERNAL_KEY_SECRET);
      const currentOrigin = this.store.get(EXTERNAL_KEY_ORIGIN_SECRET);
      const keyDiffers = currentKey !== want.key;
      if (keyDiffers && currentKey !== null) this.store.delete(EXTERNAL_KEY_SECRET);
      if (currentOrigin !== want.origin) {
        if (want.origin === null) this.store.delete(EXTERNAL_KEY_ORIGIN_SECRET);
        else this.store.set(EXTERNAL_KEY_ORIGIN_SECRET, want.origin);
      }
      if (keyDiffers && want.key !== null) this.store.set(EXTERNAL_KEY_SECRET, want.key);
    } catch (err) {
      this.storeUntrusted = true;
      throw err;
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
