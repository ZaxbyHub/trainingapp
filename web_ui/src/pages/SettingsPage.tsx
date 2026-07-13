/**
 * Settings page — inference mode, server configuration, model selection,
 * appearance, storage management, and about info.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useInferenceMode } from '../lib/inference';
import { useTheme } from '../lib/theme';
import { ModelDownloadManager, type DownloadProgress } from '../lib/llm/model-download';
import { ModelReadinessGate } from '../lib/llm/model-readiness';
import { resetReadinessCache, ensureReadinessGateChecked } from '../lib/llm/readiness-gate';
import { detectEngineCapability, type EngineCapability } from '../lib/llm/engine-capability';
import { checkPackagedModels, type PackagedModelsReport } from '../lib/models/model-manifest';
import { RAG_PRESET_LABELS } from '../lib/rag/rag-presets';
import { getMemoryBudget, getMemoryPressureStatus } from '../lib/embeddings/memory-aware';
import { ModelDownloadProgress } from '../components/ModelDownloadProgress';
import { ProgressBar, StatusBadge, SectionCard } from '../components/SettingsMetrics';

// ============================================================================
// Settings Store (IndexedDB)
// ============================================================================

const SETTINGS_DB_NAME = 'doc-qa-settings';
const SETTINGS_STORE_NAME = 'settings';
const SETTINGS_KEY = 'user-preferences';

interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  preferredModel: string;
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
      settingsDbInstance = request.result;
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
    theme: 'system',
    preferredModel: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
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
            theme: result.theme ?? defaults.theme,
            preferredModel: result.preferredModel ?? defaults.preferredModel,
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
// Available models
// ============================================================================

interface ModelOption {
  id: string;
  label: string;
  description: string;
  sizeEstimate: string;
}

const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    label: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    description: 'Fast, efficient model optimized for local inference',
    sizeEstimate: '~1.9 GB',
  },
];

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

// SVG data URLs cannot reference CSS variables, so we use the literal hex value
// of --color-text-muted (#64748b in light mode). This is intentional.
const SELECT_DROPDOWN_ARROW_COLOR = '#64748b';
const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23${SELECT_DROPDOWN_ARROW_COLOR.slice(1)}' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: '36px',
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

  const { theme, toggleTheme } = useTheme();

  // Settings state
  const [preferredModel, setPreferredModel] = useState<string>('Llama-3.2-3B-Instruct-q4f16_1-MLC');
  const [localServerUrl, setLocalServerUrl] = useState<string>(serverUrl);
  const [themePreference, setThemePreference] = useState<'light' | 'dark' | 'system'>('system');

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

  // Clear cache confirm state
  const [clearCacheState, setClearCacheState] = useState<'idle' | 'confirming'>('idle');
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
      setPreferredModel(settings.preferredModel);
      setLocalServerUrl(settings.serverUrl);
      setThemePreference(settings.theme);
      // Apply theme preference
      if (settings.theme === 'system') {
        // System default — no explicit toggle needed
      } else if (settings.theme !== theme) {
        toggleTheme();
      }
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

  // Check model cache status when model changes
  useEffect(() => {
    if (!settingsLoaded) return;

    readinessGate.checkModelCached(preferredModel).then((cached) => {
      setModelCached(cached);
    });
  }, [preferredModel, readinessGate, settingsLoaded]);

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

  // Update memory pressure periodically
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
  }, [settingsLoaded]);

  // Persist settings when they change
  const persistSettings = useCallback(
    (updates: Partial<UserPreferences>) => {
      saveSettings({
        theme: themePreference,
        preferredModel,
        serverUrl: localServerUrl,
        ...updates,
      });
    },
    [themePreference, preferredModel, localServerUrl]
  );

  // Handle theme preference change
  const handleThemeChange = useCallback(
    (newTheme: 'light' | 'dark' | 'system') => {
      setThemePreference(newTheme);
      persistSettings({ theme: newTheme });

      if (newTheme === 'system') {
        // Clear stored preference so ThemeProvider's media query listener takes over
        localStorage.removeItem('theme-preference');
        // If OS preference differs from current theme, toggle to align
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (prefersDark && theme === 'light') {
          toggleTheme();
        } else if (!prefersDark && theme === 'dark') {
          toggleTheme();
        }
      } else if (newTheme !== theme) {
        toggleTheme();
      }
    },
    [theme, toggleTheme, persistSettings]
  );

  // Handle model change
  const handleModelChange = useCallback(
    (newModel: string) => {
      setPreferredModel(newModel);
      persistSettings({ preferredModel: newModel });
    },
    [persistSettings]
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

  // Download model
  const handleDownloadModel = useCallback(async () => {
    if (!downloadManagerRef.current) {
      downloadManagerRef.current = new ModelDownloadManager();
    }

    setIsDownloading(true);
    setIsQuotaError(false);
    setDownloadProgress(null);

    try {
      await downloadManagerRef.current.downloadModel(preferredModel, (progress) => {
        if (!isMountedRef.current) return;
        setDownloadProgress(progress);
        if (progress.status === 'complete') {
          setModelCached(true);
          setIsDownloading(false);
          // Re-dispatch the readiness gate so the rest of the app (e.g. the chat
          // model-block overlay) flips to isModelReady=true now that the model
          // is in OPFS. Without this, the cached readiness result still reports
          // modelCached=false until an engine switch forces a re-check.
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
  }, [preferredModel]);

  // Cancel download
  const handleCancelDownload = useCallback(() => {
    downloadManagerRef.current?.cancelDownload();
    setIsDownloading(false);
  }, []);

  // Clear cache (two-click confirm)
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

        // Clear IndexedDB and OPFS
        try {
          const deleteReq = indexedDB.deleteDatabase('doc-qa-documents');
          deleteReq.onsuccess = () => {
            console.info('Documents IndexedDB cleared');
          };
          const settingsDeleteReq = indexedDB.deleteDatabase(SETTINGS_DB_NAME);
          settingsDeleteReq.onsuccess = () => {
            settingsDbInstance = null;
            console.info('Settings IndexedDB cleared');
          };
          // Clear OPFS (cached models)
          await navigator.storage?.getDirectory()?.then(dir => dir.removeEntry('webllm', { recursive: true }).catch(() => {}));
          console.info('Cache clear completed — documents and models cleared');
        } catch (err) {
          console.error('Error clearing cache:', err);
        }
    }
  }, [clearCacheState]);

  // Format memory for display
  const formatMemory = (mb: number): string => {
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${mb} MB`;
  };

  // Get model info for selected model
  const selectedModelInfo = AVAILABLE_MODELS.find((m) => m.id === preferredModel);

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
                <div
                  style={mode === 'browser-local' ? radioOptionSelectedStyle : radioOptionStyle}
                  onClick={() => setMode('browser-local')}
                  role="radio"
                  aria-checked={mode === 'browser-local'}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setMode('browser-local');
                    }
                  }}
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
                </div>

                {/* API server option */}
                <div
                  style={mode === 'api' ? radioOptionSelectedStyle : radioOptionStyle}
                  onClick={() => setMode('api')}
                  role="radio"
                  aria-checked={mode === 'api'}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setMode('api');
                    }
                  }}
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
                </div>
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

              <div style={buttonRowStyle}>
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
        {/* 3. Model Selection */}
        {/* ================================================================== */}
        <section style={sectionStyle} aria-labelledby="model-selection-heading">
          <h2 id="model-selection-heading" style={sectionTitleStyle}>
            Model Selection
          </h2>
          <div style={fieldGroupStyle}>
            <div>
              <label htmlFor="model-select" style={labelStyle}>
                AI Model
              </label>
              <p id="model-select-desc" style={descriptionStyle}>
                Choose the AI model for browser-local inference
              </p>
              <select
                id="model-select"
                value={preferredModel}
                onChange={(e) => handleModelChange(e.target.value)}
                style={selectStyle}
                aria-describedby="model-select-desc"
                disabled={mode === 'api'}
              >
                {AVAILABLE_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} ({model.sizeEstimate})
                  </option>
                ))}
              </select>
            </div>

            {selectedModelInfo && (
              <p style={descriptionStyle}>{selectedModelInfo.description}</p>
            )}

            {/* Cache status */}
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

            {/* Download button */}
            {mode === 'browser-local' && !modelCached && !isDownloading && (
              <button
                type="button"
                onClick={handleDownloadModel}
                style={primaryButtonStyle}
              >
                Download Model
              </button>
            )}

            {mode === 'browser-local' && modelCached && !isDownloading && (
              <span style={{ ...labelStyle, color: 'var(--color-primary)' }}>
                Model ready to use
              </span>
            )}

            {mode === 'api' && (
              <p style={descriptionStyle}>
                Model downloads are only available in browser-local mode
              </p>
            )}
          </div>
        </section>

        {/* ================================================================== */}
        {/* 3b. Browser Engine (browser-local only) */}
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
                  <div
                    key={opt.id}
                    style={browserEngine === opt.id ? radioOptionSelectedStyle : radioOptionStyle}
                    onClick={() => setBrowserEngine(opt.id)}
                    role="radio"
                    aria-checked={browserEngine === opt.id}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setBrowserEngine(opt.id);
                      }
                    }}
                  >
                    <input
                      type="radio"
                      name="browser-engine"
                      value={opt.id}
                      checked={browserEngine === opt.id}
                      onChange={() => setBrowserEngine(opt.id)}
                      // Stop the native input click from bubbling to the row's
                      // onClick, which would call setBrowserEngine a second time.
                      onClick={(e) => e.stopPropagation()}
                      style={radioInputStyle}
                      aria-describedby={`${opt.id}-desc`}
                    />
                    <div>
                      <span style={radioLabelStyle}>{opt.label}</span>
                      <p id={`${opt.id}-desc`} style={descriptionStyle}>{opt.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </fieldset>
            {capability && browserEngine === 'webllm' && !capability.webgpu && (
              <p style={{ ...descriptionStyle, color: 'var(--color-danger)' }}>
                WebGPU was not detected — WebLLM will not run on this device. Switch to wllama or use server mode.
              </p>
            )}
          </div>
        </section>

        {/* ================================================================== */}
        {/* 3c. Response Quality (RAG preset) */}
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
                  <div
                    key={preset}
                    style={ragPreset === preset ? radioOptionSelectedStyle : radioOptionStyle}
                    onClick={() => setRagPreset(preset)}
                    role="radio"
                    aria-checked={ragPreset === preset}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setRagPreset(preset);
                      }
                    }}
                  >
                    <input
                      type="radio"
                      name="rag-preset"
                      value={preset}
                      checked={ragPreset === preset}
                      onChange={() => setRagPreset(preset)}
                      // Stop the native input click from bubbling to the row's
                      // onClick, which would call setRagPreset a second time.
                      onClick={(e) => e.stopPropagation()}
                      style={radioInputStyle}
                      aria-describedby={`rag-${preset}-desc`}
                    />
                    <div>
                      <span style={radioLabelStyle}>{RAG_PRESET_LABELS[preset].label}</span>
                      <p id={`rag-${preset}-desc`} style={descriptionStyle}>
                        {RAG_PRESET_LABELS[preset].description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </fieldset>
          </div>
        </section>

        {/* ================================================================== */}
        {/* 4. Appearance */}
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
                  <div
                    key={option}
                    style={
                      themePreference === option
                        ? radioOptionSelectedStyle
                        : radioOptionStyle
                    }
                    onClick={() => handleThemeChange(option)}
                    role="radio"
                    aria-checked={themePreference === option}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleThemeChange(option);
                      }
                    }}
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
                  </div>
                ))}
              </div>
            </fieldset>
          </div>
        </section>

        {/* ================================================================== */}
        {/* 5. Storage */}
        {/* ================================================================== */}
        <SectionCard
          title="Storage"
          id="storage-heading"
          description="Browser storage status and cache management"
        >
          {packagesReady && (
            <div
              style={{
                ...storageInfoStyle,
                borderLeft: `4px solid ${packagesReady.allReady ? 'var(--color-success)' : 'var(--color-danger)'}`,
              }}
            >
              <div style={storageRowStyle}>
                <span style={storageLabelStyle}>Packaged Models</span>
                <span style={{ fontWeight: 500, color: packagesReady.allReady ? 'var(--color-success)' : 'var(--color-danger)' }}>
                  <span aria-hidden="true">{packagesReady.allReady ? '✓ ' : '✗ '}</span>
                  {packagesReady.allReady ? 'Ready' : 'Missing'}
                </span>
              </div>
              {!packagesReady.allReady && (
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
            <span id="clear-cache-desc" style={descriptionStyle}>
              {clearCacheState === 'confirming'
                ? 'Are you sure? Click again to clear all cached data.'
                : 'Clear cached models and stored documents from browser storage.'}
            </span>
          </div>
        </SectionCard>

        {/* ================================================================== */}
        {/* 5b. Hardware Capability (diagnostic) */}
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
        {/* 6. About */}
        {/* ================================================================== */}
        <section style={sectionStyle} aria-labelledby="about-heading">
          <h2 id="about-heading" style={sectionTitleStyle}>
            About
          </h2>
          <div style={aboutSectionStyle}>
            <p>
              <strong>Document Q&A</strong>
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
// SettingsPage (exported component — wraps with context providers)
// ============================================================================

export function SettingsPage(): React.ReactElement {
  return <SettingsPageInner />;
}
