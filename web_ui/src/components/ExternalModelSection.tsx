/**
 * Settings → Model & connection (universal-provider-settings-overhaul, AC10/
 * AC11/AC12/AC13; Lumen phase 4, design-language.md section 5). ONE region,
 * rendered identically in the browser app and the desktop app: the generator
 * source (Built-in model / Local or network server / Cloud provider) and, for a
 * server source, the same controls (located by role and accessible name):
 * Protocol, Base URL, API key (write-only password field), Model (combobox),
 * Test connection, Use external model (the egress opt-in, default off), and
 * Use my documents (grounded, default on; off = Direct chat).
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
 *     held in this component only (not saved) and is saved only with the
 *     next valid base URL the user enters (never with one saved earlier
 *     unless the user enters it again); the panel says so.
 *   Desktop app: every change is a PUT /settings `external.*` patch to the
 *     built-in backend; the key goes to the main-process secret store and is
 *     never kept in the renderer; "Test connection" is POST
 *     /settings/external/test (the renderer never contacts the endpoint).
 *
 * Egress stays off until "Use external model" is switched on. Both apps check
 * the base URL with the shared endpoint policy first; airgap builds refuse
 * public hosts with a role="alert" message that names the restriction.
 */
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Banner, Button, Checkbox, Combobox, Field, PasswordInput, Select, Switch, TextInput } from '../ui';
import { SettingsRadioCards, SettingsSection, SettingsSubsection } from './SettingsControls';
import { isElectron, useDesktopSession } from '../lib/desktop-session';
import { notifyDesktopModelsChanged } from '../lib/desktop-models-events';
import { IS_AIRGAP } from '../lib/llm/airgap';
import { validateEndpointUrl } from '../lib/llm/endpoint-policy';
import { isHeaderSafeValue, UNSENDABLE_KEY_MESSAGE, type ProviderFailureKind } from '../lib/llm/provider-error';
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

/**
 * Generator source (design-language.md section 5, "Model & connection"). A UI choice
 * over the unchanged stored settings: Built-in model == the external endpoint is OFF;
 * Local or network server / Cloud provider show the connection form, and egress still
 * starts only when "Use external model" is switched on. An enabled endpoint shows the
 * source its base URL belongs to (a public host is a cloud provider).
 */
type GeneratorSource = 'builtin' | 'local' | 'cloud';

function sourceOfUrl(baseUrl: string): Exclude<GeneratorSource, 'builtin'> {
  const verdict = validateEndpointUrl(baseUrl, { airgap: false });
  return verdict.ok && verdict.kind === 'public' ? 'cloud' : 'local';
}

/** What a problem is about: a setting the user entered, or a connection-test cause. */
type ProblemCause = 'setting' | ProviderFailureKind;

const PROBLEM_TITLE: Record<ProblemCause, string> = {
  setting: 'Check this setting',
  network: 'Server not reachable',
  auth: 'The server refused the API key',
  model: 'Model not available',
  timeout: 'The server did not answer in time',
  server: 'The server reported an error',
  other: 'Connection test failed',
};

