/**
 * Settings page — inference mode, server configuration, model selection,
 * appearance, storage management, and about info.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useInferenceMode } from '../lib/inference';
import { useTheme } from '../lib/theme';
import { ModelDownloadManager, type DownloadProgress } from '../lib/llm/model-download';
import { ModelReadinessGate } from '../lib/llm/model-readiness';
import { getMemoryBudget, getMemoryPressureStatus } from '../lib/embeddings/memory-aware';
import { ModelDownloadProgress } from '../components/ModelDownloadProgress';

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
    preferredModel: 'SmolLM3-3B-Q4_K_M',
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
    id: 'SmolLM3-3B-Q4_K_M',
    label: 'SmolLM3-3B-Q4_K_M',
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

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2364748b' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
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

const statusBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--spacing-xs)',
  padding: 'var(--spacing-xs) var(--spacing-sm)',
  borderRadius: '12px',
  fontSize: 'var(--font-size-caption)',
  fontFamily: 'var(--font-family)',
  fontWeight: 500,
};

const statusReadyStyle: React.CSSProperties = {
  ...statusBadgeStyle,
  backgroundColor: 'rgba(34, 197, 94, 0.15)',
  color: '#16a34a',
};

const statusNotReadyStyle: React.CSSProperties = {
  ...statusBadgeStyle,
  backgroundColor: 'rgba(234, 179, 8, 0.15)',
  color: '#ca8a04',
};

const statusErrorStyle: React.CSSProperties = {
  ...statusBadgeStyle,
  backgroundColor: 'rgba(211, 47, 47, 0.15)',
  color: '#dc2626',
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
    isServerConnected,
    serverUrl,
    setMode,
    setServerUrl,
    checkServerConnectivity,
  } = useInferenceMode();

  const { theme, toggleTheme } = useTheme();

  // Settings state
  const [preferredModel, setPreferredModel] = useState<string>('SmolLM3-3B-Q4_K_M');
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

  // Clear cache confirm state
  const [clearCacheState, setClearCacheState] = useState<'idle' | 'confirming'>('idle');
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connection test state
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<'success' | 'error' | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Update memory pressure periodically
  useEffect(() => {
    if (!settingsLoaded) return;

    const updateMemoryStatus = () => {
      const pressure = getMemoryPressureStatus();
      const budget = getMemoryBudget();
      setMemoryPressure(pressure);
      setMemoryAvailable(budget.availableMB);
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
      setIsTestingConnection(false);
      setConnectionResult('error');
    }, 5000);

    const connected = await checkServerConnectivity();

    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }

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
        setDownloadProgress(progress);
        if (progress.status === 'complete') {
          setModelCached(true);
          setIsDownloading(false);
        } else if (progress.status === 'error') {
          setIsDownloading(false);
        }
      });
    } catch (err: unknown) {
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
                      Run AI model directly in your browser using WebGPU (requires ~2GB storage)
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
                  <span style={statusReadyStyle}>
                    <span aria-hidden="true">✓</span> Connected
                  </span>
                )}
                {connectionResult === 'error' && (
                  <span style={statusErrorStyle}>
                    <span aria-hidden="true">✗</span> Connection failed
                  </span>
                )}

                {isServerConnected && connectionResult === null && (
                  <span style={statusReadyStyle}>
                    <span aria-hidden="true">✓</span> Connected
                  </span>
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
                  <span style={statusReadyStyle}>
                    <span aria-hidden="true">✓</span> Cached
                  </span>
                ) : (
                  <span style={statusNotReadyStyle}>
                    <span aria-hidden="true">○</span> Not cached
                  </span>
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
        <section style={sectionStyle} aria-labelledby="storage-heading">
          <h2 id="storage-heading" style={sectionTitleStyle}>
            Storage
          </h2>
          <div style={storageInfoStyle}>
            <div style={storageRowStyle}>
              <span style={storageLabelStyle}>Available Memory</span>
              <span>{formatMemory(memoryAvailable)}</span>
            </div>
            <div style={storageRowStyle}>
              <span style={storageLabelStyle}>Memory Pressure</span>
              <span
                style={{
                  color:
                    memoryPressure === 'normal'
                      ? '#16a34a'
                      : memoryPressure === 'moderate'
                        ? '#ca8a04'
                        : '#dc2626',
                  fontWeight: 500,
                }}
              >
                {memoryPressure.charAt(0).toUpperCase() + memoryPressure.slice(1)}
              </span>
            </div>
            <div style={storageRowStyle}>
              <span style={storageLabelStyle}>Selected Model</span>
              <span>{selectedModelInfo?.label ?? 'Unknown'}</span>
            </div>
            <div style={storageRowStyle}>
              <span style={storageLabelStyle}>Model Cached</span>
              <span>{modelCached ? 'Yes' : 'No'}</span>
            </div>
          </div>

          <div style={buttonRowStyle}>
            <button
              type="button"
              onClick={handleClearCacheClick}
              style={
                clearCacheState === 'confirming'
                  ? { ...dangerButtonStyle, backgroundColor: '#b91c1c' }
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
        </section>

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
