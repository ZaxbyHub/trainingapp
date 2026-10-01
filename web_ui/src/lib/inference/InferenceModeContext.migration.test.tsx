/**
 * settings-wiring-honesty (AC4): the browser app has no API-server mode.
 * Pins the one-way migration of a legacy browser `inference-mode` blob and
 * the refusal of `setMode('api')` outside the desktop app, with the REAL
 * InferenceModeProvider over real localStorage. (A separate file because
 * InferenceModeContext.test.tsx is excluded from CI for pre-existing drift.)
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { InferenceModeProvider, useInferenceMode } from './InferenceModeContext';
import { installDesktopBridgeStub, removeDesktopBridgeStub } from '../../test/desktop-bridge-stub';

vi.mock('../llm/llm-factory', () => ({ disposeBrowserEngine: vi.fn() }));

function wrapper({ children }: { children: React.ReactNode }) {
  return <InferenceModeProvider>{children}</InferenceModeProvider>;
}

function storedBlob(): Record<string, unknown> | null {
  const raw = localStorage.getItem('inference-mode');
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

const LEGACY_BROWSER_BLOB = {
  mode: 'api',
  serverUrl: 'http://127.0.0.1:8000',
  browserEngine: 'webllm',
  ragPreset: 'quality',
  providerConfig: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' },
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
});
afterEach(() => {
  cleanup();
  removeDesktopBridgeStub();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('InferenceModeContext legacy browser API-server migration (AC4)', () => {
  it('browser: legacy mode api migrates to browser-local, drops serverUrl, keeps browserEngine/ragPreset/providerConfig', () => {
    localStorage.setItem('inference-mode', JSON.stringify(LEGACY_BROWSER_BLOB));
    const { result } = renderHook(() => useInferenceMode(), { wrapper });

    expect(result.current.mode).toBe('browser-local');
    expect(result.current.serverUrl).toBe('');
    expect(result.current.browserEngine).toBe('webllm');
    expect(result.current.ragPreset).toBe('quality');
    const blob = storedBlob();
    expect(blob).not.toBeNull();
    expect(blob).not.toHaveProperty('serverUrl');
    expect(blob).toMatchObject({
      mode: 'browser-local',
      browserEngine: 'webllm',
      ragPreset: 'quality',
      providerConfig: LEGACY_BROWSER_BLOB.providerConfig,
    });
  });

  it('browser: a stored serverUrl is dropped even when the mode was already browser-local', () => {
    localStorage.setItem('inference-mode', JSON.stringify({ ...LEGACY_BROWSER_BLOB, mode: 'browser-local' }));
    renderHook(() => useInferenceMode(), { wrapper });
    expect(storedBlob()).not.toHaveProperty('serverUrl');
    expect(storedBlob()).toMatchObject({ mode: 'browser-local', ragPreset: 'quality' });
  });

  it('browser: setMode("api") is refused and later persists never write a serverUrl', () => {
    const { result } = renderHook(() => useInferenceMode(), { wrapper });
    act(() => result.current.setMode('api'));
    expect(result.current.mode).toBe('browser-local');
    act(() => result.current.setRagPreset('fast'));
    act(() => result.current.setMode('provider'));
    expect(result.current.mode).toBe('provider');
    const blob = storedBlob();
    expect(blob).toMatchObject({ mode: 'provider', ragPreset: 'fast' });
    expect(blob).not.toHaveProperty('serverUrl');
  });

  it('desktop app (positive leg): a stored api mode and its backend URL are kept, and setMode("api") works', () => {
    installDesktopBridgeStub();
    localStorage.setItem('inference-mode', JSON.stringify({ ...LEGACY_BROWSER_BLOB, mode: 'provider' }));
    const { result } = renderHook(() => useInferenceMode(), { wrapper });
    expect(result.current.mode).toBe('provider');
    act(() => result.current.setMode('api'));
    expect(result.current.mode).toBe('api');
    expect(result.current.serverUrl).toBe('http://127.0.0.1:8000');
    expect(storedBlob()).toMatchObject({ mode: 'api', serverUrl: 'http://127.0.0.1:8000' });
  });
});
