/**
 * Settings page — inference mode (desktop backend / external provider
 * connection), browser engine & model cache status, response quality,
 * appearance, storage management, and about info.
 *
 * Issue #24 rebuild: the page was almost entirely useless — Clear Cache was a
 * no-op (deleted a nonexistent DB), the Model Selection dropdown was dead
 * (persisted but never read by runtime), cache status checked the wrong
 * engine, "System" theme sabotaged itself, readiness showed green while the
 * LLM was missing, memory pressure was static, and radio cards had duplicate
 * a11y semantics. All nine findings are addressed here.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useInferenceMode } from '../lib/inference';
import { fetchModelStatus, isElectron, useDesktopSession } from '../lib/desktop-session';
import type { RAGPreset } from '../lib/rag/rag-presets';
import { fetchFirstRunStatus, resetFirstRun, emitFirstRunReopen } from '../lib/first-run';
import type { ModelStatus } from '../lib/api/types';
import { useTheme, type ThemePreference } from '../lib/theme';
import { ModelDownloadManager, type DownloadProgress } from '../lib/llm/model-download';
import { ModelReadinessGate } from '../lib/llm/model-readiness';
import { WEBLLM_DEFAULT_MODEL_ID } from '../lib/llm/web-llm-service';
import {
  resetReadinessCache,
  ensureReadinessGateChecked,
  modelIdForEngine,
} from '../lib/llm/readiness-gate';
import { detectEngineCapability, type EngineCapability } from '../lib/llm/engine-capability';
import {
  checkPackagedModels,
  type PackagedModelsReport,
  type PackagedModelKind,
} from '../lib/models/model-manifest';
import {
  DESKTOP_PRESET_KEYS,
  DESKTOP_PRESET_SETTINGS,
  RAG_PRESET_LABELS,
  presetFromBackend,
  type DesktopPresetState,
} from '../lib/rag/rag-presets';
import { clearUserSettings } from '../lib/storage/persisted-keys';
import { MODEL_CONNECTION_SECTION_ID } from '../lib/settings-sections';
// AC8 (settings-wiring-honesty): the single version source is
// web_ui/package.json (desktop/package.json is kept in lockstep by test).
import { version as APP_VERSION } from '../../package.json';
import {
  isProviderConfigured,
  loadProviderConfig,
  probeOpenAICompat,
  saveProviderConfig,
  type ProviderConfig,
} from '../lib/llm/openai-provider';
import type { UpdateStatus } from '../types/desktop';
import { getMemoryBudget, getMemoryPressureStatus } from '../lib/embeddings/memory-aware';
import { ModelDownloadProgress } from '../components/ModelDownloadProgress';
import { ProgressBar, StatusBadge, SectionCard } from '../components/SettingsMetrics';
import {
  getProfilePrefix,
  deleteNamespace,
  listStalePrefixes,
} from '../lib/storage/profile';

// ============================================================================
// First-run setup (E2, issue #85): status + manual "Re-run setup" entry.
// Reset clears the wizard state and reopens the App-owned overlay via the
// module-level reopen bus in lib/first-run.
// ============================================================================
function FirstRunSetupCard(): React.ReactElement | null {
  const [statusLine, setStatusLine] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchFirstRunStatus().then((status) => {
      if (cancelled) return;
      if (status === null) return;
      setStatusLine(
        status.state.completed
          ? `Setup completed ${status.state.completedAt || ''} (profile: ${status.state.selectedProfile})${status.rerun ? ' — re-run needed' : ''}`
          : 'Setup has not been completed yet',
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRerun = async (): Promise<void> => {
    await resetFirstRun();
    emitFirstRunReopen();
  };

  if (window.desktopApi === undefined) return null;
  return (
    <section style={sectionStyle} aria-labelledby="first-run-heading" data-testid="first-run-setup-section">
      <h2 id="first-run-heading" style={sectionTitleStyle}>
        First-run setup
      </h2>
      <div style={fieldGroupStyle}>
        <p style={descriptionStyle}>
          {statusLine ?? 'First-run status unavailable (backend starting).'}
        </p>
        <button type="button" onClick={() => void handleRerun()} data-testid="first-run-rerun">
          Re-run setup
        </button>
      </div>
    </section>
  );
}

// ============================================================================
// Updates (E5, issue #88): opt-in toggle (default OFF), check-now, status.
// Offline-first: the main process makes zero network calls until the toggle
// is switched on; the notice surfaces here AND on the packs panel.
// ============================================================================
function UpdatesSection(): React.ReactElement {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openBusy, setOpenBusy] = useState(false);
  const errorRef = React.useRef<HTMLParagraphElement | null>(null);

  const showError = (message: string): void => {
    setError(message);
    // Move keyboard focus to the error so AT/keyboard users land on it (PRR-012).
    queueMicrotask(() => errorRef.current?.focus());
  };

  useEffect(() => {
    const bridge = window.desktopApi;
    if (bridge === undefined) return undefined;
    let cancelled = false;
    // Optional calls: a bridge without the E5 methods (older main) keeps the
    // controls disabled instead of crashing the settings page.
    void bridge
      .getUpdateStatus?.()
      ?.then((initial) => {
        if (!cancelled) setStatus(initial);
      })
      .catch(() => {
        /* update IPC not ready (older main) — controls stay disabled */
      });
    const unsubscribe = bridge.onUpdateAvailable?.((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const handleToggle = async (): Promise<void> => {
    if (status === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.desktopApi?.setUpdateOptIn?.(!status.optIn);
      if (result !== undefined && !result.ok && result.detail) showError(result.detail);
      if (result?.status !== undefined) setStatus(result.status);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Failed to change the updates setting');
    } finally {
      setBusy(false);
    }
  };

  const handleCheckNow = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.desktopApi?.checkForUpdates?.();
      if (result !== undefined && !result.ok && result.detail) showError(result.detail);
      if (result?.status !== undefined) setStatus(result.status);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Update check failed');
    } finally {
      setBusy(false);
    }
  };

  const handleOpenDownload = async (url: string): Promise<void> => {
    if (url === '') return;
    setOpenBusy(true);
    try {
      const result = await window.desktopApi?.openUpdateExternal?.(url);
      if (result !== undefined && !result.ok && result.detail) showError(result.detail);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Could not open the download page');
    } finally {
      setOpenBusy(false);
    }
  };

  return (
    <div style={fieldGroupStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
          <input
            type="checkbox"
            data-testid="updates-opt-in"
            checked={status?.optIn ?? false}
            disabled={busy || status === null}
            aria-busy={busy}
            onChange={() => void handleToggle()}
          />
          <span>Check for updates automatically (opt-in; the app works fully offline)</span>
        </label>
        <button
          type="button"
          data-testid="updates-check-now"
          aria-busy={busy}
          disabled={busy || status === null || !status.optIn}
          onClick={() => void handleCheckNow()}
        >
          {busy ? 'Checking…' : 'Check for updates now'}
        </button>
      </div>
      {error !== null && (
        <p
          role="alert"
          ref={errorRef}
          tabIndex={-1}
          style={{ ...descriptionStyle, color: 'var(--color-danger, #c00)', outline: 'none' }}
          data-testid="updates-error"
        >
          {error}
        </p>
      )}
      {status !== null && status.optIn && status.error !== null && (
        <p role="alert" style={{ ...descriptionStyle, color: 'var(--color-danger, #c00)' }}>
          Last check failed: {status.error}
        </p>
      )}
      {status !== null && status.optIn && status.appUpdate !== null && (
        <p style={descriptionStyle} data-testid="updates-app-available">
          App update available: v{status.appUpdate.availableVersion} (currently v
          {status.appUpdate.currentVersion}).{' '}
          <button
            type="button"
            data-testid="updates-app-open-download"
            disabled={openBusy}
            onClick={() => void handleOpenDownload(status.appUpdate?.downloadUrl ?? '')}
          >
            Open download page
          </button>{' '}
          and run the installer to update; your data is kept. Download URL (copyable):{' '}
          <code style={{ wordBreak: 'break-all' }} data-testid="updates-app-url">
            {status.appUpdate.downloadUrl}
          </code>
          . Expected sha256:{' '}
          <code style={{ wordBreak: 'break-all' }} data-testid="updates-app-sha256">
            {status.appUpdate.sha256}
          </code>{' '}
          (verify the downloaded file against it before running, per docs/updates.md).
        </p>
      )}
      {status !== null && status.optIn && status.refused.length > 0 && (
        <p style={descriptionStyle} data-testid="updates-refused">
          {status.refused.length} update{status.refused.length === 1 ? '' : 's'} refused (signature
          verification failed):{' '}
          {status.refused.map((entry) => `${entry.packId} v${entry.version}`).join(', ')}
        </p>
      )}
      {status !== null && status.optIn && status.checkedAt !== null && (
        <p role="status" aria-live="polite" style={descriptionStyle} data-testid="updates-status-line">
          Last checked {new Date(status.checkedAt).toLocaleString()}. Pack updates, if any, are
          surfaced on the Knowledge Packs panel (Documents page).
        </p>
      )}
      <p style={descriptionStyle}>
        Update feeds are Ed25519-signed; anything failing signature verification is refused with no
        unsigned fallback. See the Updates runbook (docs/updates.md) for the feed format.
      </p>
    </div>
  );
}

