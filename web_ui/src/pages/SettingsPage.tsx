/**
 * Settings page — inference mode (desktop backend / browser-local), External
 * model (OpenAI- or Anthropic-compatible endpoint), browser engine & model
 * cache status, response quality, appearance, storage management, and about
 * info.
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
import { notifyDesktopModelsChanged } from '../lib/desktop-models-events';
import { getBrowserPackManager } from '../lib/packs/browser-pack-manager';
import { releaseBrowserTrainingIfEmpty } from '../lib/packs/browser-training';
import { AIRGAP_UPDATES_DETAIL, getUpdatesBridge } from '../lib/packs/pack-update-controller';
import { IS_AIRGAP } from '../lib/llm/airgap';
import type { RAGPreset } from '../lib/rag/rag-presets';
import { fetchFirstRunStatus, resetFirstRun, emitFirstRunReopen } from '../lib/first-run';
import type { ModelStatus, SettingsResponse } from '../lib/api/types';
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
  presetIsNResultsOnly,
  type DesktopPresetState,
} from '../lib/rag/rag-presets';
import { clearSessionSettings, clearUserSettings } from '../lib/storage/persisted-keys';
import {
  focusSettingsSection,
  MODEL_CONNECTION_SECTION_ID,
  SETTINGS_SECTIONS,
} from '../lib/settings-sections';
// AC8 (settings-wiring-honesty): the single version source is
// web_ui/package.json (desktop/package.json is kept in lockstep by test).
import { version as APP_VERSION } from '../../package.json';
import { ExternalModelSection } from '../components/ExternalModelSection';
import type { UpdateStatus } from '../types/desktop';
import { getMemoryBudget, getMemoryPressureStatus } from '../lib/embeddings/memory-aware';
import { ModelDownloadProgress } from '../components/ModelDownloadProgress';
import { ProgressBar, StatusBadge } from '../components/SettingsMetrics';
import {
  SettingsNav,
  SettingsRadioCards,
  SettingsSection,
  SettingsSubsection,
} from '../components/SettingsControls';
import {
  Banner,
  Button,
  Checkbox,
  Icon,
  KeyValueList,
  PageHeader,
  SegmentedControl,
  type KeyValueItem,
} from '../ui';
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
    <SettingsSubsection title="First-run setup" headingId="first-run-heading" data-testid="first-run-setup-section">
      <p className="settings-text">
        {statusLine ?? 'First-run status unavailable (backend starting).'}
      </p>
      <div className="settings-row">
        <Button variant="secondary" onClick={() => void handleRerun()} data-testid="first-run-rerun">
          Re-run setup
        </Button>
      </div>
    </SettingsSubsection>
  );
}

// ============================================================================
// Updates (E5, issue #88): opt-in toggle (default OFF), check-now, status.
// Offline-first: nothing is fetched until the toggle is switched on; the
// notice surfaces here AND on the packs panel. Both apps (browser-training-
// parity AC8): the update bridge is the desktop preload bridge inside
// Electron and the browser update controller otherwise — one UI.
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
    const bridge = getUpdatesBridge();
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
      const result = await getUpdatesBridge()?.setUpdateOptIn?.(!status.optIn);
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
      const result = await getUpdatesBridge()?.checkForUpdates?.();
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
      const result = await getUpdatesBridge()?.openUpdateExternal?.(url);
      if (result !== undefined && !result.ok && result.detail) showError(result.detail);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Could not open the download page');
    } finally {
      setOpenBusy(false);
    }
  };

  const checkDisabled = busy || status === null || !status.optIn;
  return (
    <>
      <div className="settings-row">
        <Checkbox
          data-testid="updates-opt-in"
          checked={status?.optIn ?? false}
          disabled={busy || status === null || (IS_AIRGAP && !isElectron())}
          aria-busy={busy}
          onChange={() => void handleToggle()}
          label="Check for updates automatically (opt-in; the app works fully offline)"
        />
        <Button
          variant="secondary"
          data-testid="updates-check-now"
          loading={busy}
          disabled={checkDisabled}
          aria-disabled={checkDisabled}
          onClick={() => void handleCheckNow()}
        >
          {busy ? 'Checking…' : 'Check for updates now'}
        </Button>
      </div>
      {error !== null && (
        <p
          role="alert"
          ref={errorRef}
          tabIndex={-1}
          className="settings-text settings-tone--danger settings-focus-target"
          data-testid="updates-error"
        >
          {error}
        </p>
      )}
      {status !== null && status.optIn && status.error !== null && (
        <p role="alert" className="settings-text settings-tone--danger">
          Last check failed: {status.error}
        </p>
      )}
      {status !== null && status.optIn && status.appUpdate !== null && (
        <p className="settings-text" data-testid="updates-app-available">
          App update available: v{status.appUpdate.availableVersion} (currently v
          {status.appUpdate.currentVersion}).{' '}
          <Button
            variant="secondary"
            size="sm"
            data-testid="updates-app-open-download"
            disabled={openBusy}
            aria-disabled={openBusy}
            onClick={() => void handleOpenDownload(status.appUpdate?.downloadUrl ?? '')}
          >
            Open download page
          </Button>{' '}
          and run the installer to update; your data is kept. Download URL (copyable):{' '}
          <code className="settings-code" data-testid="updates-app-url">
            {status.appUpdate.downloadUrl}
          </code>
          . Expected sha256:{' '}
          <code className="settings-code" data-testid="updates-app-sha256">
            {status.appUpdate.sha256}
          </code>{' '}
          (verify the downloaded file against it before running, per docs/updates.md).
        </p>
      )}
      {status !== null && status.optIn && status.refused.length > 0 && (
        <p className="settings-text" data-testid="updates-refused">
          {status.refused.length} update{status.refused.length === 1 ? '' : 's'} refused (signature
          verification failed):{' '}
          {status.refused.map((entry) => `${entry.packId} v${entry.version}`).join(', ')}
        </p>
      )}
      {status !== null && status.optIn && status.checkedAt !== null && (
        <p role="status" aria-live="polite" className="settings-text" data-testid="updates-status-line">
          Last checked {new Date(status.checkedAt).toLocaleString()}. Pack updates, if any, are
          surfaced on the Knowledge Packs panel (Documents page).
        </p>
      )}
      {IS_AIRGAP && !isElectron() && (
        <p className="settings-text" data-testid="updates-airgap">
          {AIRGAP_UPDATES_DETAIL}
        </p>
      )}
      {!isElectron() && !IS_AIRGAP && (
        <p className="settings-text" data-testid="updates-browser-note">
          In the browser app the feed and the pack downloads are fetched by this page, so their host must allow
          cross-origin requests (a CORS-enabled mirror); if it does not, the check reports the refusal and the
          desktop app remains the way to apply updates.
        </p>
      )}
      <p className="settings-text">
        Update feeds are Ed25519-signed; anything failing signature verification is refused with no
        unsigned fallback. See the Updates runbook (docs/updates.md) for the feed format.
      </p>
    </>
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
// SettingsPage (inner component — uses contexts)
// ============================================================================

/** The browser-stored user settings Clear Cache removes (persisted-keys.ts USER_SETTING_KEYS). */
const CLEARED_SETTINGS_COPY =
  'inference mode, browser engine and response-quality choices, theme, external model connection and API key, sidebar state, last-opened course and the pack update setting';