/** Same copy in both apps when the saved key belongs to another origin. */
function keyElsewhereText(boundOrigin: string): string {
  return `Your saved key is for ${boundOrigin}. Enter the key for this server to use it.`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ExternalModelSectionProps {
  id?: string;
  /**
   * Built-in model settings, shown while "Built-in model" is the generator source
   * (SettingsPage passes the engine / desktop-backend controls).
   */
  builtIn?: ReactNode;
  /**
   * Shown at the top of the section for EVERY generator source (e.g. the desktop
   * backend's settings error, which must not hide behind the Built-in model slot).
   */
  notice?: ReactNode;
}

export function ExternalModelSection({ id, builtIn, notice }: ExternalModelSectionProps): React.ReactElement {
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
  // The base URL as last SAVED (browser save / desktop snapshot). An enabled endpoint's
  // generator source is classified from it, so typing in the field never flips the
  // radio while egress is on; only a saved URL (blur, enable, backend answer) does.
  const [savedBaseUrl, setSavedBaseUrl] = useState(draft.baseUrl);
  const [source, setSource] = useState<GeneratorSource>(() => (draft.enabled ? sourceOfUrl(draft.baseUrl) : 'builtin'));
  // Browser key-origin binding: the origin the key in the field belongs to
  // (loaded key: its bound origin, which equals the shown URL's; typed key:
  // the URL shown while typing), and whether it was typed since the last save.
  const fieldKeyOriginRef = useRef(!desktop && draft.apiKey !== '' ? keyOriginOf(draft.baseUrl) : '');
  const keyDirtyRef = useRef(false);
  // A typed key waiting for a valid base URL (held in this component only).
  const [keyHeld, setKeyHeld] = useState(false);
  // Desktop: a typed key was dropped because the backend changed the shown URL.
  const [keyDropped, setKeyDropped] = useState(false);
  // Re-render after a browser key save (storage writes do not re-render).
  const [, setKeyVersion] = useState(0);
  const [keyState, setKeyState] = useState<DesktopKeyState>({
    apiKeySet: false,
    apiKeyPersisted: true,
    apiKeyBoundOrigin: '',
    airgap: false,
  });
  const [models, setModels] = useState<string[]>([]);
  const [problemState, setProblemState] = useState<{ message: string; cause: ProblemCause } | null>(null);
  const problem = problemState?.message ?? null;
  const setProblem = useCallback((message: string | null, cause: ProblemCause = 'setting') => {
    setProblemState(message === null ? null : { message, cause });
  }, []);
  const problemTitle = (): string => PROBLEM_TITLE[problemState?.cause ?? 'setting'];
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

  // Desktop: whether any backend snapshot (GET or PUT answer) has been applied.
  const snapshotAppliedRef = useRef(false);
  const applyDesktopSettings = useCallback((s: Record<string, unknown>) => {
    snapshotAppliedRef.current = true;
    const current = draftRef.current;
    const nextBaseUrl = typeof s['external.baseUrl'] === 'string' ? (s['external.baseUrl'] as string) : current.baseUrl;
    // A typed key belongs to the URL that was SHOWN when it was typed. When the
    // backend's answer replaces the shown URL (e.g. after a save of another
    // field, or the first settings load), the typed key is dropped (fail
    // closed) so it can never be saved or tested against that other URL.
    const dropKey = current.apiKey !== '' && nextBaseUrl.trim() !== current.baseUrl.trim();
    if (dropKey) {
      fieldKeyOriginRef.current = '';
      setKeyHeld(false);
      setKeyDropped(true);
    }
    draftRef.current = { ...current, baseUrl: nextBaseUrl, apiKey: dropKey ? '' : current.apiKey };
    setSavedBaseUrl(nextBaseUrl);
    setDraft((prev) => ({
      ...prev,
      enabled: s['external.enabled'] === true,
      protocol: s['external.protocol'] === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: nextBaseUrl,
      model: typeof s['external.model'] === 'string' ? (s['external.model'] as string) : prev.model,
      grounded: s['external.grounded'] !== false,
      // Write-only key field: a typed, unsaved key stays only while the shown
      // URL is unchanged; saveTypedKey clears it once saved.
      apiKey: dropKey ? '' : prev.apiKey,
    }));
    setKeyState({
      apiKeySet: s['external.apiKeySet'] === true,
      apiKeyPersisted: s['external.apiKeyPersisted'] !== false,
      apiKeyBoundOrigin: typeof s['external.apiKeyBoundOrigin'] === 'string' ? (s['external.apiKeyBoundOrigin'] as string) : '',
      airgap: s['external.airgap'] === true,
    });
  }, []);

  // Desktop write sequence (review round 3 R3-N1): incremented when a PUT is
  // issued. A settings snapshot (GET or PUT answer) is applied only if no
  // later PUT was issued after its request started, so a slow, stale answer
  // can never repaint an older base URL that the next blur would PUT back.
  const writeSeqRef = useRef(0);

  // Desktop: the backend is the source of truth for the external settings.
  useEffect(() => {
    if (!desktop || session === null) return;
    let cancelled = false;
    const startedAt = writeSeqRef.current;
    void session.apiClient
      .getSettings()
      .then((s) => {
        if (cancelled || !mountedRef.current) return;
        if (writeSeqRef.current !== startedAt) return; // a PUT was issued since: its answer is newer
        applyDesktopSettings(s as Record<string, unknown>);
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
        if (patch.baseUrl !== undefined) setSavedBaseUrl(patch.baseUrl);
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
      writeSeqRef.current += 1;
      const seq = writeSeqRef.current;
      try {
        const settings = await session.apiClient.updateSettings(body);
        // Only the answer to the LATEST PUT repaints the panel (answers can
        // arrive out of order).
        if (mountedRef.current && seq === writeSeqRef.current) applyDesktopSettings(settings as Record<string, unknown>);
        if (patch.enabled !== undefined) notifyDesktopModelsChanged();
        return true;
      } catch (err) {
        if (mountedRef.current) setProblem(`The desktop backend refused this setting: ${errorText(err)}`);
        // Final critic FC2: the refused PUT bumped the write sequence, so an
        // initial GET still in flight will be discarded. If no snapshot was
        // ever applied, read the backend again (same guard: a later PUT still
        // wins) so the panel never keeps its defaults (e.g. the switch OFF
        // while the backend generates externally).
        if (!snapshotAppliedRef.current) {
          const startedAt = writeSeqRef.current;
          void session.apiClient
            .getSettings()
            .then((s) => {
              if (!mountedRef.current || writeSeqRef.current !== startedAt) return;
              applyDesktopSettings(s as Record<string, unknown>);
            })
            .catch(() => {
              /* the Desktop backend section reports settings errors */
            });
        }
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

  /** A model picked from the endpoint's list (Enter / click) is saved at once. */
  const handleModelPick = async (model: string) => {
    setProblem(null);
    await persist({ model });
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
      // Write-only field (review L1): an emptied field is "no new key", never an
      // accidental delete. The saved key bound to this URL (if any) stays in use;
      // "Clear saved key" is the explicit way to forget it.
      keyDirtyRef.current = false;
      setKeyHeld(false);
      const bound = keyForBaseUrl(url);
      fieldKeyOriginRef.current = bound !== '' ? keyOriginOf(url) : '';
      if (mountedRef.current) setDraft((prev) => ({ ...prev, apiKey: bound }));
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
      let result: { ok: boolean; kind?: ProviderFailureKind; message: string; models?: string[] };
      if (desktop) {
        if (session === null) throw new Error('The desktop backend is not available yet.');
        result = await session.apiClient.testExternalEndpoint({
          protocol: current.protocol,
          baseUrl: current.baseUrl.trim(),
          model: current.model.trim(),
          // A draft key only for the origin it was typed for (else the backend
          // uses the saved key, and only for its bound origin).
          ...(current.apiKey !== '' && fieldKeyOriginRef.current !== '' && fieldKeyOriginRef.current === keyOriginOf(current.baseUrl)
            ? { apiKey: current.apiKey }
            : {}),
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
      else setProblem(result.message, result.kind ?? 'other');
    } catch (err) {
      if (mountedRef.current) setProblem(`Connection test failed: ${errorText(err)}`, 'network');
    } finally {
      if (mountedRef.current) setTesting(false);
    }
  };

  // An enabled endpoint (e.g. the desktop backend's snapshot arriving) shows the source
  // its saved base URL belongs to.
  useEffect(() => {
    if (draft.enabled) setSource(sourceOfUrl(savedBaseUrl));
  }, [draft.enabled, savedBaseUrl]);

  const handleSourceChange = async (next: GeneratorSource) => {
    setSource(next);
    // Built-in model: egress off (the safe direction; persisted like the switch).
    if (next === 'builtin' && draftRef.current.enabled) await handleEnabledChange(false);
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
  const cloudBlocked = airgap;
  const isServer = source !== 'builtin';
  // Browser: the saved key bound to the URL shown is in memory (draft) but is never
  // written into the field's DOM value (review L1): the field is write-only, as on
  // the desktop, and a line says a key is saved.
  const browserKeySaved = !desktop && !keyDirtyRef.current && draft.apiKey !== '';
  const keySavedHere = desktop ? keyState.apiKeySet : browserKeySaved;
  // While egress is on, the server type follows the live endpoint (review L2).
  const serverLocked = draft.enabled;
  const keyHelp = desktop
    ? keyState.apiKeySet
      ? keyState.apiKeyPersisted
        ? 'A key is saved, encrypted by the operating system. Type a new key to replace it.'
        : 'A key is set for this session only: secure storage is unavailable on this computer, so it is not saved to disk. Type a new key to replace it.'
      : keyState.apiKeyPersisted
        ? 'Optional. Saved encrypted by the operating system when secure storage is available (otherwise kept for this session only), and sent only to this endpoint.'
        : 'Optional. Secure storage is unavailable on this computer: a key you enter is kept for this session only, and sent only to this endpoint.'
    : draft.rememberKey
      ? 'Optional. With Remember on, the key is saved in this browser unencrypted: any script running on this site can read it. It is sent only to the server it was entered for.'
      : 'Optional. Kept for this browser session only, unencrypted: any script running on this site can read it. It is sent only to the server it was entered for.';

  return (
    <SettingsSection
      id={id}
      headingId={`${id ?? 'model-connection'}-heading`}
      focusableHeading
      title="Model & connection"
      description="Choose what generates answers. Your documents stay here: retrieval runs locally, and with an external model only the question, the retrieved passages and recent conversation are sent to the endpoint. External models are off by default."
      data-testid="external-model-section"
    >
      {notice}
      <SettingsRadioCards<GeneratorSource>
        legend="Generator source"
        name="generator-source"
        isChecked={(value) => source === value}
        onChange={(value) => void handleSourceChange(value)}
        options={[
          {
            value: 'builtin',
            label: 'Built-in model',
            description: desktop
              ? 'Answers are generated by this app on this computer. No external model server is contacted.'
              : 'Answers are generated in this browser. No model server is contacted.',
          },
          {
            value: 'local',
            label: 'Local or network server',
            description:
              'A model server on this computer or your network (for example LM Studio, Ollama or a llama.cpp server), OpenAI- or Anthropic-compatible.' +
              (serverLocked && source !== 'local' ? ' Switch off Use external model to change the server type.' : ''),
            disabled: serverLocked && source !== 'local',
          },
          {
            value: 'cloud',
            label: 'Cloud provider',
            description: cloudBlocked
              ? 'Not available in this air-gapped build: only loopback and private-network endpoints can be used.'
              : 'A hosted provider such as OpenAI or Anthropic. Needs https and usually an API key.' +
                (serverLocked && source !== 'cloud' ? ' Switch off Use external model to change the server type.' : ''),
            disabled: (cloudBlocked || serverLocked) && source !== 'cloud',
          },
        ]}
      />
      {airgap && (
        <p className="settings-text" data-testid="external-airgap-notice">
          Air-gapped build: only loopback and private-network endpoints can be used.
        </p>
      )}

      {!isServer ? (
        <>
          {builtIn}
          <p className="settings-text" data-testid="external-not-applicable">
            No external model server is used. Choose Local or network server or Cloud provider to connect one.
          </p>
        </>
      ) : (
        <SettingsSubsection title="Server connection" headingId={headingId}>
          <p className="settings-text" data-testid="external-usage-state">
            {draft.enabled
              ? 'Answers come from this server. The built-in model settings apply when Built-in model is selected.'
              : 'Not in use yet: answers still come from the built-in model until you switch on Use external model.'}
          </p>

          <Switch
            id="external-enabled"
            checked={draft.enabled}
            aria-checked={draft.enabled}
            onChange={(e) => void handleEnabledChange(e.target.checked)}
            label="Use external model"
          />

          <Field label="Protocol" className="settings-field">
            {(control) => (
              <Select
                {...control}
                value={draft.protocol}
                onChange={(e) => {
                  const protocol = e.target.value === 'anthropic' ? 'anthropic' : 'openai';
                  update({ protocol });
                  setModels([]);
                  void persist({ protocol });
                }}
              >
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic-compatible</option>
              </Select>
            )}
          </Field>

          <Field
            label="Base URL"
            className="settings-field"
            help={
              <>
                {source === 'cloud'
                  ? 'For example https://api.openai.com or https://api.anthropic.com. Public hosts need https.'
                  : 'For example http://localhost:1234 (LM Studio) or http://192.168.1.20:11434 (Ollama on your network).'}
                {!desktop &&
                  ' If this page is served over https, the browser blocks plain-http model servers (mixed content) and may ask to allow local-network access: use https on the server, or the desktop app.'}
              </>
            }
          >
            {(control) => (
              <TextInput
                {...control}
                type="url"
                autoComplete="off"
                spellCheck={false}
                value={draft.baseUrl}
                onChange={(e) => update({ baseUrl: e.target.value })}
                onBlur={() => void handleBaseUrlBlur()}
                placeholder={source === 'cloud' ? 'https://api.openai.com' : 'http://localhost:1234'}
              />
            )}
          </Field>

          <div className="settings-group">
            <Field
              label="API key"
              className="settings-field"
              help={keyHelp}
            >
              {(control) => (
                <PasswordInput
                  {...control}
                  revealLabel="Show API key"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={browserKeySaved ? '' : draft.apiKey}
                  onChange={(e) => {
                    setKeyDropped(false);
                    keyDirtyRef.current = true;
                    fieldKeyOriginRef.current = keyOriginOf(draftRef.current.baseUrl);
                    update({ apiKey: e.target.value });
                  }}
                  onBlur={() => void handleKeyBlur()}
                  placeholder={keySavedHere ? 'Saved' : 'Leave empty for servers without a key'}
                />
              )}
            </Field>
            {browserKeySaved && (
              <p className="settings-text" data-testid="external-key-saved">
                A key is saved for this server. Type a new key to replace it, or clear it.
              </p>
            )}
            {(desktop ? keyState.apiKeySet || keyState.apiKeyBoundOrigin !== '' : draft.apiKey !== '' || browserKey.status !== 'none') && (
              <div className="settings-row">
                <Button variant="secondary" onClick={() => void handleClearKey()}>
                  Clear saved key
                </Button>
              </div>
            )}
            {!desktop && (
              <Checkbox
                id="external-remember-key"
                checked={draft.rememberKey}
                onChange={(e) => {
                  update({ rememberKey: e.target.checked });
                  // Moves the saved key and its binding between storages; never rebinds.
                  void persist({ rememberKey: e.target.checked });
                }}
                label="Remember API key in this browser (otherwise it is kept for this browser session only)"
              />
            )}
            {keyDropped && draft.apiKey === '' && (
              <p className="settings-text" data-testid="external-key-dropped">
                The base URL changed before the API key was saved, so the key was not saved. Enter it again for
                this server.
              </p>
            )}
            {keyHeld && draft.apiKey !== '' && (
              <p className="settings-text" data-testid="external-key-held">
                The API key is not saved yet: it will be saved together with the next valid base URL you
                enter, and sent only to that server.
              </p>
            )}
            {keyElsewhereOrigin !== '' && (
              <p className="settings-text" data-testid="external-key-elsewhere">
                {keyElsewhereText(keyElsewhereOrigin)}
              </p>
            )}
            {plainHttpKey && (
              <p className="settings-text settings-tone--warning">
                This key would be sent over plain http to a network host. Prefer https for servers that need a key.
              </p>
            )}
          </div>

          <Field
            label="Model"
            className="settings-field"
            help={models.length > 0 ? `${models.length} model${models.length === 1 ? '' : 's'} listed by the server; you can also type a name.` : undefined}
          >
            {(control) => (
              <Combobox
                {...control}
                autoComplete="off"
                spellCheck={false}
                value={draft.model}
                options={models}
                onValueChange={(model) => update({ model })}
                onPick={(model) => void handleModelPick(model)}
                onBlur={() => void handleModelBlur()}
                placeholder="Test the connection to list models"
              />
            )}
          </Field>

          <div className="settings-row">
            <Button variant="secondary" onClick={() => void handleTest()} loading={testing} disabled={testing}>
              Test connection
            </Button>
            {testing && <span className="settings-text">Testing…</span>}
          </div>
          <p className="settings-text" data-testid="external-test-note">
            Test connection contacts this server once{desktop ? ' (from the desktop app)' : ' (from this browser)'}, with your
            API key if one is set.
          </p>

          <Switch
            id="external-grounded"
            checked={draft.grounded}
            onChange={(e) => {
              const grounded = e.target.checked;
              update({ grounded });
              void persist({ grounded });
            }}
            label="Use my documents (grounded)"
            description="On: answers use your documents, with citations. Off (Direct chat): questions go straight to the model without retrieval, and answers are labeled General knowledge."
          />

        </SettingsSubsection>
      )}

      {/* M2: whenever egress is off, the built-in model is what answers, so its
          controls stay rendered (engine, download, cache status, run location,
          profile, backend status) under every source. */}
      {isServer && !draft.enabled && (
        <>
          <p className="settings-text" data-testid="builtin-still-answering">
            Until you switch on Use external model, answers come from the built-in model. Its settings:
          </p>
          {builtIn}
        </>
      )}
      {isServer && draft.enabled && (
        <p className="settings-text" data-testid="builtin-not-used">
          The built-in model is not used while the external model answers. Its settings return when you switch
          off Use external model or choose Built-in model.
        </p>
      )}

      {/* L7: the feedback regions are ALWAYS mounted (aria-live from the start, as
          Clear Cache does) and only their content changes, so each message is
          announced; the role is present while there is a message. */}
      <div className="settings-live" aria-live="polite" aria-atomic="true" role={status !== null ? 'status' : undefined}>
        {status !== null && (
          <Banner live={false} tone="success" title="Connection works">
            {status}
          </Banner>
        )}
      </div>
      <div className="settings-live" aria-live="assertive" aria-atomic="true" role={problem !== null ? 'alert' : undefined}>
        {problem !== null && (
          <Banner live={false} tone="danger" title={problemTitle()}>
            {problem}
          </Banner>
        )}
      </div>
    </SettingsSection>
  );
}
