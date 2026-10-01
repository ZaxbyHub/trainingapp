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
 *     in localStorage only while "Remember API key" is on.
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
  loadExternalConfig,
  probeExternalEndpoint,
  saveExternalConfig,
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

function originOf(url: string): string {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return '';
  }
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
      apiKey: '',
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

  const handleBaseUrlBlur = async () => {
    const url = draftRef.current.baseUrl;
    if (url.trim() === '') return;
    const refusal = checkUrl(url);
    if (refusal !== null) {
      setProblem(refusal);
      return;
    }
    setProblem(null);
    await persist({ baseUrl: url });
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
      if (key === '') return; // write-only: an empty field never clears a saved key by accident
      const ok = await persist({ apiKey: key });
      if (ok && mountedRef.current) setDraft((prev) => ({ ...prev, apiKey: '' }));
      return;
    }
    await persist({ apiKey: key });
  };

  const handleClearKey = async () => {
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
        result = await probeExternalEndpoint({
          protocol: current.protocol,
          baseUrl: current.baseUrl.trim(),
          model: current.model.trim(),
          apiKey: current.apiKey,
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

  const draftOrigin = originOf(draft.baseUrl);
  const boundElsewhere =
    desktop && keyState.apiKeyBoundOrigin !== '' && draftOrigin !== '' && keyState.apiKeyBoundOrigin !== draftOrigin;
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
            : 'Optional. Stored in this browser and sent only to this endpoint.'}
        </p>
        <div style={rowStyle}>
          <input
            id="external-api-key"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={draft.apiKey}
            onChange={(e) => update({ apiKey: e.target.value })}
            onBlur={() => void handleKeyBlur()}
            placeholder={desktop && keyState.apiKeySet ? 'Saved' : 'Leave empty for servers without a key'}
            style={inputStyle}
            aria-describedby="external-api-key-desc"
          />
          {(desktop ? keyState.apiKeySet || keyState.apiKeyBoundOrigin !== '' : draft.apiKey !== '') && (
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
                void persist({ rememberKey: e.target.checked, apiKey: draftRef.current.apiKey });
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
        {boundElsewhere && (
          <p style={descStyle}>
            The saved key belongs to {keyState.apiKeyBoundOrigin} and is not sent anywhere else; re-enter it to use it
            here.
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