/**
 * Delay between the final Clear Cache status and the reload (PR #140 review
 * FB140-002): long enough for a screen reader to announce the polite status
 * (500 ms could tear the page down mid-announcement), and below the 3 s
 * status reset so the message is still showing when the page reloads.
 */
export const RELOAD_AFTER_CLEAR_MS = 2000;

interface SettingsPageProps {
  /**
   * settings-wiring-honesty (AC10): scroll to the element with this id and
   * focus its heading on open (e.g. 'model-connection' from the
   * model-blocked overlay). Omitted: the page opens at the top.
   */
  initialSection?: string;
  /**
   * Changes on every request for a section (App bumps a counter), so a repeated
   * request for the same `initialSection` still re-runs the scroll-and-focus.
   */
  sectionRequest?: number;
  /** Clear Cache reload seam (default: window.location.reload()). */
  reloadPage?: () => void;
}

function SettingsPageInner({ initialSection, sectionRequest, reloadPage }: SettingsPageProps): React.ReactElement {
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
  // True once the clear removed the saved settings, so the page reloads (the
  // status then tells screen-reader users a reload is coming).
  const [clearCacheReloading, setClearCacheReloading] = useState(false);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);


  // Hardware capability + packaged-model readiness (Phase 3)
  const [capability, setCapability] = useState<EngineCapability | null>(null);
  const [packagesReady, setPackagesReady] = useState<PackagedModelsReport | null>(null);

  // settings-wiring-honesty: the desktop Response Quality display state is
  // derived from the backend (GET/PUT /settings), never from the persisted
  // browser-local `ragPreset`. null = not read yet (no radio checked).
  const [desktopPreset, setDesktopPreset] = useState<DesktopPresetState | null>(null);
  // The last desktop settings body (reranker availability for the cards).
  const [desktopSettings, setDesktopSettings] = useState<SettingsResponse | null>(null);
  // True when the backend matched a preset on rag_n_results alone (a profile
  // saved before presets wrote the full patch): the preset's reranking and
  // answer settings are NOT applied until the user re-selects it.
  const [presetNeedsReapply, setPresetNeedsReapply] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  // Latest-wins: every preset GET/PUT takes a ticket and a response whose
  // ticket is stale (a newer read or write started) is ignored, so a GET
  // issued before a PUT can never overwrite that PUT's result.
  const presetTicketRef = useRef(0);

  const applyDesktopSettings = useCallback((settings: SettingsResponse) => {
    setDesktopSettings(settings);
    setDesktopPreset(presetFromBackend(settings));
    setPresetNeedsReapply(presetIsNResultsOnly(settings));
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
        if (ticket === presetTicketRef.current) applyDesktopSettings(settings);
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
        // The profile decides which model answers, so tell App to re-read
        // /status/models: the sidebar footer chip names the model from that
        // snapshot and would otherwise keep the old profile until a reload.
        .then(() => notifyDesktopModelsChanged())
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
      const previousNeedsReapply = presetNeedsReapply;
      const ticket = ++presetTicketRef.current;
      setDesktopPreset({ kind: 'preset', preset });
      // The full patch is being sent, so every preset setting will be explicit.
      setPresetNeedsReapply(false);
      desktopSession.apiClient
        .updateSettings({ ...DESKTOP_PRESET_SETTINGS[preset] })
        .then((response) => {
          if (!isMountedRef.current || ticket !== presetTicketRef.current) return;
          // A backend that reports explicit_keys confirms what it stored
          // (runtime-guarded: older desktop builds omit the field).
          if (response !== null && typeof response === 'object' && Array.isArray(response.explicit_keys)) {
            applyDesktopSettings(response);
          }
        })
        .catch((err) => {
          if (!isMountedRef.current || ticket !== presetTicketRef.current) return;
          setDesktopPreset(previousDisplay);
          setPresetNeedsReapply(previousNeedsReapply);
          setRagPreset(previousRagPreset);
          setPresetError(
            `The preset could not be applied to the desktop backend: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },
    [desktopApp, desktopSession, desktopPreset, presetNeedsReapply, ragPreset, setRagPreset, applyDesktopSettings]
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
        const settings =
          response !== null && typeof response === 'object' && Array.isArray(response.explicit_keys)
            ? response
            : await desktopSession.apiClient.getSettings();
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
    focusSettingsSection(initialSection);
    // sectionRequest changes on every request, so re-clicking a link to the section
    // Settings already targets scrolls and focuses again (state alone would not change).
  }, [initialSection, sectionRequest]);

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
      setClearCacheReloading(false);
      // An in-flight model download is cancelled first (its cache entries are
      // about to be deleted underneath it).
      if (isDownloading) handleCancelDownload();

      // PR #140 review (FB140-011): every step runs in its own try/catch, so
      // one failure (realistically the EdgeVec delete) no longer skips the
      // rest — above all the saved-settings removal the copy promises.
      let failed = false;
      const attempt = async (step: string, run: () => Promise<void>): Promise<void> => {
        try {
          await run();
        } catch (err) {
          failed = true;
          console.error(`Error clearing cache (${step}):`, err);
        }
      };

      // getProfilePrefix never throws (storage failures fall back internally).
      const prefix = getProfilePrefix();

      // 1. Current profile's document/keyword/vector-mapping IndexedDBs.
      await attempt('profile databases', () => deleteNamespace(prefix));

      // 2. EdgeVec HNSW blob (key in shared edgevec-db, store 'data').
      //    Resolves PRR-008: deleteNamespace cannot reach this shared DB.
      await attempt('vector index', () => deleteEdgeVecBlob(prefix));

      // 3. Stale/orphan namespaces from prior sessions/profiles.
      await attempt('orphaned data', async () => {
        const stale = await listStalePrefixes();
        if (stale.length > 0) {
          await Promise.all(stale.map((p) => deleteNamespace(p)));
        }
      });

      // 4. Legacy settings IndexedDB (non-prefixed; written by earlier builds).
      await attempt('legacy settings database', () =>
        new Promise<void>((resolve) => {
          const settingsDeleteReq = indexedDB.deleteDatabase(SETTINGS_DB_NAME);
          settingsDeleteReq.onsuccess = () => resolve();
          settingsDeleteReq.onerror = () => resolve();
          settingsDeleteReq.onblocked = () => resolve();
        })
      );

      // 5. WebLLM Cache Storage (web-llm scopes artifacts across three
      //    named caches: model weights, model config, and the wasm runtime).
      await attempt('WebLLM model files', async () => {
        if (typeof caches !== 'undefined' && typeof caches.delete === 'function') {
          await Promise.all(
            ['webllm/model', 'webllm/config', 'webllm/wasm'].map((cacheName) =>
              caches.delete(cacheName).catch(() => {})
            )
          );
        }
      });

      // 6. ALWAYS: every registered browser-stored user setting (inference
      //    mode blob, theme, external model connection and API key —
      //    including the session-only key — sidebar, last-opened course).
      //    Internal bookkeeping keys are kept. The session-only entries are
      //    cleared after settingsCleared is set, so a sessionStorage failure
      //    still reports an error AND still reloads.
      let settingsCleared = false;
      try {
        clearUserSettings();
        settingsCleared = true;
        clearSessionSettings();
      } catch (err) {
        failed = true;
        console.error('Error clearing cache (saved settings):', err);
      }

      // 7. Browser app only (browser-training-parity): installed training and
      //    knowledge packs (origin-private files + registry) and the
      //    player-origin service worker, each its own step like the rest. The
      //    desktop app's packs live in its backend and are managed on the
      //    Documents page.
      if (!desktopApp) {
        await attempt('installed packs', () => getBrowserPackManager().clearAll());
        await attempt('course player service worker', () => releaseBrowserTrainingIfEmpty());
      }

      setClearCacheResult(failed ? 'error' : 'cleared');
      setClearCacheReloading(settingsCleared);

      // Reload whenever the saved settings were removed — even after a failed
      // step — so every context starts from the cleared storage (the React
      // state still holds the old values until then).
      if (settingsCleared) {
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
        setClearCacheReloading(false);
        clearTimeoutRef.current = null;
      }, 3000);
    }
  }, [clearCacheState, isDownloading, handleCancelDownload, reloadPage, desktopApp]);

  // settings-wiring-honesty: in the desktop app the checked preset reflects
  // the BACKEND (none checked while unread, custom, or on defaults); in the
  // browser app it is the persisted browser-local preset.
  const presetChecked = (preset: RAGPreset): boolean =>
    electronMode
      ? desktopPreset?.kind === 'preset' && desktopPreset.preset === preset
      : ragPreset === preset;
  const rerankUnavailable = electronMode && desktopSettings?.reranking_available === false;

  // Format memory for display
  const formatMemory = (mb: number): string => {
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${mb} MB`;
  };

  const hardwareItems: KeyValueItem[] = capability
    ? [
        {
          label: 'WebGPU',
          value: <StatusBadge status={capability.webgpu ? 'ready' : 'error'} label={capability.webgpu ? 'Available' : 'Not available'} />,
        },
        {
          label: 'Multi-threading',
          value: <StatusBadge status={capability.crossOriginIsolated ? 'ready' : 'not-ready'} label={capability.crossOriginIsolated ? 'Enabled' : 'Single-threaded'} />,
        },
        { label: 'Memory Tier', value: <span className="settings-strong">{capability.memoryTier}</span> },
        {
          label: 'Recommended Engine',
          value: (
            <span className="settings-strong settings-tone--accent">
              {capability.recommendedEngine === 'wllama' ? 'wllama' : 'WebLLM'}
            </span>
          ),
        },
      ]
    : [];

  // ====================================================================
  // Built-in model settings (Model & connection, generator source
  // "Built-in model"). settings-wiring-honesty (AC4): only the desktop app
  // has a second place the built-in model can run (its backend, "api"
  // mode); the browser app is standalone, so it shows no run-location
  // choice and no API-server option or copy.
  // ====================================================================
  const builtInPanel = (
    <>
      {desktopApp && (
        <SettingsSubsection title="Where the built-in model runs" headingId="inference-mode-heading">
          <SettingsRadioCards<'browser-local' | 'api'>
            legend="Where the built-in model runs"
            name="inference-mode"
            isChecked={(value) => mode === value}
            onChange={(value) => setMode(value)}
            options={[
              {
                value: 'browser-local',
                label: 'In this window',
                description: 'Runs in this app window with wllama (CPU) or WebLLM (WebGPU), chosen below.',
                descriptionId: 'browser-local-desc',
              },
              {
                value: 'api',
                label: 'Desktop backend',
                description: "Runs in the desktop app's built-in backend (llama.cpp; starts automatically with the app).",
                descriptionId: 'api-desc',
              },
            ]}
          />
        </SettingsSubsection>
      )}

      {/* Desktop backend status (Electron mode only — issue #67): connectivity,
          active inference profile and per-profile model presence; the profile
          override persists via PUT /settings (backend settings sidecar). */}
      {electronMode && (
        <SettingsSubsection title="Desktop backend" headingId="desktop-backend-heading">
          <p className="settings-text">
            This app is using its built-in desktop backend
            {desktopSession ? ` at ${desktopSession.baseUrl}` : ''}. Its settings are stored by the
            backend and survive restarts.
          </p>
          {/* settings-wiring-honesty (AC7): the profile picks the desktop
              backend's local model, so it is shown only while that backend
              generates (api mode). */}
          {mode === 'api' ? (
            <div className="settings-group">
              <p className="settings-label">Inference profile</p>
              <p className="settings-text">
                Answer length and temperature follow this profile unless a Response
                Quality preset set them explicitly; an explicit preset wins until you
                reset it.
              </p>
              <SettingsRadioCards<'quality' | 'fast' | 'auto'>
                legend="Inference profile"
                name="desktop-inference-profile"
                isChecked={(profile) => desktopProfile === profile}
                onChange={(profile) => handleDesktopProfileChange(profile)}
                options={[
                  { value: 'quality', label: 'Quality' },
                  { value: 'fast', label: 'Fast' },
                  { value: 'auto', label: 'Auto (choose by free memory)' },
                ]}
              />
            </div>
          ) : (
            <p className="settings-text">
              The inference profile applies only when the built-in model runs in the desktop backend.
            </p>
          )}
          <div className="settings-group">
            <p className="settings-label">Model availability</p>
            {desktopStatus === null ? (
              <p className="settings-text">Model status unavailable (backend reachable for chat only if a model loads).</p>
            ) : (
              <ul className="settings-list">
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
        </SettingsSubsection>
      )}

      {/* Browser engine + model cache status (issue #24 F2/F3/F4) and the
          hardware diagnostic. settings-wiring-honesty (AC7): rendered only
          while the built-in model runs in this window; otherwise one muted
          line explains why. */}
      {mode !== 'browser-local' ? (
        <p className="settings-text" data-testid="browser-engine-hidden">
          The browser engine and the hardware check apply only when the built-in model runs in this window.
        </p>
      ) : (
        <>
          <SettingsSubsection title="Browser engine" headingId="browser-engine-heading">
            <p className="settings-text">
              Which engine runs the built-in model in this {desktopApp ? 'window' : 'browser'}.
              {capability && (
                <>
                  {' '}Recommended for this device:{' '}
                  <strong>{capability.recommendedEngine === 'wllama' ? 'wllama' : 'WebLLM'}</strong>.
                </>
              )}
            </p>
            <SettingsRadioCards<'wllama' | 'webllm'>
              legend="Select browser engine"
              name="browser-engine"
              isChecked={(engine) => browserEngine === engine}
              onChange={(engine) => setBrowserEngine(engine)}
              options={([
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
              ]).map((opt) => ({
                value: opt.id,
                label: opt.label,
                descriptionId: `${opt.id}-desc`,
                description: (
                  <>
                    {opt.desc}
                    {/* AC9: the ONE derived recommendation (same source as
                        the header and the Hardware row). */}
                    {capability?.recommendedEngine === opt.id && ' Recommended.'}
                  </>
                ),
              }))}
            />
            {capability && browserEngine === 'webllm' && !capability.webgpu && (
              <p className="settings-text settings-tone--danger">
                WebGPU was not detected — WebLLM will not run on this device. Switch to wllama, or use the desktop app or an external model server.
              </p>
            )}

            {/* Model cache status + download — engine-aware. The status
                reflects the actually-selected engine, and the Download button
                only shows for webllm (the only engine with a download step). */}
            <div className="settings-group" role="status" aria-live="polite">
              <div className="settings-row">
                <span className="settings-label settings-row">
                  Status:
                  {modelCached ? (
                    <StatusBadge status="ready" label="Cached" />
                  ) : (
                    <StatusBadge status="not-ready" label="Not cached" />
                  )}
                </span>
              </div>

              {isDownloading && (
                <ModelDownloadProgress
                  progress={downloadProgress}
                  onCancel={handleCancelDownload}
                  isQuotaError={isQuotaError}
                />
              )}

              {browserEngine === 'webllm' && !modelCached && !isDownloading && (
                <>
                  <div className="settings-row">
                    <Button variant="primary" onClick={handleDownloadModel}>
                      Download Model
                    </Button>
                  </div>
                  <p className="settings-text settings-tone--warning">
                    Requires internet access (~1.9 GB) — downloads weights from the WebLLM CDN.
                  </p>
                </>
              )}

              {browserEngine === 'webllm' && modelCached && !isDownloading && (
                <span className="settings-label settings-tone--accent">
                  Model ready to use
                </span>
              )}

              {browserEngine === 'wllama' && modelCached && (
                <p className="settings-text">
                  Weights are bundled with this build — no download needed. The model loads automatically on first use.
                </p>
              )}
              {browserEngine === 'wllama' && !modelCached && (
                <p className="settings-text settings-tone--warning">
                  The packaged model is missing from this build. The wllama engine cannot download it. Contact your administrator or rebuild with the weights staged (see PACKAGING.md).
                </p>
              )}
            </div>
          </SettingsSubsection>

          <SettingsSubsection
            title="Hardware capability"
            headingId="hardware-heading"
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
                <KeyValueList items={hardwareItems} className="settings-hardware" />
                {capability.reasons.length > 0 && (
                  <p className="settings-text settings-hardware__reasons">{capability.reasons.join(' ')}</p>
                )}
              </>
            ) : (
              <p className="settings-text">Detecting hardware capability…</p>
            )}
          </SettingsSubsection>
        </>
      )}
    </>
  );

  return (
    <div className="settings-page">
      <PageHeader
        title="Settings"
        description="Choose how answers are generated, and manage appearance and storage."
      />

      {/* Single-scroller ownership (trace external-llm-provider-settings): the
          AppShell <main> is the ONLY scroller; nothing in this page sets overflow
          (the section nav is position: sticky, bounded by the page body), so the
          header, the nav and the sections move together. */}
      <div className="settings-page__body">
        <SettingsNav items={SETTINGS_SECTIONS} />

        <div className="settings-page__sections">
          {/* ================================================================ */}
          {/* 1. Model & connection: generator source, built-in model, and the */}
          {/* external endpoint (universal-provider-settings-overhaul). The id */}
          {/* is the model-blocked overlay's and the connection chip's target. */}
          {/* ================================================================ */}
          <ExternalModelSection
            id={MODEL_CONNECTION_SECTION_ID}
            builtIn={builtInPanel}
            // Shown for every generator source: a failed backend settings read must
            // stay visible even while an external model is selected.
            notice={desktopSettingsError ? <Banner tone="danger">Settings error: {desktopSettingsError}</Banner> : null}
          />

          {/* ================================================================ */}
          {/* 2. Answers (Response Quality / RAG preset) */}
          {/* ================================================================ */}
          <SettingsSection
            id="answers"
            title="Answers"
            headingId="answers-heading"
            focusableHeading
            description="How answers are retrieved and written."
          >
            <SettingsSubsection title="Response quality" headingId="rag-preset-heading">
              <p className="settings-text">
                {electronMode
                  ? "Trade speed for answer quality. Each preset sets the desktop backend's result count, reranking, answer length and temperature, and also applies to chat in this window."
                  : 'Trade speed for answer quality (an external model also uses its answer length and temperature).'}
              </p>
              <SettingsRadioCards<RAGPreset>
                legend="Select response quality preset"
                name="rag-preset"
                isChecked={presetChecked}
                onChange={(preset) => handleRagPresetChange(preset)}
                // A checked radio fires no change event, so re-selecting the
                // preset matched on rag_n_results alone (settings saved before
                // presets wrote the full patch) re-applies its full patch on
                // click instead.
                onOptionClick={(preset) => {
                  if (electronMode && presetNeedsReapply && presetChecked(preset)) handleRagPresetChange(preset);
                }}
                options={(['fast', 'balanced', 'quality'] as const).map((preset) => ({
                  value: preset,
                  label: RAG_PRESET_LABELS[preset].label,
                  descriptionId: `rag-${preset}-desc`,
                  description: (
                    <>
                      {RAG_PRESET_LABELS[preset].description}
                      {electronMode &&
                        (presetNeedsReapply && presetChecked(preset)
                          ? ' Re-select a preset to apply its reranking and answer settings.'
                          : " On the desktop backend it overrides the inference profile's answer length and temperature until reset.")}
                      {rerankUnavailable && DESKTOP_PRESET_SETTINGS[preset].rag_reranking_enabled &&
                        ' Reranking unavailable on this installation.'}
                    </>
                  ),
                }))}
              />
              {/* settings-wiring-honesty (AC1): the desktop display state comes
                  from the backend; say so when it is not one of the presets. */}
              {electronMode && desktopPreset?.kind === 'custom' && (
                <p className="settings-text" data-testid="rag-preset-state">
                  Custom server settings: the desktop backend&apos;s values match no preset.
                  Chat in this window uses the {RAG_PRESET_LABELS[ragPreset].label} preset.
                </p>
              )}
              {electronMode && desktopPreset?.kind === 'defaults' && (
                <p className="settings-text" data-testid="rag-preset-state">
                  Using server defaults: no preset is applied to the desktop backend, so answer
                  length and temperature follow the inference profile.
                </p>
              )}
              {electronMode && desktopPreset !== null && desktopPreset.kind !== 'defaults' && (
                <div className="settings-row">
                  <Button variant="secondary" onClick={handlePresetReset}>
                    Reset to defaults
                  </Button>
                  <span className="settings-text">
                    Clears the preset on the desktop backend so it uses its default result count,
                    reranking and inference-profile answer settings.
                  </span>
                </div>
              )}
              {presetError && <Banner tone="danger">{presetError}</Banner>}
            </SettingsSubsection>
          </SettingsSection>

          {/* ================================================================ */}
          {/* 3. Appearance */}
          {/* ================================================================ */}
          <SettingsSection id="appearance" title="Appearance" headingId="appearance-heading" focusableHeading>
            <div className="settings-group">
              <SegmentedControl
                legend="Theme"
                value={themePreference}
                onChange={(value) => handleThemeChange(value as ThemePreference)}
                options={(['light', 'dark', 'system'] as const).map((option) => ({
                  value: option,
                  label: option.charAt(0).toUpperCase() + option.slice(1),
                }))}
              />
              <p className="settings-text">
                System follows your OS color scheme and updates automatically when it changes.
              </p>
            </div>
          </SettingsSection>

          {/* ================================================================ */}
          {/* 4. Storage & privacy */}
          {/* ================================================================ */}
          <SettingsSection
            id="storage-privacy"
            title="Storage & privacy"
            headingId="storage-privacy-heading"
            focusableHeading
            description="What this app keeps on this device, and how to remove it."
          >
            <p className="settings-text" data-testid="privacy-note">
              Your documents, search indexes and conversations are kept on this device
              {desktopApp ? ' (by the desktop backend and in this app window)' : ', in this browser'}. Your
              documents and questions leave this device only when an external model is switched on (Model
              &amp; connection). Update checks (Updates) and WebLLM model downloads use the network only after
              you opt in or start them.
            </p>
            {/* Per-kind packaged-model readiness (issue #24 F6): each kind is
                reported individually, scoped to the selected engine. */}
            {packagesReady && (
              <div
                className={`settings-well ${packagesReady.allReady ? 'settings-well--success' : 'settings-well--danger'}`}
                aria-live="polite"
              >
                <PackagedModelReadiness
                  report={packagesReady}
                  browserEngine={browserEngine}
                />
                {!packagesReady.allReady && packagesReady.missing.length > 0 && (
                  <p className="settings-text">
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
              <p className="settings-text">
                Browser memory usage is shown when the built-in model runs in this window.
              </p>
            )}
            <div className="settings-danger-zone">
              <Button
                variant="danger"
                onClick={handleClearCacheClick}
                aria-describedby="clear-cache-desc"
              >
                {clearCacheState === 'confirming' ? 'Click Again to Confirm' : 'Clear Cache'}
              </Button>
              <span id="clear-cache-desc" className="settings-text" aria-live="polite">
                {/* settings-wiring-honesty (AC5/AC6): the copy lists exactly
                    what is removed and what is kept in each app. */}
                {clearCacheState === 'confirming'
                  ? desktopApp
                    ? `This deletes the browser-side document and keyword/vector index databases kept in this app window, any WebLLM model files downloaded in this window, orphaned data from earlier sessions, and your saved settings here (${CLEARED_SETTINGS_COPY}), then reloads. Kept: your chat history (conversations), and the documents and settings stored by the desktop backend; to remove documents, use the Documents page. This cannot be undone.`
                    : `This deletes the documents and keyword/vector indexes stored in this browser, installed training and knowledge packs, downloaded WebLLM model files (the default wllama engine stores none), and your saved settings (${CLEARED_SETTINGS_COPY}), plus orphaned data from earlier sessions, then reloads the page. Your chat history (conversations) is kept. This cannot be undone.`
                  : desktopApp
                    ? "Clear this app's browser-side indexes, any WebLLM model files downloaded in this window, and saved settings. Chat history and documents in the desktop library are kept."
                    : 'Clear downloaded WebLLM model files (the default wllama engine stores none), search indexes, installed packs, and saved settings in this browser. Chat history is kept.'}
              </span>
              {/* Result feedback (issue #24 F1). PR #140 review (FB140-002): the
                  polite live region is ALWAYS mounted and only its text changes
                  (a region inserted together with its message is not reliably
                  announced). Its own text node is the status badge. After a
                  successful clear a visually-hidden suffix tells screen-reader
                  users the page is about to reload; after a partial failure the
                  explanation is VISIBLE (a child span, so the badge text stays
                  exact), since a reload right after an error would otherwise
                  surprise sighted users too (Stage B review L2). */}
              <span
                id="clear-cache-status"
                role="status"
                aria-live="polite"
                data-result={clearCacheResult}
                className={
                  clearCacheResult === 'cleared'
                    ? 'settings-text settings-tone--success settings-strong'
                    : clearCacheResult === 'error'
                      ? 'settings-text settings-tone--danger settings-strong'
                      : 'settings-text'
                }
              >
                {clearCacheResult === 'clearing' && 'Clearing…'}
                {clearCacheResult === 'cleared' && 'Cache cleared'}
                {clearCacheResult === 'error' && 'Could not clear all data'}
                {clearCacheResult === 'cleared' && clearCacheReloading && (
                  <span className="ui-visually-hidden">. Reloading the page…</span>
                )}
                {clearCacheResult === 'error' && clearCacheReloading && (
                  <span>. Your saved settings were removed; reloading the page…</span>
                )}
              </span>
            </div>
          </SettingsSection>

          {/* ================================================================ */}
          {/* 5. Updates (E5, issue #88; both apps since browser-training-parity */}
          {/*    AC8 — opt-in, default OFF)                                      */}
          {/* ================================================================ */}
          <SettingsSection
            id="updates"
            title="Updates"
            headingId="updates-heading"
            focusableHeading
            data-testid="updates-section"
          >
            {electronMode || !desktopApp ? (
              <UpdatesSection />
            ) : (
              <p className="settings-text" data-testid="updates-unavailable">
                Update settings are available once the desktop backend has started.
              </p>
            )}
          </SettingsSection>

          {/* ================================================================ */}
          {/* 6. About (+ first-run setup in the desktop app, E2 issue #85) */}
          {/* ================================================================ */}
          <SettingsSection id="about" title="About" headingId="about-heading" focusableHeading>
            <div className="settings-group">
              <p className="settings-text settings-text--body">
                <strong>TrainingApp</strong>
              </p>
              <p className="settings-text settings-text--body">Version: {APP_VERSION}</p>
              <p className="settings-text settings-text--body">Answers questions about your training material and documents.</p>
              <p className="settings-text">
                {mode === 'api'
                  ? 'Answers come from the built-in desktop backend: llama.cpp (node-llama-cpp) generation with hybrid retrieval over the desktop document library.'
                  : 'Runs in this browser with WebLLM (WebGPU) or wllama (WebAssembly), or with the external model you configured; documents are stored in IndexedDB.'}
              </p>
            </div>
            {electronMode && <FirstRunSetupCard />}
          </SettingsSection>
        </div>
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

  const items: KeyValueItem[] = [
    {
      label: 'Packaged Models (overall)',
      value: (
        <span className={`settings-strong settings-inline-icon ${report.allReady ? 'settings-tone--success' : 'settings-tone--danger'}`}>
          {/* Decorative (aria-hidden) shape cue; the word carries the state. */}
          <Icon name={report.allReady ? 'circle-check' : 'circle-alert'} size={14} />
          {report.allReady ? 'Ready' : 'Missing'}
        </span>
      ),
    },
  ];
  for (const kind of kindOrder) {
    const models = byKind.get(kind);
    if (!models || models.length === 0) continue;
    // Suppress the packaged llm kind for webllm — its weights are in Cache
    // Storage, not packaged. Showing "Ready" here would contradict the
    // "Not cached" status above for a webllm user without a download.
    if (kind === 'llm' && browserEngine === 'webllm') {
      items.push({
        label: KIND_LABELS[kind],
        value: <span className="settings-text">WebLLM weights are not packaged — see cache status above</span>,
      });
      continue;
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
    items.push({ label: KIND_LABELS[kind], value: <StatusBadge status={status} label={label} /> });
  }

  return <KeyValueList items={items} />;
}

// ============================================================================
// SettingsPage (exported component — wraps with context providers)
// ============================================================================

export function SettingsPage(props: SettingsPageProps = {}): React.ReactElement {
  return <SettingsPageInner {...props} />;
}