// ============================================================================
// Legacy settings store (IndexedDB)
// ============================================================================

/**
 * Pre-settings-wiring-honesty builds kept the browser API-server URL in this
 * IndexedDB database. The browser app no longer has an API-server mode (AC4),
 * so nothing reads or writes it; Clear Cache still deletes it so data written
 * by earlier builds does not linger.
 */
const SETTINGS_DB_NAME = 'doc-qa-settings';

// ============================================================================
// EdgeVec blob deletion (Clear Cache — issue #24 F1, resolves PRR-008)
// ============================================================================

/**
 * Delete this profile's HNSW vector blob from the shared `edgevec-db`.
 *
 * The blob is stored as a VALUE keyed by `${prefix}-doc-qa-index`
 * (`getStorageDbNames().vector`) in the `'data'` object store of `edgevec-db`
 * (see vite.config.ts `IndexedDbBackend` + vector-index.ts `INDEX_NAME`).
 * Deleting only this key preserves other profiles' blobs — deleting the whole
 * `edgevec-db` would affect ALL profiles.
 *
 * F-003/PRR-002: rejects on genuine failures (open error, tx error, tx abort)
 * so the caller's catch block surfaces "Could not clear all data" instead of
 * falsely reporting success. The "DB/store doesn't exist" path resolves
 * cleanly (nothing to delete — that's not an error). A synchronous throw from
 * `db.transaction()` also rejects so no connection is leaked.
 */
function deleteEdgeVecBlob(prefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      // No IndexedDB at all → nothing to delete; not an error.
      resolve();
      return;
    }
    const vectorKey = `${prefix}-doc-qa-index`;
    const fail = (reason: string) => reject(new Error(reason));
    try {
      const req = indexedDB.open('edgevec-db', 1);
      req.onupgradeneeded = () => {
        // The DB may not exist yet in this session; ensure the 'data' store
        // so the subsequent transaction does not throw.
        const db = req.result;
        if (!db.objectStoreNames.contains('data')) {
          db.createObjectStore('data');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('data')) {
          // No store → no blob to delete. Clean exit, not an error.
          db.close();
          resolve();
          return;
        }
        try {
          const tx = db.transaction('data', 'readwrite');
          const store = tx.objectStore('data');
          store.delete(vectorKey);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          // PRR-002: handle abort (quota, competing tx) so the Promise does
          // not hang. F-003: reject on error/abort so the caller knows.
          tx.onerror = () => {
            db.close();
            fail('EdgeVec transaction error');
          };
          tx.onabort = () => {
            db.close();
            fail('EdgeVec transaction aborted');
          };
        } catch (txErr) {
          db.close();
          fail(`EdgeVec transaction failed: ${txErr instanceof Error ? txErr.message : String(txErr)}`);
        }
      };
      req.onerror = () => fail('Failed to open edgevec-db');
      req.onblocked = () => fail('edgevec-db open blocked');
    } catch (openErr) {
      fail(`edgevec-db open threw: ${openErr instanceof Error ? openErr.message : String(openErr)}`);
    }
  });
}

// ============================================================================
// Styles
// ============================================================================

const pageStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100%',
  // Single-scroller ownership (trace external-llm-provider-settings): the
  // AppLayout <main> is the ONLY scroller — a nested overflow here produced
  // two visible scrollbars and let the header (which scrolled in this
  // container) intersect section content.
  backgroundColor: 'var(--color-bubble-assistant)',
};

const headerStyle: React.CSSProperties = {
  padding: 'var(--spacing-xl) var(--spacing-xxl)',
  borderBottom: '1px solid var(--color-bubble-system)',
};

const titleStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-h1)',
  fontFamily: 'var(--font-family)',
  fontWeight: 600,
  color: 'var(--color-text-on-bubble-assistant)',
  margin: 0,
};

const contentStyle: React.CSSProperties = {
  flex: 1,
  padding: 'var(--spacing-xxl)',
  // No nested scroller here (trace external-llm-provider-settings): the page
  // scrolls in the AppLayout <main> so header and content move together.
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--spacing-xxl)',
  maxWidth: '720px',
  width: '100%',
  margin: '0 auto',
};

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--spacing-lg)',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-h2)',
  fontFamily: 'var(--font-family)',
  fontWeight: 600,
  color: 'var(--color-text-on-bubble-assistant)',
  margin: 0,
  paddingBottom: 'var(--spacing-sm)',
  borderBottom: '1px solid var(--color-bubble-system)',
};

const fieldGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--spacing-md)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-body)',
  fontFamily: 'var(--font-family)',
  color: 'var(--color-text-on-bubble-assistant)',
  fontWeight: 500,
};

const descriptionStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-caption)',
  fontFamily: 'var(--font-family)',
  color: 'var(--color-text-muted)',
  // No negative top margin (trace external-llm-provider-settings): the old
  // `calc(-1 * var(--spacing-sm))` pulled every description up into the
  // preceding control's line box, visually overprinting radio-card titles.
  marginTop: 0,
};

const radioGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--spacing-sm)',
};

const radioOptionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--spacing-sm)',
  padding: 'var(--spacing-md)',
  backgroundColor: 'var(--color-bubble-system)',
  borderRadius: '6px',
  cursor: 'pointer',
  border: '2px solid transparent',
  transition: 'border-color 0.15s ease',
};

const radioOptionSelectedStyle: React.CSSProperties = {
  ...radioOptionStyle,
  // Full shorthand (issue #41 / trace external-llm-provider-settings): mixing
  // this longhand with the shorthand `border` above made React warn under
  // jsdom and risked a stale border frame on selection.
  border: '2px solid var(--color-primary)',
};

const radioInputStyle: React.CSSProperties = {
  width: '16px',
  height: '16px',
  accentColor: 'var(--color-primary)',
  cursor: 'pointer',
  flexShrink: 0,
};

const radioLabelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-body)',
  fontFamily: 'var(--font-family)',
  color: 'var(--color-text-on-bubble-assistant)',
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 'var(--spacing-md)',
  backgroundColor: 'var(--color-bubble-system)',
  border: '1px solid var(--color-secondary)',
  borderRadius: '6px',
  fontSize: 'var(--font-size-body)',
  fontFamily: 'var(--font-family)',
  color: 'var(--color-text-on-bubble-assistant)',
  boxSizing: 'border-box',
};

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 'var(--spacing-md)',
  alignItems: 'center',
  flexWrap: 'wrap',
};

const primaryButtonStyle: React.CSSProperties = {
  padding: 'var(--spacing-sm) var(--spacing-lg)',
  backgroundColor: 'var(--color-primary)',
  color: 'var(--color-text-on-primary)',
  border: 'none',
  borderRadius: '6px',
  fontSize: 'var(--font-size-body)',
  fontFamily: 'var(--font-family)',
  cursor: 'pointer',
  transition: 'background-color 0.15s ease',
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: 'var(--spacing-sm) var(--spacing-lg)',
  backgroundColor: 'var(--color-bubble-system)',
  color: 'var(--color-text-on-bubble-assistant)',
  border: '1px solid var(--color-secondary)',
  borderRadius: '6px',
  fontSize: 'var(--font-size-body)',
  fontFamily: 'var(--font-family)',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
};

const dangerButtonStyle: React.CSSProperties = {
  padding: 'var(--spacing-sm) var(--spacing-lg)',
  backgroundColor: 'var(--color-danger)',
  color: 'var(--color-text-on-primary)',
  border: 'none',
  borderRadius: '6px',
  fontSize: 'var(--font-size-body)',
  fontFamily: 'var(--font-family)',
  cursor: 'pointer',
  transition: 'background-color 0.15s ease',
};

const storageInfoStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--spacing-sm)',
  padding: 'var(--spacing-lg)',
  backgroundColor: 'var(--color-bubble-system)',
  borderRadius: '6px',
};

const storageRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: 'var(--font-size-body)',
  fontFamily: 'var(--font-family)',
  color: 'var(--color-text-on-bubble-assistant)',
};

const storageLabelStyle: React.CSSProperties = {
  color: 'var(--color-text-muted)',
};

const aboutSectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--spacing-sm)',
  fontSize: 'var(--font-size-body)',
  fontFamily: 'var(--font-family)',
  color: 'var(--color-text-muted)',
};

// ============================================================================
// SettingsPage (inner component — uses contexts)
// ============================================================================

/** The browser-stored user settings Clear Cache removes (persisted-keys.ts USER_SETTING_KEYS). */
const CLEARED_SETTINGS_COPY =
  'inference mode, browser engine and response-quality choices, theme, provider connection and API key, sidebar state and last-opened course';

/** Delay between "Cache cleared" and the reload, so the status is visible/announced. */
const RELOAD_AFTER_CLEAR_MS = 500;

interface SettingsPageProps {
  /**
   * settings-wiring-honesty (AC10): scroll to the element with this id and
   * focus its heading on open (e.g. 'model-connection' from the
   * model-blocked overlay). Omitted: the page opens at the top.
   */
  initialSection?: string;
  /** Clear Cache reload seam (default: window.location.reload()). */
  reloadPage?: () => void;
}

function SettingsPageInner({ initialSection, reloadPage }: SettingsPageProps): React.ReactElement {
  const {
    mode,
    browserEngine,
    setBrowserEngine,
    ragPreset,
    setRagPreset,
    setMode,
  } = useInferenceMode();

  // B9 (issue #67): inside Electron, RAG presets and the inference profile
  // persist SERVER-SIDE via PUT /settings (survives restart through the
  // backend's settings sidecar), and the Desktop backend status section
  // shows connectivity + model presence + the active profile.
  const { session: desktopSession } = useDesktopSession();
  const electronMode = isElectron() && desktopSession !== null;
  // settings-wiring-honesty (AC4): the desktop app (Electron) is the only
  // place an API-server ("api") mode exists — its built-in backend.
  const desktopApp = isElectron();
  const [desktopStatus, setDesktopStatus] = useState<ModelStatus | null>(null);
  const [desktopProfile, setDesktopProfile] = useState<'quality' | 'fast' | 'auto' | ''>('');
  const [desktopSettingsError, setDesktopSettingsError] = useState<string | null>(null);

  const { themePreference, setTheme } = useTheme();

  // Download state
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isQuotaError, setIsQuotaError] = useState(false);
  const downloadManagerRef = useRef<ModelDownloadManager | null>(null);

  // Readiness state
  const [modelCached, setModelCached] = useState<boolean>(false);
  const [readinessGate] = useState(() => new ModelReadinessGate());

  // Storage state
  const [memoryPressure, setMemoryPressure] = useState<'normal' | 'moderate' | 'critical'>('normal');
  const [memoryAvailable, setMemoryAvailable] = useState<number>(0);
  const [memoryTotal, setMemoryTotal] = useState<number>(0);

  // Clear cache confirm + result state (issue #24 F1)
  const [clearCacheState, setClearCacheState] = useState<'idle' | 'confirming'>('idle');
  const [clearCacheResult, setClearCacheResult] = useState<'idle' | 'clearing' | 'cleared' | 'error'>('idle');
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  // Provider connection state (trace external-llm-provider-settings): local
  // draft seeded from the persisted config; blur-persists via the storage
  // helpers in lib/llm/openai-provider.
  const [providerDraft, setProviderDraft] = useState<ProviderConfig>(() => loadProviderConfig());
  const [isTestingProvider, setIsTestingProvider] = useState(false);
  const [providerProbe, setProviderProbe] = useState<'success' | 'error' | null>(null);
  const [providerProbeDetail, setProviderProbeDetail] = useState<string | null>(null);
  // Latest draft as a ref so an in-flight probe result can be validated against
  // the CURRENT fields before it lands (review finding: a result computed for
  // an edited-out URL must not be displayed as if it described the new one).
  const providerDraftRef = useRef(providerDraft);
  providerDraftRef.current = providerDraft;
  const handleProviderFieldChange = useCallback((patch: Partial<ProviderConfig>) => {
    // Any field edit invalidates a prior probe result — a stale Connected
    // badge must never survive an edited URL (review finding).
    setProviderProbe(null);
    setProviderProbeDetail(null);
    setProviderDraft((prev) => ({ ...prev, ...patch }));
  }, []);
  const handleProviderFieldBlur = useCallback(
    (patch: Partial<ProviderConfig>) => {
      setProviderDraft((prev) => {
        const next = { ...prev, ...patch };
        saveProviderConfig(next);
        return next;
      });
    },
    []
  );
  const handleTestProvider = useCallback(async () => {
    const requestedBaseUrl = providerDraft.baseUrl;
    setIsTestingProvider(true);
    setProviderProbe(null);
    setProviderProbeDetail(null);
    // Send the configured key so key-protected servers (vLLM --api-key, LM
    // Studio auth) exercise their real auth path instead of 401-ing as
    // "cannot reach" (review finding).
    const result = await probeOpenAICompat(providerDraft.baseUrl, {
      apiKey: providerDraft.apiKey,
    });
    if (!isMountedRef.current) return;
    if (providerDraftRef.current.baseUrl !== requestedBaseUrl) {
      // The URL was edited while the probe was in flight — the result is
      // about a server the user is no longer looking at.
      setIsTestingProvider(false);
      return;
    }
    setIsTestingProvider(false);
    setProviderProbe(result.ok ? 'success' : 'error');
    setProviderProbeDetail(result.ok ? null : (result.detail ?? 'Connection failed'));
  }, [providerDraft.baseUrl, providerDraft.apiKey]);

  // Hardware capability + packaged-model readiness (Phase 3)
  const [capability, setCapability] = useState<EngineCapability | null>(null);
  const [packagesReady, setPackagesReady] = useState<PackagedModelsReport | null>(null);

  // settings-wiring-honesty: the desktop Response Quality display state is
  // derived from the backend (GET/PUT /settings), never from the persisted
  // browser-local `ragPreset`. null = not read yet (no radio checked).
  const [desktopPreset, setDesktopPreset] = useState<DesktopPresetState | null>(null);
  // The last desktop settings body (reranker availability for the cards).
  const [desktopSettings, setDesktopSettings] = useState<Record<string, unknown> | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  // Latest-wins: every preset GET/PUT takes a ticket and a response whose
  // ticket is stale (a newer read or write started) is ignored, so a GET
  // issued before a PUT can never overwrite that PUT's result.
  const presetTicketRef = useRef(0);

  const applyDesktopSettings = useCallback((settings: Record<string, unknown>) => {
    setDesktopSettings(settings);
    setDesktopPreset(presetFromBackend(settings));
  }, []);

  // B9 (issue #67) + settings-wiring-honesty (AC1/AC2): read the desktop
  // backend's settings when the session appears (mount) AND whenever the app
  // switches into api mode, and derive the Response Quality display state
  // from them — never a silent PUT.
  const desktopReadRef = useRef<{ session: typeof desktopSession; mode: string | null }>({ session: null, mode: null });
  useEffect(() => {
    const previous = desktopReadRef.current;
    desktopReadRef.current = { session: desktopSession, mode };
    if (!electronMode || !desktopSession) return;
    const sessionChanged = previous.session !== desktopSession;
    const enteredApi = mode === 'api' && previous.mode !== 'api';
    if (!sessionChanged && !enteredApi) return;
    const ticket = ++presetTicketRef.current;
    (async () => {
      try {
        const settings = await desktopSession.apiClient.getSettings();
        if (!isMountedRef.current) return;
        const profile = settings['inference.profile'];
        if (profile === 'quality' || profile === 'fast' || profile === 'auto') {
          setDesktopProfile(profile);
        }
        if (ticket === presetTicketRef.current) applyDesktopSettings(settings as Record<string, unknown>);
      } catch (err) {
        if (isMountedRef.current) setDesktopSettingsError(err instanceof Error ? err.message : String(err));
      }
      if (!sessionChanged) return;
      try {
        const status = await fetchModelStatus(desktopSession);
        if (isMountedRef.current) setDesktopStatus(status);
      } catch {
        if (isMountedRef.current) setDesktopStatus(null);
      }
    })();
  }, [electronMode, desktopSession, mode, applyDesktopSettings]);

  // B9: persist an inference-profile override to the backend (AC3 — survives
  // restart through the backend's settings sidecar).
  const handleDesktopProfileChange = useCallback(
    (profile: 'quality' | 'fast' | 'auto') => {
      if (!desktopSession) return;
      setDesktopProfile(profile);
      desktopSession.apiClient
        .updateSettings({ 'inference.profile': profile })
        .catch((err) => setDesktopSettingsError(err instanceof Error ? err.message : String(err)));
    },
    [desktopSession]
  );

  // settings-wiring-honesty (AC2/AC3; user decision 2026-09-30, reversing PR
  // #138's rag_n_results-only mirror): with a desktop session, a preset change
  // PUTs the preset's full patch — result count, reranking, max tokens and
  // temperature — in EVERY mode, since the preset is a backend setting there.
  // The browser app has no backend to write; its preset applies to
  // browser-local chat only (the persisted `ragPreset`).
  const handleRagPresetChange = useCallback(
    (preset: RAGPreset) => {
      setPresetError(null);
      if (desktopApp && !desktopSession) {
        // Desktop app whose backend session is not up: nothing is applied
        // and the controlled radios keep showing the previous selection.
        setPresetError('The desktop backend is not available, so the preset was not applied. Try again once it has started.');
        return;
      }
      const previousRagPreset = ragPreset;
      setRagPreset(preset);
      if (!desktopSession) return;
      const previousDisplay = desktopPreset;
      const ticket = ++presetTicketRef.current;
      setDesktopPreset({ kind: 'preset', preset });
      desktopSession.apiClient
        .updateSettings({ ...DESKTOP_PRESET_SETTINGS[preset] })
        .then((response) => {
          if (!isMountedRef.current || ticket !== presetTicketRef.current) return;
          const body = response as unknown as Record<string, unknown> | null;
          // A backend that reports explicit_keys confirms what it stored.
          if (body !== null && typeof body === 'object' && Array.isArray(body.explicit_keys)) {
            applyDesktopSettings(body);
          }
        })
        .catch((err) => {
          if (!isMountedRef.current || ticket !== presetTicketRef.current) return;
          setDesktopPreset(previousDisplay);
          setRagPreset(previousRagPreset);
          setPresetError(
            `The preset could not be applied to the desktop backend: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },
    [desktopApp, desktopSession, desktopPreset, ragPreset, setRagPreset, applyDesktopSettings]
  );

  // settings-wiring-honesty (IC1): "Reset to defaults" clears the preset keys
  // on the desktop backend (the PUT `reset` directive), so result count,
  // reranking and generation follow the server/profile defaults again. The
  // response's explicit_keys confirm the reset.
  const handlePresetReset = useCallback(() => {
    if (!desktopSession) return;
    setPresetError(null);
    const ticket = ++presetTicketRef.current;
    desktopSession.apiClient
      .updateSettings({ reset: [...DESKTOP_PRESET_KEYS] })
      .then(async (response) => {
        const body = response as unknown as Record<string, unknown> | null;
        const settings =
          body !== null && typeof body === 'object' && Array.isArray(body.explicit_keys)
            ? body
            : ((await desktopSession.apiClient.getSettings()) as Record<string, unknown>);
        if (!isMountedRef.current || ticket !== presetTicketRef.current) return;
        applyDesktopSettings(settings);
      })
      .catch((err) => {
        if (!isMountedRef.current || ticket !== presetTicketRef.current) return;
        setPresetError(
          `The desktop backend could not reset the preset: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }, [desktopSession, applyDesktopSettings]);

  // isMountedRef to guard async state updates after unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
      if (reloadTimeoutRef.current) clearTimeout(reloadTimeoutRef.current);
    };
  }, []);

  // settings-wiring-honesty (AC10): open at a requested section — scroll it
  // into view and move focus to its heading (tabIndex -1) so keyboard and
  // screen-reader users land on the destination, not the page top.
  useEffect(() => {
    if (!initialSection) return;
    const target = document.getElementById(initialSection);
    if (target === null) return;
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
    const heading = target.querySelector<HTMLElement>('h2');
    (heading ?? target).focus();
  }, [initialSection]);

  // Check model cache status — engine-aware (issue #24 F4).
  // Previously this called checkModelCached(preferredModel) which defaulted
  // engine='webllm', so a wllama user saw "Not cached" for their packaged GGUF.
  // Now resolve the model id per-engine via modelIdForEngine and pass the
  // actually-selected browserEngine.
  useEffect(() => {
    // PRR-004: cancellation token prevents an older, slower checkModelCached
    // promise from overwriting modelCached with stale data after a rapid
    // engine switch. Mirrors the cancelled-flag pattern in the detect effect.
    let cancelled = false;
    const modelId = modelIdForEngine(browserEngine);
    readinessGate.checkModelCached(modelId, browserEngine).then((cached) => {
      if (!cancelled && isMountedRef.current) setModelCached(cached);
    });
    return () => {
      cancelled = true;
    };
  }, [browserEngine, readinessGate]);

  // Detect hardware capability + packaged-model readiness once on mount.
  useEffect(() => {
    let cancelled = false;
    detectEngineCapability().then((cap) => {
      if (!cancelled) setCapability(cap);
    });
    checkPackagedModels().then((report) => {
      if (!cancelled) setPackagesReady(report);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Update memory pressure periodically (issue #24 F7).
  // Previously ran exactly once; now refreshes every 5s while Settings is open.
  useEffect(() => {
    const updateMemoryStatus = () => {
      const pressure = getMemoryPressureStatus();
      const budget = getMemoryBudget();
      setMemoryPressure(pressure);
      setMemoryAvailable(budget.availableMB);
      setMemoryTotal(budget.totalMB);
    };

    updateMemoryStatus();
    const intervalId = setInterval(updateMemoryStatus, 5000);
    return () => clearInterval(intervalId);
  }, []);

  // Handle theme preference change (issue #24 F5).
  // Delegates entirely to ThemeContext.setTheme, which persists/clears
  // localStorage['theme-preference'] and applies the theme. 'system' clears
  // the stored preference so the OS media-query listener follows changes.
  const handleThemeChange = useCallback(
    (newTheme: ThemePreference) => {
      setTheme(newTheme);
    },
    [setTheme]
  );

  // Download model (issue #24 F3).
  // webllm-only: downloads weights from the WebLLM CDN into Cache Storage.
  // wllama weights are packaged same-origin and need no download.
  const handleDownloadModel = useCallback(async () => {
    // PRR-006: engine guard — only webllm has a download step. The UI button
    // is also gated to webllm, but this prevents a future caller from
    // triggering a webllm download while wllama is selected.
    if (browserEngine !== 'webllm') return;

    if (!downloadManagerRef.current) {
      downloadManagerRef.current = new ModelDownloadManager();
    }

    setIsDownloading(true);
    setIsQuotaError(false);
    setDownloadProgress(null);

    try {
      await downloadManagerRef.current.downloadModel(WEBLLM_DEFAULT_MODEL_ID, (progress) => {
        if (!isMountedRef.current) return;
        setDownloadProgress(progress);
        if (progress.status === 'complete') {
          setModelCached(true);
          setIsDownloading(false);
          // Re-dispatch the readiness gate so the rest of the app (e.g. the chat
          // model-block overlay) flips to isModelReady=true now that the model
          // is in Cache Storage. Without this, the cached readiness result still
          // reports modelCached=false until an engine switch forces a re-check.
          // (issue #21 F3)
          resetReadinessCache();
          void ensureReadinessGateChecked('webllm');
        } else if (progress.status === 'error') {
          setIsDownloading(false);
        }
      });
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('quota') ||
        message.includes('QuotaExceededError') ||
        message.includes('IndexedDB')
      ) {
        setIsQuotaError(true);
      }
      setIsDownloading(false);
    }
  }, [browserEngine]);

  // Cancel download
  const handleCancelDownload = useCallback(() => {
    downloadManagerRef.current?.cancelDownload();
    setIsDownloading(false);
  }, []);

  // Clear cache (two-click confirm) — issue #24 F1.
  // Previously deleted a nonexistent bare 'doc-qa-documents' DB (no profile
  // prefix) and an OPFS dir no engine uses — a near-total no-op. Now reuses
  // PR-4's profile-scoped namespace utilities to delete the real user-prefixed
  // document/keyword/vector-mapping DBs, the EdgeVec HNSW blob, stale orphan
  // namespaces, the settings DB, and the webllm Cache Storage entries.
  // settings-wiring-honesty (AC5): it also removes every registered
  // browser-stored user setting (lib/storage/persisted-keys) and then reloads,
  // so the in-memory contexts cannot re-persist the cleared values.
  const handleClearCacheClick = useCallback(async () => {
    if (clearCacheState === 'idle') {
      setClearCacheState('confirming');
      clearTimeoutRef.current = setTimeout(() => {
        setClearCacheState('idle');
        clearTimeoutRef.current = null;
      }, 3000);
    } else if (clearCacheState === 'confirming') {
      // Second click — clear cache
      if (clearTimeoutRef.current) {
        clearTimeout(clearTimeoutRef.current);
        clearTimeoutRef.current = null;
      }
      setClearCacheState('idle');
      setClearCacheResult('clearing');
      // An in-flight model download is cancelled first (its cache entries are
      // about to be deleted underneath it).
      if (isDownloading) handleCancelDownload();

      let cleared = false;
      try {
        // 1. Current profile's document/keyword/vector-mapping IndexedDBs.
        const prefix = getProfilePrefix();
        await deleteNamespace(prefix);

        // 2. EdgeVec HNSW blob (key in shared edgevec-db, store 'data').
        //    Resolves PRR-008: deleteNamespace cannot reach this shared DB.
        await deleteEdgeVecBlob(prefix);

        // 3. Stale/orphan namespaces from prior sessions/profiles.
        const stale = await listStalePrefixes();
        if (stale.length > 0) {
          await Promise.all(stale.map((p) => deleteNamespace(p)));
        }

        // 4. Legacy settings IndexedDB (non-prefixed; written by earlier builds).
        await new Promise<void>((resolve) => {
          const settingsDeleteReq = indexedDB.deleteDatabase(SETTINGS_DB_NAME);
          settingsDeleteReq.onsuccess = () => resolve();
          settingsDeleteReq.onerror = () => resolve();
          settingsDeleteReq.onblocked = () => resolve();
        });

        // 5. WebLLM Cache Storage (web-llm scopes artifacts across three
        //    named caches: model weights, model config, and the wasm runtime).
        if (typeof caches !== 'undefined' && typeof caches.delete === 'function') {
          await Promise.all(
            ['webllm/model', 'webllm/config', 'webllm/wasm'].map((cacheName) =>
              caches.delete(cacheName).catch(() => {})
            )
          );
        }

        // 6. Every registered browser-stored user setting (inference mode
        //    blob incl. provider connection, theme, provider API key, sidebar,
        //    last-opened course). Internal bookkeeping keys are kept.
        clearUserSettings();

        setClearCacheResult('cleared');
        cleared = true;
      } catch (err) {
        console.error('Error clearing cache:', err);
        setClearCacheResult('error');
      }

      // Reload so every context starts from the cleared storage (the React
      // state still holds the old values until then).
      if (cleared) {
        reloadTimeoutRef.current = setTimeout(() => {
          reloadTimeoutRef.current = null;
          if (isMountedRef.current) (reloadPage ?? (() => window.location.reload()))();
        }, RELOAD_AFTER_CLEAR_MS);
      }

      // Clear the result status after a few seconds so it doesn't linger.
      if (clearTimeoutRef.current) {
        clearTimeout(clearTimeoutRef.current);
      }
      clearTimeoutRef.current = setTimeout(() => {
        setClearCacheResult('idle');
        clearTimeoutRef.current = null;
      }, 3000);
    }
  }, [clearCacheState, isDownloading, handleCancelDownload, reloadPage]);

  // settings-wiring-honesty: in the desktop app the checked preset reflects
  // the BACKEND (none checked while unread, custom, or on defaults); in the
  // browser app it is the persisted browser-local preset.
  const presetChecked = (preset: RAGPreset): boolean =>
    electronMode
      ? desktopPreset?.kind === 'preset' && desktopPreset.preset === preset
      : ragPreset === preset;
  // The browser app's preset only feeds browser-local chat, which provider
  // mode bypasses; the desktop app's preset is a backend setting (any mode).
  const presetDisabled = mode === 'provider' && !electronMode;
  const rerankUnavailable = electronMode && desktopSettings?.reranking_available === false;

  // Format memory for display
  const formatMemory = (mb: number): string => {
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${mb} MB`;
  };

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={titleStyle}>Settings</h1>
      </div>

      <div style={contentStyle}>
        {/* ================================================================== */}
        {/* 1. Inference Mode */}
        {/* ================================================================== */}
        {/* settings-wiring-honesty (AC10): id={MODEL_CONNECTION_SECTION_ID}
            marks the section hosting the external-model (OpenAI-compatible
            provider) controls — the model-blocked overlay's destination. */}
        <section
          id={MODEL_CONNECTION_SECTION_ID}
          style={sectionStyle}
          aria-labelledby="inference-mode-heading"
        >
          <h2 id="inference-mode-heading" style={sectionTitleStyle} tabIndex={-1}>
            Inference Mode
          </h2>
          <div style={fieldGroupStyle}>
            <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>Select inference mode</legend>
              <div style={radioGroupStyle}>
                {/* Browser-local option */}
                {/* Radio a11y (issue #24 F9): the wrapping <label> is presentational
                    (no role="radio"); the native <input type="radio"> is the sole
                    AT-facing radio. Clicking the card checks the input via native
                    label behavior — no duplicate onClick, no double-fire. */}
                <label
                  style={mode === 'browser-local' ? radioOptionSelectedStyle : radioOptionStyle}
                >
                  <input
                    type="radio"
                    name="inference-mode"
                    value="browser-local"
                    checked={mode === 'browser-local'}
                    onChange={() => setMode('browser-local')}
                    style={radioInputStyle}
                    aria-describedby="browser-local-desc"
                  />
                  <div>
                    <span style={radioLabelStyle}>Browser-local</span>
                    <p id="browser-local-desc" style={descriptionStyle}>
                      Run the AI directly in your browser (CPU via wllama, or WebGPU via WebLLM — choose below)
                    </p>
                  </div>
                </label>

                {/* API server option — the desktop app's built-in backend.
                    settings-wiring-honesty (AC4): the browser app has no
                    API-server mode, so it is offered only inside Electron. */}
                {desktopApp && (
                  <label
                    style={mode === 'api' ? radioOptionSelectedStyle : radioOptionStyle}
                  >
                    <input
                      type="radio"
                      name="inference-mode"
                      value="api"
                      checked={mode === 'api'}
                      onChange={() => setMode('api')}
                      style={radioInputStyle}
                      aria-describedby="api-desc"
                    />
                    <div>
                      <span style={radioLabelStyle}>API Server</span>
                      <p id="api-desc" style={descriptionStyle}>
                        Use the built-in desktop backend (starts automatically with the app)
                      </p>
                    </div>
                  </label>
                )}

                {/* Provider option (trace external-llm-provider-settings):
                    direct chat against a user-configured OpenAI-compatible
                    server. The card text must not contain "model", "base url",
                    or "api key" (any case) — the provider section's labeled
                    inputs below must stay the ONLY matches for those queries. */}
                <label
                  style={mode === 'provider' ? radioOptionSelectedStyle : radioOptionStyle}
                >
                  <input
                    type="radio"
                    name="inference-mode"
                    value="provider"
                    checked={mode === 'provider'}
                    onChange={() => setMode('provider')}
                    style={radioInputStyle}
                    aria-describedby="provider-desc"
                  />
                  <div>
                    <span style={radioLabelStyle}>Provider server (OpenAI-compatible)</span>
                    <p id="provider-desc" style={descriptionStyle}>
                      Send chat directly to an OpenAI-compatible server on this machine (loopback
                      only in this release). Configure the connection below.
                    </p>
                  </div>
                </label>
              </div>
            </fieldset>
          </div>
        </section>

        {/* ================================================================== */}
        {/* 2a. Desktop backend status (Electron mode only — issue #67).       */}
        {/* Shows the hosted backend's connectivity, active inference profile */}
        {/* and per-profile model presence; the profile override persists via */}
        {/* PUT /settings across app restarts (backend settings sidecar).     */}
        {/* ================================================================== */}
        {electronMode && (
          <section style={sectionStyle} aria-labelledby="desktop-backend-heading">
            <h2 id="desktop-backend-heading" style={sectionTitleStyle}>
              Desktop backend
            </h2>
            <div style={fieldGroupStyle}>
              <p style={descriptionStyle}>
                This app is using its built-in desktop backend
                {desktopSession ? ` at ${desktopSession.baseUrl}` : ''}. Settings below
                are stored by the backend and survive restarts.
              </p>
              {desktopSettingsError && (
                <p style={{ ...descriptionStyle, color: 'var(--color-danger)' }} role="alert">
                  Settings error: {desktopSettingsError}
                </p>
              )}
              {/* settings-wiring-honesty (AC7): the profile picks the desktop
                  backend's local model, so it is shown only while that backend
                  generates (api mode). */}
              {mode === 'api' ? (
              <div>
                <span style={labelStyle}>Inference profile</span>
                <p style={descriptionStyle}>
                  Answer length and temperature follow this profile unless a Response
                  Quality preset set them explicitly; an explicit preset wins until you
                  reset it.
                </p>
                <div role="radiogroup" aria-label="Inference profile">
                  {(['quality', 'fast', 'auto'] as const).map((profile) => (
                    <div key={profile}>
                      <label>
                        <input
                          type="radio"
                          name="desktop-inference-profile"
                          value={profile}
                          checked={desktopProfile === profile}
                          onChange={() => handleDesktopProfileChange(profile)}
                        />{' '}
                        {profile === 'auto'
                          ? 'Auto (choose by free memory)'
                          : profile === 'quality'
                            ? 'Quality'
                            : 'Fast'}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
              ) : (
                <p style={descriptionStyle}>
                  The inference profile applies only when chat uses the desktop backend
                  (API Server mode).
                </p>
              )}
              <div>
                <span style={labelStyle}>Model availability</span>
                {desktopStatus === null ? (
                  <p style={descriptionStyle}>Model status unavailable (backend reachable for chat only if a model loads).</p>
                ) : (
                  <ul style={{ ...descriptionStyle, margin: 0, paddingLeft: 'var(--spacing-lg)' }}>
                    <li>
                      Quality model: {desktopStatus.models.quality.present ? 'found' : 'not found'}
                    </li>
                    <li>
                      Fast model: {desktopStatus.models.fast.present ? 'found' : 'not found'}
                    </li>
                    <li>
                      Active profile right now: {desktopStatus.profile}
                      {desktopStatus.engine === 'stub' ? ' (development stub backend)' : ''}
                    </li>
                  </ul>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ================================================================== */}
        {/* 2a-2. First-run setup (E2, issue #85): status + Re-run setup.      */}
        {/* ================================================================== */}
        {electronMode && <FirstRunSetupCard />}

        {/* ================================================================== */}
        {/* 2c. Provider connection (provider mode — OpenAI-compatible server) */}
        {/* ================================================================== */}
        {mode === 'provider' && (
          <section style={sectionStyle} aria-labelledby="provider-config-heading">
            <h2 id="provider-config-heading" style={sectionTitleStyle}>
              Provider connection
            </h2>
            <div style={fieldGroupStyle}>
              <p style={descriptionStyle}>
                Provider mode sends your question directly to the configured server; responses
                are not grounded in your documents. Your conversation context is sent to that
                server.
              </p>
              <div>
                <label htmlFor="provider-base-url" style={labelStyle}>
                  Base URL
                </label>
                <p id="provider-base-url-desc" style={descriptionStyle}>
                  Root of a locally served OpenAI-compatible server, e.g. http://127.0.0.1:8080
                  (loopback only in this release; a /v1 suffix is optional)
                </p>
                <input
                  id="provider-base-url"
                  type="url"
                  name="provider-base-url"
                  autoComplete="off"
                  value={providerDraft.baseUrl}
                  onChange={(e) => handleProviderFieldChange({ baseUrl: e.target.value })}
                  onBlur={() => handleProviderFieldBlur({ baseUrl: providerDraft.baseUrl })}
                  placeholder="http://127.0.0.1:8080"
                  style={inputStyle}
                  aria-describedby="provider-base-url-desc"
                />
              </div>
              <div>
                <label htmlFor="provider-model" style={labelStyle}>
                  Model id
                </label>
                <p id="provider-model-desc" style={descriptionStyle}>
                  Model name the server exposes, e.g. llama-server's loaded GGUF id
                </p>
                <input
                  id="provider-model"
                  type="text"
                  name="provider-model"
                  autoComplete="off"
                  value={providerDraft.model}
                  onChange={(e) => handleProviderFieldChange({ model: e.target.value })}
                  onBlur={() => handleProviderFieldBlur({ model: providerDraft.model })}
                  placeholder="local-model"
                  style={inputStyle}
                  aria-describedby="provider-model-desc"
                />
              </div>
              <div>
                <label htmlFor="provider-api-key" style={labelStyle}>
                  API key (optional)
                </label>
                <p id="provider-api-key-desc" style={descriptionStyle}>
                  Sent as a Bearer header. Stored locally in plain text; it is sent only to
                  this server.
                </p>
                <input
                  id="provider-api-key"
                  type="password"
                  name="provider-api-key"
                  autoComplete="new-password"
                  value={providerDraft.apiKey}
                  onChange={(e) => handleProviderFieldChange({ apiKey: e.target.value })}
                  onBlur={() => handleProviderFieldBlur({ apiKey: providerDraft.apiKey })}
                  placeholder="empty for servers without auth"
                  style={inputStyle}
                  aria-describedby="provider-api-key-desc"
                />
              </div>

              <div style={buttonRowStyle} role="status" aria-live="polite">
                <button
                  type="button"
                  onClick={() => void handleTestProvider()}
                  disabled={isTestingProvider || !isProviderConfigured(providerDraft)}
                  style={
                    isTestingProvider
                      ? { ...secondaryButtonStyle, opacity: 0.6, cursor: 'not-allowed' }
                      : secondaryButtonStyle
                  }
                  aria-busy={isTestingProvider}
                >
                  {isTestingProvider ? 'Testing...' : 'Test Connection'}
                </button>

                {providerProbe === 'success' && <StatusBadge status="ready" label="Connected" />}
                {providerProbe === 'error' && (
                  <StatusBadge status="error" label="Connection failed" />
                )}
              </div>
              {providerProbeDetail && (
                <p style={{ ...descriptionStyle, color: 'var(--color-danger)' }} role="alert">
                  {providerProbeDetail}
                </p>
              )}
            </div>
          </section>
        )}

        {/* ================================================================== */}
        {/* 3. Browser Engine (browser-local only) + model cache status */}
        {/* settings-wiring-honesty (AC7): rendered only while browser-local */}
        {/* generation is active; otherwise one muted line explains why.    */}
        {/* ================================================================== */}
        {mode !== 'browser-local' ? (
          <p style={descriptionStyle} data-testid="browser-engine-hidden">
            The browser engine applies only to Browser-local mode.
          </p>
        ) : (
        <section style={sectionStyle} aria-labelledby="browser-engine-heading">
          <h2 id="browser-engine-heading" style={sectionTitleStyle}>
            Browser Engine
          </h2>
          <div style={fieldGroupStyle}>
            <p style={descriptionStyle}>
              Which engine runs local inference in browser-local mode.
              {capability && (
                <>
                  {' '}Recommended for this device:{' '}
                  <strong>{capability.recommendedEngine === 'wllama' ? 'wllama' : 'WebLLM'}</strong>.
                </>
              )}
            </p>
            <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>Select browser engine</legend>
              <div style={radioGroupStyle}>
                {([
                  {
                    id: 'wllama' as const,
                    label: 'wllama (CPU / no GPU)',
                    desc: 'Robust without WebGPU and supports image input (multimodal).',
                  },
                  {
                    id: 'webllm' as const,
                    label: 'WebLLM (WebGPU)',
                    desc: 'Fastest when WebGPU is available; text only. Requires a GPU-capable browser.',
                  },
                ]).map((opt) => (
                  <label
                    key={opt.id}
                    style={browserEngine === opt.id ? radioOptionSelectedStyle : radioOptionStyle}
                  >
                    <input
                      type="radio"
                      name="browser-engine"
                      value={opt.id}
                      checked={browserEngine === opt.id}
                      onChange={() => setBrowserEngine(opt.id)}
                      style={radioInputStyle}
                      aria-describedby={`${opt.id}-desc`}
                    />
                    <div>
                      <span style={radioLabelStyle}>{opt.label}</span>
                      <p id={`${opt.id}-desc`} style={descriptionStyle}>
                        {opt.desc}
                        {/* AC9: the ONE derived recommendation (same source as
                            the header and the Hardware row). */}
                        {capability?.recommendedEngine === opt.id && ' Recommended.'}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>
            {capability && browserEngine === 'webllm' && !capability.webgpu && (
              <p style={{ ...descriptionStyle, color: 'var(--color-danger)' }}>
                WebGPU was not detected — WebLLM will not run on this device. Switch to wllama, or use the desktop app or an external model server.
              </p>
            )}

            {/* Model cache status + download — engine-aware (issue #24 F2/F3/F4).
                Moved here from the deleted Model Selection section. The status
                reflects the actually-selected engine, and the Download button
                only shows for webllm (the only engine with a download step). */}
            {mode === 'browser-local' && (
              <div style={fieldGroupStyle} role="status" aria-live="polite">
                <div style={buttonRowStyle}>
                  <span style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
                    Status:
                    {modelCached ? (
                      <StatusBadge status="ready" label="Cached" />
                    ) : (
                      <StatusBadge status="not-ready" label="Not cached" />
                    )}
                  </span>
                </div>

                {/* Download progress */}
                {isDownloading && (
                  <ModelDownloadProgress
                    progress={downloadProgress}
                    onCancel={handleCancelDownload}
                    isQuotaError={isQuotaError}
                  />
                )}

                {/* Download button — webllm only (issue #24 F3) */}
                {browserEngine === 'webllm' && !modelCached && !isDownloading && (
                  <>
                    <button
                      type="button"
                      onClick={handleDownloadModel}
                      style={primaryButtonStyle}
                    >
                      Download Model
                    </button>
                    <p style={{ ...descriptionStyle, color: 'var(--color-warning)' }}>
                      Requires internet access (~1.9 GB) — downloads weights from the WebLLM CDN.
                    </p>
                  </>
                )}

                {browserEngine === 'webllm' && modelCached && !isDownloading && (
                  <span style={{ ...labelStyle, color: 'var(--color-primary)' }}>
                    Model ready to use
                  </span>
                )}

                {browserEngine === 'wllama' && modelCached && (
                  <p style={descriptionStyle}>
                    Weights are bundled with this build — no download needed. The model loads automatically on first use.
                  </p>
                )}
                {browserEngine === 'wllama' && !modelCached && (
                  <p style={{ ...descriptionStyle, color: 'var(--color-warning)' }}>
                    The packaged model is missing from this build. The wllama engine cannot download it. Contact your administrator or rebuild with the weights staged (see PACKAGING.md).
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
        )}

        {/* ================================================================== */}
        {/* 4. Response Quality (RAG preset) */}
        {/* ================================================================== */}
        <section style={sectionStyle} aria-labelledby="rag-preset-heading">
          <h2 id="rag-preset-heading" style={sectionTitleStyle}>
            Response Quality
          </h2>
          <div style={fieldGroupStyle}>
            <p style={descriptionStyle}>
              {electronMode
                ? "Trade speed for answer quality. Each preset sets the desktop backend's result count, reranking, answer length and temperature, and also applies to browser-local chat. Provider mode does not use retrieval."
                : 'Trade speed for answer quality in browser-local chat. Provider mode does not use retrieval.'}
            </p>
            <fieldset
              style={{ border: 'none', margin: 0, padding: 0 }}
              disabled={presetDisabled}
              aria-describedby={presetDisabled ? 'rag-preset-disabled-desc' : undefined}
            >
              <legend style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>Select response quality preset</legend>
              <div style={radioGroupStyle}>
                {(['fast', 'balanced', 'quality'] as const).map((preset) => (
                  <label
                    key={preset}
                    style={presetChecked(preset) ? radioOptionSelectedStyle : radioOptionStyle}
                  >
                    <input
                      type="radio"
                      name="rag-preset"
                      value={preset}
                      checked={presetChecked(preset)}
                      onChange={() => handleRagPresetChange(preset)}
                      style={radioInputStyle}
                      aria-describedby={`rag-${preset}-desc`}
                    />
                    <div>
                      <span style={radioLabelStyle}>{RAG_PRESET_LABELS[preset].label}</span>
                      <p id={`rag-${preset}-desc`} style={descriptionStyle}>
                        {RAG_PRESET_LABELS[preset].description}
                        {electronMode &&
                          " On the desktop backend it overrides the inference profile's answer length and temperature until reset."}
                        {rerankUnavailable && DESKTOP_PRESET_SETTINGS[preset].rag_reranking_enabled &&
                          ' Reranking unavailable on this installation.'}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
              {/* Sibling of the preset cards (NOT inside a card label): shown
                  exactly when the group is disabled, i.e. whenever the preset
                  cannot affect the active chat path. */}
              {presetDisabled && (
                <p id="rag-preset-disabled-desc" style={descriptionStyle}>
                  Applies to browser-local inference only. Provider mode does not use retrieval —
                  responses come directly from the provider server.
                </p>
              )}
            </fieldset>
            {/* settings-wiring-honesty (AC1): the desktop display state comes
                from the backend; say so when it is not one of the presets. */}
            {electronMode && desktopPreset?.kind === 'custom' && (
              <p style={descriptionStyle} data-testid="rag-preset-state">
                Custom server settings: the desktop backend&apos;s values match no preset.
                Browser-local chat uses the {RAG_PRESET_LABELS[ragPreset].label} preset.
              </p>
            )}
            {electronMode && desktopPreset?.kind === 'defaults' && (
              <p style={descriptionStyle} data-testid="rag-preset-state">
                Using server defaults: no preset is applied to the desktop backend, so answer
                length and temperature follow the inference profile.
              </p>
            )}
            {electronMode && desktopPreset !== null && desktopPreset.kind !== 'defaults' && (
              <div style={buttonRowStyle}>
                <button type="button" onClick={handlePresetReset} style={secondaryButtonStyle}>
                  Reset to defaults
                </button>
                <span style={descriptionStyle}>
                  Clears the preset on the desktop backend so it uses its default result count,
                  reranking and inference-profile answer settings.
                </span>
              </div>
            )}
            {presetError && (
              <p style={{ ...descriptionStyle, color: 'var(--color-danger)' }} role="alert">
                {presetError}
              </p>
            )}
          </div>
        </section>

        {/* ================================================================== */}
        {/* 5. Appearance */}
        {/* ================================================================== */}
        <section style={sectionStyle} aria-labelledby="appearance-heading">
          <h2 id="appearance-heading" style={sectionTitleStyle}>
            Appearance
          </h2>
          <div style={fieldGroupStyle}>
            <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend style={{ ...labelStyle, marginBottom: 'var(--spacing-sm)' }}>
                Theme
              </legend>
              <div style={{ display: 'flex', gap: 'var(--spacing-md)', flexWrap: 'wrap' }}>
                {(['light', 'dark', 'system'] as const).map((option) => (
                  <label
                    key={option}
                    style={
                      themePreference === option
                        ? radioOptionSelectedStyle
                        : radioOptionStyle
                    }
                  >
                    <input
                      type="radio"
                      name="theme"
                      value={option}
                      checked={themePreference === option}
                      onChange={() => handleThemeChange(option)}
                      style={radioInputStyle}
                    />
                    <span style={radioLabelStyle}>
                      {option.charAt(0).toUpperCase() + option.slice(1)}
                    </span>
                  </label>
                ))}
              </div>
              <p style={descriptionStyle}>
                System follows your OS color scheme and updates automatically when it changes.
              </p>
            </fieldset>
          </div>
        </section>

        {/* ================================================================== */}
        {/* 6. Updates (E5, issue #88 — Electron only, opt-in, default OFF)    */}
        {/* ================================================================== */}
        {electronMode && (
          <section style={sectionStyle} aria-labelledby="updates-heading" data-testid="updates-section">
            <h2 id="updates-heading" style={sectionTitleStyle}>
              Updates
            </h2>
            <UpdatesSection />
          </section>
        )}

        {/* ================================================================== */}
        {/* 7. Storage */}
        {/* ================================================================== */}
        <SectionCard
          title="Storage"
          id="storage-heading"
          description="Browser storage status and cache management"
        >
          {/* Per-kind packaged-model readiness (issue #24 F6).
              Previously only the aggregate `allReady` was shown, which reported
              green even when the browser LLM was absent (excluded group). Now
              each kind is reported individually, scoped to the selected engine. */}
          {packagesReady && (
            <div
              style={{
                ...storageInfoStyle,
                borderLeft: `4px solid ${packagesReady.allReady ? 'var(--color-success)' : 'var(--color-danger)'}`,
              }}
              aria-live="polite"
            >
              <PackagedModelReadiness
                report={packagesReady}
                browserEngine={browserEngine}
              />
              {!packagesReady.allReady && packagesReady.missing.length > 0 && (
                <p style={descriptionStyle}>
                  {packagesReady.missing.length} required model file(s) not found in this build.
                  See the packaging guide (PACKAGING.md) to bundle models for offline use.
                </p>
              )}
            </div>
          )}
          {/* settings-wiring-honesty (AC7): browser memory only matters while
              the model runs in this browser. */}
          {mode === 'browser-local' ? (
            <ProgressBar
              value={memoryTotal - memoryAvailable}
              max={memoryTotal}
              label={`Memory Used (${formatMemory(memoryTotal - memoryAvailable)} of ${formatMemory(memoryTotal)})`}
              color={memoryPressure === 'normal' ? 'success' : memoryPressure === 'moderate' ? 'warning' : 'danger'}
            />
          ) : (
            <p style={descriptionStyle}>
              Browser memory usage is shown in Browser-local mode, where the model runs in this
              browser.
            </p>
          )}
          <div style={buttonRowStyle}>
            <button
              type="button"
              onClick={handleClearCacheClick}
              style={
                clearCacheState === 'confirming'
                  ? { ...dangerButtonStyle, backgroundColor: 'var(--color-danger)' }
                  : dangerButtonStyle
              }
              aria-describedby="clear-cache-desc"
            >
              {clearCacheState === 'confirming' ? 'Click Again to Confirm' : 'Clear Cache'}
            </button>
            <span id="clear-cache-desc" style={descriptionStyle} aria-live="polite">
              {/* settings-wiring-honesty (AC5/AC6): the copy lists exactly
                  what is removed and what is kept in each app. */}
              {clearCacheState === 'confirming'
                ? desktopApp
                  ? `This removes this app's local caches and your saved settings here (${CLEARED_SETTINGS_COPY}), then reloads. Documents and settings stored by the desktop backend are kept; to remove documents, use the Documents page. This cannot be undone.`
                  : `This deletes the documents and keyword/vector indexes stored in this browser, downloaded model weights, and your saved settings (${CLEARED_SETTINGS_COPY}), plus orphaned data from earlier sessions, then reloads the page. This cannot be undone.`
                : desktopApp
                  ? "Clear this app's local caches and saved settings. Documents in the desktop library are kept."
                  : 'Clear downloaded models, search indexes, and saved settings in this browser.'}
            </span>
            {/* Result feedback (issue #24 F1) — announced to screen readers */}
            {clearCacheResult === 'clearing' && (
              <span role="status" aria-live="polite" style={descriptionStyle}>
                Clearing…
              </span>
            )}
            {clearCacheResult === 'cleared' && (
              <span role="status" aria-live="polite" style={{ ...descriptionStyle, color: 'var(--color-success)' }}>
                Cache cleared
              </span>
            )}
            {clearCacheResult === 'error' && (
              <span role="status" aria-live="polite" style={{ ...descriptionStyle, color: 'var(--color-danger)' }}>
                Could not clear all data
              </span>
            )}
          </div>
        </SectionCard>

        {/* ================================================================== */}
        {/* 7. Hardware Capability (diagnostic) */}
        {/* ================================================================== */}
        {mode !== 'browser-local' ? (
          <p style={descriptionStyle}>
            Hardware capability is checked for Browser-local mode only.
          </p>
        ) : (
        <SectionCard
          title="Hardware Capability"
          id="hardware-heading"
          description="Detected hardware features and recommended configuration"
        >
          {capability ? (
            <>
              <ProgressBar
                value={capability.tier === 'green' ? 100 : capability.tier === 'yellow' ? 50 : 10}
                max={100}
                label={`Hardware Suitability: ${capability.tier === 'green' ? 'Good' : capability.tier === 'yellow' ? 'Limited' : 'Not suitable — use the desktop app or an external model'}`}
                color={capability.tier === 'green' ? 'success' : capability.tier === 'yellow' ? 'warning' : 'danger'}
              />
              <div style={storageInfoStyle}>
                <div style={storageRowStyle}>
                  <span style={storageLabelStyle}>WebGPU</span>
                  <StatusBadge status={capability.webgpu ? 'ready' : 'error'} label={capability.webgpu ? 'Available' : 'Not available'} />
                </div>
                <div style={storageRowStyle}>
                  <span style={storageLabelStyle}>Multi-threading</span>
                  <StatusBadge status={capability.crossOriginIsolated ? 'ready' : 'not-ready'} label={capability.crossOriginIsolated ? 'Enabled' : 'Single-threaded'} />
                </div>
                <div style={storageRowStyle}>
                  <span style={storageLabelStyle}>Memory Tier</span>
                  <span style={{ fontWeight: 500 }}>{capability.memoryTier}</span>
                </div>
                <div style={storageRowStyle}>
                  <span style={storageLabelStyle}>Recommended Engine</span>
                  <span style={{ fontWeight: 500, color: 'var(--color-primary)' }}>
                    {capability.recommendedEngine === 'wllama' ? 'wllama' : 'WebLLM'}
                  </span>
                </div>
              </div>
              {capability.reasons.length > 0 && (
                <p style={descriptionStyle}>{capability.reasons.join(' ')}</p>
              )}
            </>
          ) : (
            <p style={descriptionStyle}>Detecting hardware capability…</p>
          )}
        </SectionCard>
        )}

        {/* ================================================================== */}
        {/* 8. About */}
        {/* ================================================================== */}
        <section style={sectionStyle} aria-labelledby="about-heading">
          <h2 id="about-heading" style={sectionTitleStyle}>
            About
          </h2>
          <div style={aboutSectionStyle}>
            <p>
              <strong>TrainingApp</strong>
            </p>
            <p>Version: {APP_VERSION}</p>
            <p>Answers questions about your training material and documents.</p>
            <p style={{ marginTop: 'var(--spacing-md)', fontSize: 'var(--font-size-caption)' }}>
              {mode === 'api'
                ? 'Answers come from the built-in desktop backend: llama.cpp (node-llama-cpp) generation with hybrid retrieval over the desktop document library.'
                : mode === 'provider'
                  ? 'Answers come from the external OpenAI-compatible server you configured, without document retrieval.'
                  : 'Runs in this browser with WebLLM (WebGPU) or wllama (WebAssembly); documents are stored in IndexedDB.'}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

// ============================================================================
// PackagedModelReadiness — per-kind readiness display (issue #24 F6)
// ============================================================================

const KIND_LABELS: Record<PackagedModelKind, string> = {
  embedding: 'Embeddings',
  reranker: 'Reranker',
  llm: 'Browser LLM',
  runtime: 'ONNX Runtime',
};

/**
 * Render per-kind packaged-model readiness from the PackagedModelsReport.
 *
 * Issue #24 F6: the aggregate `allReady` collapsed a real distinction
 * (excluded-vs-present) into a single misleading green. This surfaces each
 * kind individually so a missing browser LLM isn't hidden by green embeddings.
 *
 * For the webllm engine, the packaged `llm` kind (the wllama GGUF) is NOT
 * what webllm uses — webllm weights live in Cache Storage — so that row is
 * suppressed with an explanatory note to avoid a contradictory "Ready" signal
 * (issue #24 critic M4).
 */
function PackagedModelReadiness({
  report,
  browserEngine,
}: {
  report: PackagedModelsReport;
  browserEngine: 'wllama' | 'webllm';
}): React.ReactElement {
  // Group models by kind, preserving a stable display order.
  const kindOrder: PackagedModelKind[] = ['embedding', 'runtime', 'reranker', 'llm'];
  const byKind = new Map<PackagedModelKind, typeof report.models>();
  for (const m of report.models) {
    const arr = byKind.get(m.kind) ?? [];
    arr.push(m);
    byKind.set(m.kind, arr);
  }

  return (
    <>
      <div style={storageRowStyle}>
        <span style={storageLabelStyle}>Packaged Models (overall)</span>
        <span style={{ fontWeight: 500, color: report.allReady ? 'var(--color-success)' : 'var(--color-danger)' }}>
          <span aria-hidden="true">{report.allReady ? '✓ ' : '✗ '}</span>
          {report.allReady ? 'Ready' : 'Missing'}
        </span>
      </div>
      {kindOrder.map((kind) => {
        const models = byKind.get(kind);
        if (!models || models.length === 0) return null;
        // Suppress the packaged llm kind for webllm — its weights are in Cache
        // Storage, not packaged. Showing "Ready" here would contradict the
        // "Not cached" status above for a webllm user without a download.
        if (kind === 'llm' && browserEngine === 'webllm') {
          return (
            <div key={kind} style={storageRowStyle}>
              <span style={storageLabelStyle}>{KIND_LABELS[kind]}</span>
              <span style={{ fontSize: 'var(--font-size-caption)', color: 'var(--color-text-muted)' }}>
                WebLLM weights are not packaged — see cache status above
              </span>
            </div>
          );
        }
        const allReady = models.every((m) => m.ready);
        const allExcluded = models.every((m) => m.excluded);
        // Check allExcluded BEFORE allReady: an excluded model reports
        // ready=true (model-manifest.ts marks excluded groups ready), so
        // allReady would otherwise win and show green for "Excluded from
        // build" — a misleading color. Map excluded to 'not-ready' (warning)
        // to match the label.
        const status: 'ready' | 'error' | 'not-ready' = allExcluded
          ? 'not-ready'
          : allReady
            ? 'ready'
            : 'error';
        const label = allExcluded
          ? 'Excluded from build'
          : allReady
            ? 'Ready'
            : 'Missing';
        return (
          <div key={kind} style={storageRowStyle}>
            <span style={storageLabelStyle}>{KIND_LABELS[kind]}</span>
            <StatusBadge status={status} label={label} />
          </div>
        );
      })}
    </>
  );
}

// ============================================================================
// SettingsPage (exported component — wraps with context providers)
// ============================================================================

export function SettingsPage(props: SettingsPageProps = {}): React.ReactElement {
  return <SettingsPageInner {...props} />;
}
