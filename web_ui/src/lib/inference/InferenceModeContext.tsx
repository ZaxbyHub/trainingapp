/**
 * Inference mode context - manages browser-local vs API mode state.
 * Provides state management for dual-mode architecture (Phase 5).
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';

export type InferenceMode = 'browser-local' | 'api';

interface InferenceModeState {
  mode: InferenceMode;
  isModelReady: boolean;
  isServerConnected: boolean;
  modelLoadingProgress: number;
  serverUrl: string;
  modeError: string | null;
}

interface InferenceModeContextValue extends InferenceModeState {
  setMode: (mode: InferenceMode) => void;
  setServerUrl: (url: string) => void;
  checkServerConnectivity: () => Promise<boolean>;
  setModelReady: (ready: boolean) => void;
  setModelLoadingProgress: (progress: number) => void;
}

const STORAGE_KEY = 'inference-mode';

interface StoredInferenceMode {
  mode: InferenceMode;
  serverUrl: string;
}

const defaultState: InferenceModeState = {
  mode: 'browser-local',
  isModelReady: false,
  isServerConnected: false,
  modelLoadingProgress: 0,
  serverUrl: '',
  modeError: null,
};

const InferenceModeContext = createContext<InferenceModeContextValue | null>(null);

function loadStoredState(): InferenceModeState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed: StoredInferenceMode = JSON.parse(stored);
      return {
        ...defaultState,
        mode: parsed.mode || 'browser-local',
        serverUrl: parsed.serverUrl || defaultState.serverUrl,
      };
    }
  } catch {
    // localStorage not available or parse error
  }
  return defaultState;
}

function persistState(mode: InferenceMode, serverUrl: string): void {
  try {
    const toStore: StoredInferenceMode = { mode, serverUrl };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch {
    // localStorage not available or quota exceeded
  }
}

export function InferenceModeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<InferenceModeState>(loadStoredState);
  const abortControllerRef = useRef<AbortController | null>(null);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  // Cleanup abort controller, timeout, and mounted flag on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  const setMode = useCallback((mode: InferenceMode) => {
    setState((prev) => {
      const next = { ...prev, mode, modeError: null };
      persistState(mode, prev.serverUrl);
      return next;
    });
  }, []);

  const setServerUrl = useCallback((serverUrl: string) => {
    setState((prev) => {
      const next = { ...prev, serverUrl };
      persistState(prev.mode, serverUrl);
      return next;
    });
  }, []);

  const checkServerConnectivity = useCallback(async (): Promise<boolean> => {
    // Cancel any pending request and clear previous timeout
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (timeoutIdRef.current) {
      clearTimeout(timeoutIdRef.current);
      timeoutIdRef.current = null;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    timeoutIdRef.current = setTimeout(() => {
      abortControllerRef.current?.abort();
    }, 5000);

    try {
      const url = state.serverUrl.replace(/\/$/, '');
      const endpoint = url ? `${url}/auth/status` : '/auth/status';
      const response = await fetch(endpoint, {
        method: 'GET',
        signal: controller.signal,
        credentials: 'include',
      });

      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }

      if (response.ok) {
        if (isMountedRef.current) {
          setState((prev) => ({ ...prev, isServerConnected: true, modeError: null }));
        }
        return true;
      }

      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          isServerConnected: false,
          modeError: `Server returned ${response.status}`,
        }));
      }
      return false;
    } catch {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          isServerConnected: false,
          modeError: 'Server unreachable',
        }));
      }
      return false;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [state.serverUrl]);

  const setModelReady = useCallback((ready: boolean) => {
    setState((prev) => ({
      ...prev,
      isModelReady: ready,
      modeError: ready ? null : prev.modeError,
    }));
  }, []);

  const setModelLoadingProgress = useCallback((progress: number) => {
    setState((prev) => ({ ...prev, modelLoadingProgress: Math.min(100, Math.max(0, progress)) }));
  }, []);

  const value: InferenceModeContextValue = {
    ...state,
    setMode,
    setServerUrl,
    checkServerConnectivity,
    setModelReady,
    setModelLoadingProgress,
  };

  return (
    <InferenceModeContext.Provider value={value}>
      {children}
    </InferenceModeContext.Provider>
  );
}

export function useInferenceMode(): InferenceModeContextValue {
  const context = useContext(InferenceModeContext);
  if (!context) {
    throw new Error('useInferenceMode must be used within InferenceModeProvider');
  }
  return context;
}
