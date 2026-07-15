/**
 * Settings page — inference mode, server configuration, browser engine &
 * model cache status, appearance, storage management, and about info.
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
import { RAG_PRESET_LABELS } from '../lib/rag/rag-presets';
import { getMemoryBudget, getMemoryPressureStatus } from '../lib/embeddings/memory-aware';
import { ModelDownloadProgress } from '../components/ModelDownloadProgress';
import { ProgressBar, StatusBadge, SectionCard } from '../components/SettingsMetrics';
import {
  getProfilePrefix,
  deleteNamespace,
  listStalePrefixes,
} from '../lib/storage/profile';

// ============================================================================
// Settings Store (IndexedDB)
// ============================================================================

const SETTINGS_DB_NAME = 'doc-qa-settings';
const SETTINGS_STORE_NAME = 'settings';
const SETTINGS_KEY = 'user-preferences';

/**
 * Persisted user preferences.
 *
 * Note (issue #24 F5): `theme` and `preferredModel` were removed — theme now
 * lives solely in `localStorage['theme-preference']` (owned by ThemeContext),
 * and `preferredModel` was dead (read by no runtime code; the readiness gate
 * resolves the model id per-engine via `modelIdForEngine`). Old IndexedDB
 * records may still carry these stale fields; they are simply ignored on load.
 */
interface UserPreferences {
  serverUrl: string;
}

interface StoredSettings extends UserPreferences {
  key: string;
  updatedAt: number;
}

let settingsDbInstance: IDBDatabase | null = null;

async function openSettingsDatabase(): Promise<IDBDatabase> {
  if (settingsDbInstance) {
    return settingsDbInstance;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SETTINGS_DB_NAME, 1);

    request.onerror = () => {
      reject(new Error(`Failed to open settings database: ${request.error}`));
    };

    request.onsuccess = () => {
      const db = request.result;
      // PRR-001: close the cached connection when a version change (e.g.
      // deleteDatabase from Clear Cache) is requested, so the delete is not
      // permanently blocked by this open connection. Without this, the
      // settings DB survives "Clear Cache" while the UI reports success.
      db.onversionchange = () => {
        db.close();
        settingsDbInstance = null;
      };
      settingsDbInstance = db;
      resolve(settingsDbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
        db.createObjectStore(SETTINGS_STORE_NAME, { keyPath: 'key' });
      }
    };
  });
}

