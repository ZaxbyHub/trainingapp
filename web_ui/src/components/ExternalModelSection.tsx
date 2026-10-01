/**
 * Settings → External model (universal-provider-settings-overhaul, AC10/
 * AC11/AC12/AC13). ONE region, rendered identically in the browser app and
 * the desktop app, with the same seven controls (located by role and
 * accessible name): Protocol, Base URL, API key (password), Model, Test
 * connection, Use external model, Direct chat (default off).
 *
 *   Browser app: the configuration lives in this browser
 *     (lib/llm/external-provider.ts) and "Test connection" calls the endpoint
 *     directly (probeExternalEndpoint). The key is stored in this browser —
 *     in localStorage only while "Remember API key" is on — and is bound to
 *     the origin it was entered for (key-origin binding, ADR-0011 decision
 *     3): after the base URL moves to another origin the saved key is not
 *     shown, not tested and not used; the panel says which origin it belongs
 *     to and re-entering it binds it to the new origin.
 *   Both apps: a typed key is saved ONLY together with the base URL shown
 *     (one browser save / one desktop PUT carrying external.baseUrl and
 *     external.apiKey). While the shown URL is empty or refused the key is
 *     held in this component only (never saved, never bound to a URL saved
 *     earlier) and the panel says it will be saved with the next valid URL.
 *   Desktop app: every change is a PUT /settings `external.*` patch to the
 *     built-in backend; the key goes to the main-process secret store and is
 *     never kept in the renderer; "Test connection" is POST
 *     /settings/external/test (the renderer never contacts the endpoint).
 *
 * Egress stays off until "Use external model" is switched on. Both apps check
 * the base URL with the shared endpoint policy first; airgap builds refuse
 * public hosts with a role="alert" message that names the restriction.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isElectron, useDesktopSession } from '../lib/desktop-session';
import { notifyDesktopModelsChanged } from '../lib/desktop-models-events';
import { IS_AIRGAP } from '../lib/llm/airgap';
import { validateEndpointUrl } from '../lib/llm/endpoint-policy';
import { isHeaderSafeValue, UNSENDABLE_KEY_MESSAGE } from '../lib/llm/provider-error';
import {
  keyForBaseUrl,
  keyOriginOf,
  loadExternalConfig,
  loadExternalKeyState,
  probeExternalEndpoint,
  saveExternalConfig,
  type ExternalKeyState,
  type ExternalProtocol,
} from '../lib/llm/external-provider';

interface Draft {
  enabled: boolean;
  protocol: ExternalProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  rememberKey: boolean;
  grounded: boolean;
}

interface DesktopKeyState {
  apiKeySet: boolean;
  apiKeyPersisted: boolean;
  apiKeyBoundOrigin: string;
  airgap: boolean;
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--spacing-md)',
  padding: 'var(--spacing-lg)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md, 8px)',
  backgroundColor: 'var(--color-surface)',
};
const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--font-size-h3, 1.125rem)',
  fontWeight: 600,
  fontFamily: 'var(--font-family)',
  color: 'var(--color-text)',
};
const descStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--font-size-caption)',
  fontFamily: 'var(--font-family)',
  color: 'var(--color-text-muted)',
};
const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--font-size-body)',
  fontWeight: 500,
  fontFamily: 'var(--font-family)',
  color: 'var(--color-text)',
  marginBottom: 'var(--spacing-xs)',
};
const inputStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '32rem',
  padding: 'var(--spacing-sm)',
  fontSize: 'var(--font-size-body)',
  fontFamily: 'var(--font-family)',
  border: '1px solid var(--color-border)',
  borderRadius: '4px',
  backgroundColor: 'var(--color-background)',
  color: 'var(--color-text)',
};
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', flexWrap: 'wrap' };
const buttonStyle: React.CSSProperties = {
  padding: 'var(--spacing-sm) var(--spacing-md)',
  fontSize: 'var(--font-size-body)',
  fontFamily: 'var(--font-family)',
  border: '1px solid var(--color-border)',
  borderRadius: '4px',
  backgroundColor: 'transparent',
  color: 'var(--color-text)',
  cursor: 'pointer',
};
const errorStyle: React.CSSProperties = { ...descStyle, color: 'var(--color-danger)' };
const okStyle: React.CSSProperties = { ...descStyle, color: 'var(--color-success, var(--color-text))' };

/** Same copy in both apps when the saved key belongs to another origin. */
function keyElsewhereText(boundOrigin: string): string {
  return `Your saved key is for ${boundOrigin}. Enter the key for this server to use it.`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ExternalModelSection({ id }: { id?: string }): React.ReactElement {
  const { session } = useDesktopSession();
  const desktop = isElectron();
  const [draft, setDraft] = useState<Draft>(() => {
    if (desktop) {
      return { enabled: false, protocol: 'openai', baseUrl: '', model: '', apiKey: '', rememberKey: false, grounded: true };
    }
    return loadExternalConfig();
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Browser key-origin binding: the origin the key in the field belongs to
  // (loaded key: its bound origin, which equals the shown URL's; typed key:
  // the URL shown while typing), and whether it was typed since the last save.
  const fieldKeyOriginRef = useRef(!desktop && draft.apiKey !== '' ? keyOriginOf(draft.baseUrl) : '');
  const keyDirtyRef = useRef(false);
  // A typed key waiting for a valid base URL (held in this component only).
  const [keyHeld, setKeyHeld] = useState(false);
  // Re-render after a browser key save (storage writes do not re-render).
  const [, setKeyVersion] = useState(0);
  const [keyState, setKeyState] = useState<DesktopKeyState>({
    apiKeySet: false,
    apiKeyPersisted: true,
    apiKeyBoundOrigin: '',
    airgap: false,
  });
  const [models, setModels] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const airgap = IS_AIRGAP || keyState.airgap;

  const applyDesktopSettings = useCallback((s: Record<string, unknown>) => {
    setDraft((prev) => ({
      ...prev,
      enabled: s['external.enabled'] === true,
      protocol: s['external.protocol'] === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: typeof s['external.baseUrl'] === 'string' ? (s['external.baseUrl'] as string) : prev.baseUrl,
      model: typeof s['external.model'] === 'string' ? (s['external.model'] as string) : prev.model,
      grounded: s['external.grounded'] !== false,
      // Write-only key field: only a key typed and not saved yet stays (a held
      // key survives saves of other fields); saveTypedKey clears it once saved.
      apiKey: prev.apiKey,
    }));
    setKeyState({
      apiKeySet: s['external.apiKeySet'] === true,
      apiKeyPersisted: s['external.apiKeyPersisted'] !== false,
      apiKeyBoundOrigin: typeof s['external.apiKeyBoundOrigin'] === 'string' ? (s['external.apiKeyBoundOrigin'] as string) : '',
      airgap: s['external.airgap'] === true,
    });
  }, []);

  // Desktop: the backend is the source of truth for the external settings.
  useEffect(() => {
    if (!desktop || session === null) return;
    let cancelled = false;
    void session.apiClient
      .getSettings()
      .then((s) => {
        if (!cancelled && mountedRef.current) applyDesktopSettings(s as Record<string, unknown>);
      })
      .catch(() => {
        /* the Desktop backend section reports settings errors */
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, session, applyDesktopSettings]);

  /** Policy check with the airgap rule this app enforces. */
  const checkUrl = useCallback(
    (url: string): string | null => {
      const verdict = validateEndpointUrl(url, { airgap });
      return verdict.ok ? null : verdict.message;
    },
    [airgap],
  );

  /** Persist a patch (browser storage or desktop PUT). Resolves false on refusal. */
  const persist = useCallback(
    async (patch: Partial<Draft>): Promise<boolean> => {
      if (!desktop) {
        saveExternalConfig(patch);
        setKeyVersion((v) => v + 1);
        return true;
      }
      if (session === null) {
        setProblem('The desktop backend is not available yet. Try again in a moment.');
        return false;
      }
      const body: Record<string, unknown> = {};
      if (patch.enabled !== undefined) body['external.enabled'] = patch.enabled;
      if (patch.protocol !== undefined) body['external.protocol'] = patch.protocol;
      if (patch.baseUrl !== undefined) body['external.baseUrl'] = patch.baseUrl.trim();
      if (patch.model !== undefined) body['external.model'] = patch.model.trim();
      if (patch.grounded !== undefined) body['external.grounded'] = patch.grounded;
      if (patch.apiKey !== undefined) body['external.apiKey'] = patch.apiKey;
      try {
        const settings = await session.apiClient.updateSettings(body);
        if (mountedRef.current) applyDesktopSettings(settings as Record<string, unknown>);
        if (patch.enabled !== undefined) notifyDesktopModelsChanged();
        return true;
      } catch (err) {
        if (mountedRef.current) setProblem(`The desktop backend refused this setting: ${errorText(err)}`);
        return false;
      }
    },
    [desktop, session, applyDesktopSettings],
  );

  const update = (patch: Partial<Draft>) => {
    setStatus(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  /** A key typed in the field and not saved yet (desktop: any key in the write-only field). */
  const typedKeyPending = (): boolean =>
    draftRef.current.apiKey !== '' && (desktop || keyDirtyRef.current);

  /**
   * Save the typed key TOGETHER with the base URL shown, in one patch, so it
   * is bound to that URL's origin and to nothing else. While the shown URL is
   * empty or refused the key is held (not saved) until a valid URL is entered.
   */
  const saveTypedKey = async (): Promise<void> => {
    const key = draftRef.current.apiKey;
    const url = draftRef.current.baseUrl;
    if (url.trim() === '' || checkUrl(url) !== null) {
      setKeyHeld(true);
      return;
    }
    setKeyHeld(false);
    if (desktop) {
      const ok = await persist({ baseUrl: url, apiKey: key });
      if (ok && mountedRef.current) setDraft((prev) => ({ ...prev, apiKey: '' }));
      return;
    }
    keyDirtyRef.current = false;
    fieldKeyOriginRef.current = keyOriginOf(url);
    await persist({ baseUrl: url, apiKey: key });
  };

  const handleBaseUrlBlur = async () => {
    const url = draftRef.current.baseUrl;
    if (url.trim() === '') return;
    const refusal = checkUrl(url);
    if (refusal !== null) {
      setProblem(refusal);
      return;
    }
    setProblem(null);
    if (typedKeyPending()) {
      // A typed (or held) key is saved with this URL, in the same patch.
      const key = draftRef.current.apiKey;
      if (!isHeaderSafeValue(key)) {
        await persist({ baseUrl: url });
        setProblem(`API key: ${UNSENDABLE_KEY_MESSAGE}.`);
        return;
      }
      await saveTypedKey();
      return;
    }
    await persist({ baseUrl: url });
    if (!desktop && !keyDirtyRef.current) {
      // The field only ever shows the key bound to the URL shown: moving to
      // another origin hides it (the saved key is kept, not rebound); moving
      // back shows it again.
      const origin = keyOriginOf(url);
      const bound = keyForBaseUrl(url);
      if (fieldKeyOriginRef.current !== origin || draftRef.current.apiKey !== bound) {
        fieldKeyOriginRef.current = bound !== '' ? origin : '';
        if (mountedRef.current) setDraft((prev) => ({ ...prev, apiKey: bound }));
      }
    }
  };

  const handleModelBlur = async () => {
    setProblem(null);
    await persist({ model: draftRef.current.model });
  };

  const handleKeyBlur = async () => {
    const key = draftRef.current.apiKey;
    // Inline validation (both apps): a key that cannot travel in an HTTP
    // header is never saved; the message names the rule, never the value.
    if (key !== '' && !isHeaderSafeValue(key)) {
      setProblem(`API key: ${UNSENDABLE_KEY_MESSAGE}.`);
      return;
    }
    if (desktop) {
      if (key === '') {
        setKeyHeld(false);
        return; // write-only: an empty field never clears a saved key by accident
      }
      await saveTypedKey();
      return;
    }
    // Browser: only a key the user actually typed is saved (a tab-through
    // never rebinds the saved key to the URL now shown).
    if (!keyDirtyRef.current) return;
    const url = draftRef.current.baseUrl;
    if (key === '') {
      keyDirtyRef.current = false;
      setKeyHeld(false);
      // The user emptied the field: forget the key that was shown here (a key
      // bound to another origin was never shown, so it is kept).
      if (loadExternalKeyState(url).status === 'bound') await persist({ apiKey: '' });
      fieldKeyOriginRef.current = '';
      return;
    }
    await saveTypedKey();
  };

  const handleClearKey = async () => {
    keyDirtyRef.current = false;
    setKeyHeld(false);
    fieldKeyOriginRef.current = '';
    setDraft((prev) => ({ ...prev, apiKey: '' }));
    await persist({ apiKey: '' });
  };

  const handleEnabledChange = async (enabled: boolean) => {
    const current = draftRef.current;
    if (enabled) {
      if (current.baseUrl.trim() === '' || current.model.trim() === '') {
        setProblem('Enter a base URL and choose a model before turning on the external model.');
        return;
      }
      const refusal = checkUrl(current.baseUrl);
      if (refusal !== null) {
        setProblem(refusal);
        return;
      }
    }
    setProblem(null);
    const previous = current.enabled;
    update({ enabled });
    const patch: Partial<Draft> = enabled
      ? { enabled, protocol: current.protocol, baseUrl: current.baseUrl, model: current.model }
      : { enabled };
    if (!(await persist(patch)) && mountedRef.current) setDraft((prev) => ({ ...prev, enabled: previous }));
  };

  const handleTest = async () => {
    const current = draftRef.current;
    setStatus(null);
    const refusal =
      current.baseUrl.trim() === ''
        ? 'Enter a base URL to test.'
        : current.apiKey !== '' && !isHeaderSafeValue(current.apiKey)
          ? `API key: ${UNSENDABLE_KEY_MESSAGE}.`
          : checkUrl(current.baseUrl);
    if (refusal !== null) {
      setProblem(refusal);
      return;
    }
    setProblem(null);
    setTesting(true);
    const requested = current.baseUrl;
    try {
      let result: { ok: boolean; message: string; models?: string[] };
      if (desktop) {
        if (session === null) throw new Error('The desktop backend is not available yet.');
        result = await session.apiClient.testExternalEndpoint({
          protocol: current.protocol,
          baseUrl: current.baseUrl.trim(),
          model: current.model.trim(),
          ...(current.apiKey !== '' ? { apiKey: current.apiKey } : {}),
        });
      } else {
        // Key-origin binding: the key in the field only when it belongs to
        // this URL's origin; otherwise the saved key only if it is bound here.
        const origin = keyOriginOf(current.baseUrl);
        const apiKey =
          current.apiKey !== '' && fieldKeyOriginRef.current !== '' && fieldKeyOriginRef.current === origin
            ? current.apiKey
            : keyForBaseUrl(current.baseUrl);
        result = await probeExternalEndpoint({
          protocol: current.protocol,
          baseUrl: current.baseUrl.trim(),
          model: current.model.trim(),
          apiKey,
        });
      }
      if (!mountedRef.current || draftRef.current.baseUrl !== requested) return;
      if (result.models && result.models.length > 0) setModels(result.models);
      if (result.ok) setStatus(result.message);
      else setProblem(result.message);
    } catch (err) {
      if (mountedRef.current) setProblem(`Connection test failed: ${errorText(err)}`);
    } finally {
      if (mountedRef.current) setTesting(false);
    }
  };

  const draftOrigin = keyOriginOf(draft.baseUrl);
  const browserKey: ExternalKeyState = desktop ? { status: 'none' } : loadExternalKeyState(draft.baseUrl);
  const keyElsewhereOrigin = desktop
    ? keyState.apiKeyBoundOrigin !== '' && draftOrigin !== '' && keyState.apiKeyBoundOrigin !== draftOrigin
      ? keyState.apiKeyBoundOrigin
      : ''
    : browserKey.status === 'mismatch' && draftOrigin !== '' && draft.apiKey === ''
      ? browserKey.boundOrigin
      : '';
  const plainHttpKey =
    draft.apiKey !== '' &&
    draft.baseUrl.trim().toLowerCase().startsWith('http://') &&
    validateEndpointUrl(draft.baseUrl, { airgap: false }).kind === 'private';
  const headingId = 'external-model-heading';

  return (
    <section id={id} style={sectionStyle} aria-labelledby={headingId} data-testid="external-model-section">
      <h2 id={headingId} style={titleStyle} tabIndex={-1}>
        External model
      </h2>
      <p style={descStyle}>
        Generate answers with a model server on this computer, on your network, or a cloud provider
        (OpenAI- or Anthropic-compatible). Your documents stay here: retrieval runs locally and only the
        question, the retrieved passages and recent conversation are sent to the endpoint. Off by default.
      </p>
      {airgap && (
        <p style={descStyle} data-testid="external-airgap-notice">
          Air-gapped build: only loopback and private-network endpoints can be used.
        </p>
      )}

      <div style={rowStyle}>
        <input
          id="external-enabled"
          type="checkbox"
          role="switch"
          checked={draft.enabled}
          aria-checked={draft.enabled}
          onChange={(e) => void handleEnabledChange(e.target.checked)}
        />
        <label htmlFor="external-enabled" style={{ ...labelStyle, marginBottom: 0 }}>
          Use external model
        </label>
      </div>

      <div>
        <label htmlFor="external-protocol" style={labelStyle}>
          Protocol
        </label>
        <select
          id="external-protocol"
          value={draft.protocol}
          onChange={(e) => {
            const protocol = e.target.value === 'anthropic' ? 'anthropic' : 'openai';
            update({ protocol });
            setModels([]);
            void persist({ protocol });
          }}
          style={inputStyle}
        >
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic-compatible</option>
        </select>
      </div>

      <div>
        <label htmlFor="external-base-url" style={labelStyle}>
          Base URL
        </label>
        <p id="external-base-url-desc" style={descStyle}>
          For example http://localhost:1234 (LM Studio), http://192.168.1.20:11434 (Ollama on your
          network), https://api.openai.com or https://api.anthropic.com. Public hosts need https.
        </p>
        <input
          id="external-base-url"
          type="url"
          autoComplete="off"
          spellCheck={false}
          value={draft.baseUrl}
          onChange={(e) => update({ baseUrl: e.target.value })}
          onBlur={() => void handleBaseUrlBlur()}
          placeholder="http://localhost:1234"
          style={inputStyle}
          aria-describedby="external-base-url-desc"
        />
      </div>

      <div>
        <label htmlFor="external-api-key" style={labelStyle}>
          API key
        </label>
        <p id="external-api-key-desc" style={descStyle}>
          {desktop
            ? keyState.apiKeySet
              ? 'A key is saved (encrypted by the operating system). Type a new key to replace it.'
              : 'Optional. Saved encrypted by the desktop app and sent only to this endpoint.'
            : 'Optional. Stored in this browser and sent only to the server it was entered for.'}
        </p>
        <div style={rowStyle}>
          <input
            id="external-api-key"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={draft.apiKey}
            onChange={(e) => {
              keyDirtyRef.current = true;
              fieldKeyOriginRef.current = keyOriginOf(draftRef.current.baseUrl);
              update({ apiKey: e.target.value });
            }}
            onBlur={() => void handleKeyBlur()}
            placeholder={desktop && keyState.apiKeySet ? 'Saved' : 'Leave empty for servers without a key'}
            style={inputStyle}
            aria-describedby="external-api-key-desc"
          />
          {(desktop ? keyState.apiKeySet || keyState.apiKeyBoundOrigin !== '' : draft.apiKey !== '' || browserKey.status !== 'none') && (
            <button type="button" style={buttonStyle} onClick={() => void handleClearKey()}>
              Clear saved key
            </button>
          )}
        </div>
        {!desktop && (
          <div style={{ ...rowStyle, marginTop: 'var(--spacing-xs)' }}>
            <input
              id="external-remember-key"
              type="checkbox"
              checked={draft.rememberKey}
              onChange={(e) => {
                update({ rememberKey: e.target.checked });
                // Moves the saved key and its binding between storages; never rebinds.
                void persist({ rememberKey: e.target.checked });
              }}
            />
            <label htmlFor="external-remember-key" style={descStyle}>
              Remember API key in this browser (otherwise it is kept for this browser session only)
            </label>
          </div>
        )}
        {desktop && !keyState.apiKeyPersisted && keyState.apiKeySet && (
          <p style={descStyle}>Key kept for this session only: secure storage is unavailable on this computer.</p>
        )}
        {keyHeld && draft.apiKey !== '' && (
          <p style={descStyle} data-testid="external-key-held">
            The API key is not saved yet: it will be saved together with the next valid base URL you
            enter, and sent only to that server.
          </p>
        )}
        {keyElsewhereOrigin !== '' && (
          <p style={descStyle} data-testid="external-key-elsewhere">
            {keyElsewhereText(keyElsewhereOrigin)}
          </p>
        )}
        {plainHttpKey && (
          <p style={descStyle}>
            This key would be sent over plain http to a network host. Prefer https for servers that need a key.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="external-model" style={labelStyle}>
          Model
        </label>
        <input
          id="external-model"
          type="text"
          list="external-model-options"
          autoComplete="off"
          spellCheck={false}
          value={draft.model}
          onChange={(e) => update({ model: e.target.value })}
          onBlur={() => void handleModelBlur()}
          placeholder="Test the connection to list models"
          style={inputStyle}
        />
        <datalist id="external-model-options">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      <div style={rowStyle}>
        <button type="button" style={buttonStyle} onClick={() => void handleTest()} disabled={testing} aria-busy={testing}>
          Test connection
        </button>
        {testing && <span style={descStyle}>Testing…</span>}
      </div>

      <div style={rowStyle}>
        <input
          id="external-direct-chat"
          type="checkbox"
          checked={!draft.grounded}
          onChange={(e) => {
            const grounded = !e.target.checked;
            update({ grounded });
            void persist({ grounded });
          }}
          aria-describedby="external-direct-chat-desc"
        />
        <label htmlFor="external-direct-chat" style={{ ...labelStyle, marginBottom: 0 }}>
          Direct chat (no document grounding)
        </label>
      </div>
      <p id="external-direct-chat-desc" style={descStyle}>
        Off: answers use your documents with citations. On: questions go straight to the model without
        retrieval and answers are labeled General knowledge.
      </p>

      {status !== null && (
        <p role="status" style={okStyle}>
          {status}
        </p>
      )}
      {problem !== null && (
        <p role="alert" style={errorStyle}>
          {problem}
        </p>
      )}
    </section>
  );
}