async function loadSettings(): Promise<UserPreferences> {
  const defaults: UserPreferences = {
    serverUrl: '',
  };

  try {
    const db = await openSettingsDatabase();

    return new Promise((resolve) => {
      const transaction = db.transaction(SETTINGS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(SETTINGS_STORE_NAME);
      const request = store.get(SETTINGS_KEY);

      request.onerror = () => {
        resolve(defaults);
      };

      request.onsuccess = () => {
        const result = request.result as StoredSettings | undefined;
        if (result && result.key === SETTINGS_KEY) {
          resolve({
            serverUrl: result.serverUrl ?? defaults.serverUrl,
          });
        } else {
          resolve(defaults);
        }
      };
    });
  } catch {
    return defaults;
  }
}

async function saveSettings(settings: UserPreferences): Promise<void> {
  try {
    const db = await openSettingsDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SETTINGS_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(SETTINGS_STORE_NAME);
      const toStore: StoredSettings = { ...settings, key: SETTINGS_KEY, updatedAt: Date.now() };

      const request = store.put(toStore);

      request.onerror = () => {
        reject(new Error(`Failed to save settings: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  } catch (error) {
    console.error('Error saving settings to IndexedDB:', error);
  }
}

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
// App version
// ============================================================================

const APP_VERSION = '1.0.0';

// ============================================================================
// Styles
// ============================================================================

const pageStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'auto',
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
  overflow: 'auto',
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
  marginTop: `calc(-1 * var(--spacing-sm))`,
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
  borderColor: 'var(--color-primary)',
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

function SettingsPageInner(): React.ReactElement {
  const {
    mode,
    browserEngine,
    setBrowserEngine,
    ragPreset,
    setRagPreset,
    isServerConnected,
    serverUrl,
    setMode,
    setServerUrl,
    checkServerConnectivity,
  } = useInferenceMode();

  const { themePreference, setTheme } = useTheme();

  // Settings state
  const [localServerUrl, setLocalServerUrl] = useState<string>(serverUrl);

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

  // Connection test state
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<'success' | 'error' | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  // Hardware capability + packaged-model readiness (Phase 3)
  const [capability, setCapability] = useState<EngineCapability | null>(null);
  const [packagesReady, setPackagesReady] = useState<PackagedModelsReport | null>(null);

  // Settings loaded flag
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Load settings on mount
  useEffect(() => {
    loadSettings().then((settings) => {
      setLocalServerUrl(settings.serverUrl);
      setSettingsLoaded(true);
    });

    return () => {
      if (clearTimeoutRef.current) {
        clearTimeout(clearTimeoutRef.current);
      }
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
    };
  }, []);

  // isMountedRef to guard async state updates after unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Sync serverUrl from context to local state
  useEffect(() => {
    setLocalServerUrl(serverUrl);
  }, [serverUrl]);

  // Check model cache status — engine-aware (issue #24 F4).
  // Previously this called checkModelCached(preferredModel) which defaulted
  // engine='webllm', so a wllama user saw "Not cached" for their packaged GGUF.
  // Now resolve the model id per-engine via modelIdForEngine and pass the
  // actually-selected browserEngine.
  useEffect(() => {
    if (!settingsLoaded) return;

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
  }, [browserEngine, readinessGate, settingsLoaded]);

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
    if (!settingsLoaded) return;

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
  }, [settingsLoaded]);

  // Persist settings when they change
  const persistSettings = useCallback(
    (updates: Partial<UserPreferences>) => {
      saveSettings({
        serverUrl: localServerUrl,
        ...updates,
      });
    },
    [localServerUrl]
  );

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

  // Handle server URL change
  const handleServerUrlChange = useCallback(
    (newUrl: string) => {
      setLocalServerUrl(newUrl);
      setConnectionResult(null);
    },
    []
  );

  // Handle server URL blur — persist
  const handleServerUrlBlur = useCallback(() => {
    setServerUrl(localServerUrl);
    persistSettings({ serverUrl: localServerUrl });
  }, [localServerUrl, persistSettings, setServerUrl]);

  // Test connection
  const handleTestConnection = useCallback(async () => {
    setIsTestingConnection(true);
    setConnectionResult(null);

    // Persist the current local value before testing
    setServerUrl(localServerUrl);

    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
    }
    connectionTimeoutRef.current = setTimeout(() => {
      if (!isMountedRef.current) return;
      setIsTestingConnection(false);
      setConnectionResult('error');
    }, 5000);

    const connected = await checkServerConnectivity();

    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    if (!isMountedRef.current) return;
    setIsTestingConnection(false);
    setConnectionResult(connected ? 'success' : 'error');
  }, [checkServerConnectivity, localServerUrl, setServerUrl]);

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

        // 4. Settings IndexedDB (non-prefixed).
        // Close the cached connection first so deleteDatabase is not blocked
        // (PRR-001). The onversionchange handler in openSettingsDatabase also
        // fires, but closing here is deterministic and immediate.
        if (settingsDbInstance) {
          try {
            settingsDbInstance.close();
          } catch {
            // already closed
          }
          settingsDbInstance = null;
        }
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

        setClearCacheResult('cleared');
      } catch (err) {
        console.error('Error clearing cache:', err);
        setClearCacheResult('error');
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
  }, [clearCacheState]);

  // Format memory for display
  const formatMemory = (mb: number): string => {
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${mb} MB`;
  };

  if (!settingsLoaded) {
    return (
      <div style={pageStyle}>
        <div style={headerStyle}>
          <h1 style={titleStyle}>Settings</h1>
        </div>
        <div style={contentStyle}>
          <p style={{ color: 'var(--color-text-muted)' }}>Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={titleStyle}>Settings</h1>
      </div>

      <div style={contentStyle}>
        {/* ================================================================== */}
        {/* 1. Inference Mode */}
        {/* ================================================================== */}
        <section style={sectionStyle} aria-labelledby="inference-mode-heading">
          <h2 id="inference-mode-heading" style={sectionTitleStyle}>
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
                      Run the AI model directly in your browser (CPU via wllama, or WebGPU via WebLLM — choose below)
                    </p>
                  </div>
                </label>

                {/* API server option */}
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
                      Connect to a remote inference server
                    </p>
                  </div>
                </label>
              </div>
            </fieldset>
          </div>
        </section>

        {/* ================================================================== */}
        {/* 2. Server Configuration (conditional on API mode) */}
        {/* ================================================================== */}
        {mode === 'api' && (
          <section style={sectionStyle} aria-labelledby="server-config-heading">
            <h2 id="server-config-heading" style={sectionTitleStyle}>
              Server Configuration
            </h2>
            <div style={fieldGroupStyle}>
              <div>
                <label htmlFor="server-url" style={labelStyle}>
                  Server URL
                </label>
                <p id="server-url-desc" style={descriptionStyle}>
                  Enter the base URL of your inference server (e.g., http://localhost:8080)
                </p>
                <input
                  id="server-url"
                  type="url"
                  value={localServerUrl}
                  onChange={(e) => handleServerUrlChange(e.target.value)}
                  onBlur={handleServerUrlBlur}
                  placeholder="http://localhost:8080"
                  style={inputStyle}
                  aria-describedby="server-url-desc"
                />
              </div>

              <div style={buttonRowStyle} role="status" aria-live="polite">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={isTestingConnection || !localServerUrl}
                  style={
                    isTestingConnection
                      ? { ...secondaryButtonStyle, opacity: 0.6, cursor: 'not-allowed' }
                      : secondaryButtonStyle
                  }
                  aria-busy={isTestingConnection}
                >
                  {isTestingConnection ? 'Testing...' : 'Test Connection'}
                </button>

                {connectionResult === 'success' && (
                  <StatusBadge status="ready" label="Connected" />
                )}
                {connectionResult === 'error' && (
                  <StatusBadge status="error" label="Connection failed" />
                )}

                {isServerConnected && connectionResult === null && (
                  <StatusBadge status="ready" label="Connected" />
                )}
              </div>
            </div>
          </section>
        )}

        {/* ================================================================== */}
        {/* 3. Browser Engine (browser-local only) + model cache status */}
        {/* ================================================================== */}
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
                    desc: 'Robust without WebGPU and supports image input (multimodal). Recommended for most hardware.',
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
                      <p id={`${opt.id}-desc`} style={descriptionStyle}>{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>
            {capability && browserEngine === 'webllm' && !capability.webgpu && (
              <p style={{ ...descriptionStyle, color: 'var(--color-danger)' }}>
                WebGPU was not detected — WebLLM will not run on this device. Switch to wllama or use server mode.
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

                {browserEngine === 'wllama' && (
                  <p style={descriptionStyle}>
                    Weights are bundled with this build — no download needed. The model loads automatically on first use.
                  </p>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ================================================================== */}
        {/* 4. Response Quality (RAG preset) */}
        {/* ================================================================== */}
        <section style={sectionStyle} aria-labelledby="rag-preset-heading">
          <h2 id="rag-preset-heading" style={sectionTitleStyle}>
            Response Quality
          </h2>
          <div style={fieldGroupStyle}>
            <p style={descriptionStyle}>
              Trade speed for answer quality. Applies to browser-local mode; in API
              mode the server controls retrieval settings.
            </p>
            <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>Select response quality preset</legend>
              <div style={radioGroupStyle}>
                {(['fast', 'balanced', 'quality'] as const).map((preset) => (
                  <label
                    key={preset}
                    style={ragPreset === preset ? radioOptionSelectedStyle : radioOptionStyle}
                  >
                    <input
                      type="radio"
                      name="rag-preset"
                      value={preset}
                      checked={ragPreset === preset}
                      onChange={() => setRagPreset(preset)}
                      style={radioInputStyle}
                      aria-describedby={`rag-${preset}-desc`}
                    />
                    <div>
                      <span style={radioLabelStyle}>{RAG_PRESET_LABELS[preset].label}</span>
                      <p id={`rag-${preset}-desc`} style={descriptionStyle}>
                        {RAG_PRESET_LABELS[preset].description}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>
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
        {/* 6. Storage */}
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
          <ProgressBar
            value={memoryTotal - memoryAvailable}
            max={memoryTotal}
            label={`Memory Used (${formatMemory(memoryTotal - memoryAvailable)} of ${formatMemory(memoryTotal)})`}
            color={memoryPressure === 'normal' ? 'success' : memoryPressure === 'moderate' ? 'warning' : 'danger'}
          />
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
              {clearCacheState === 'confirming'
                ? 'This will delete all documents, keyword/vector indexes, cached model weights, and settings for this profile, plus any orphaned data from previous sessions. This cannot be undone.'
                : 'Clear cached documents, indexes, model weights, and settings from browser storage.'}
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
                label={`Hardware Suitability: ${capability.tier === 'green' ? 'Good' : capability.tier === 'yellow' ? 'Limited' : 'Use Server Mode'}`}
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

        {/* ================================================================== */}
        {/* 8. About */}
        {/* ================================================================== */}
        <section style={sectionStyle} aria-labelledby="about-heading">
          <h2 id="about-heading" style={sectionTitleStyle}>
            About
          </h2>
          <div style={aboutSectionStyle}>
            <p>
              <strong>Document Q&amp;A</strong>
            </p>
            <p>Version: {APP_VERSION}</p>
            <p>
              A RAG-powered document question answering application with offline-first
              browser-local inference.
            </p>
            <p style={{ marginTop: 'var(--spacing-md)', fontSize: 'var(--font-size-caption)' }}>
              Built with WebGPU, WebLLM, and IndexedDB for privacy-respecting AI assistance.
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

export function SettingsPage(): React.ReactElement {
  return <SettingsPageInner />;
}
