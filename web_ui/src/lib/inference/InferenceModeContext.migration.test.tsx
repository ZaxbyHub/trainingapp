/**
 * settings-wiring-honesty (AC4): the browser app has no API-server mode.
 * Pins the one-way migration of a legacy browser `inference-mode` blob and
 * the refusal of `setMode('api')` outside the desktop app, with the REAL
 * InferenceModeProvider over real localStorage. (A separate file because
 * InferenceModeContext.test.tsx is excluded from CI for pre-existing drift.)
 *
 * universal-provider-settings-overhaul: PR #138's 'provider' mode is retired.
 * A legacy browser blob's provider connection (`providerConfig` + the
 * `openai-provider-apikey` key) becomes the external-model configuration
 * once, and the legacy fields are deleted; inside the desktop app a stored
 * 'provider' mode means the desktop backend ('api').
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

function storedJson(key: string): Record<string, unknown> | null {
  const raw = localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}
const storedBlob = () => storedJson('inference-mode');

const LEGACY_BROWSER_BLOB = {
  mode: 'api',
  serverUrl: 'http://127.0.0.1:8000',
  browserEngine: 'webllm',
  ragPreset: 'quality',
  providerConfig: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' },
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
});
afterEach(() => {
  cleanup();
  removeDesktopBridgeStub();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('InferenceModeContext legacy browser API-server migration (AC4)', () => {
  it('browser: legacy mode api migrates to browser-local, drops serverUrl, keeps browserEngine/ragPreset; a legacy provider connection becomes a DISABLED external config', () => {
    localStorage.setItem('inference-mode', JSON.stringify(LEGACY_BROWSER_BLOB));
    const { result } = renderHook(() => useInferenceMode(), { wrapper });

    expect(result.current.mode).toBe('browser-local');
    expect(result.current.serverUrl).toBe('');
    expect(result.current.browserEngine).toBe('webllm');
    expect(result.current.ragPreset).toBe('quality');
    const blob = storedBlob();
    expect(blob).not.toBeNull();
    expect(blob).not.toHaveProperty('serverUrl');
    expect(blob).not.toHaveProperty('providerConfig');
    expect(blob).toMatchObject({ mode: 'browser-local', browserEngine: 'webllm', ragPreset: 'quality' });
    // The mode was not 'provider', so the migrated connection stays off.
    expect(storedJson('external-provider-config')).toMatchObject({
      enabled: false,
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      grounded: false,
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
    const blob = storedBlob();
    expect(blob).toMatchObject({ mode: 'browser-local', ragPreset: 'fast' });
    expect(blob).not.toHaveProperty('serverUrl');
  });

  it('desktop app (positive leg): a stored legacy provider mode loads as the backend, and setMode("api") works', () => {
    installDesktopBridgeStub();
    localStorage.setItem('inference-mode', JSON.stringify({ ...LEGACY_BROWSER_BLOB, mode: 'provider' }));
    const { result } = renderHook(() => useInferenceMode(), { wrapper });
    expect(result.current.mode).toBe('api');
    act(() => result.current.setMode('api'));
    expect(result.current.mode).toBe('api');
    expect(result.current.serverUrl).toBe('http://127.0.0.1:8000');
    expect(storedBlob()).toMatchObject({ mode: 'api', serverUrl: 'http://127.0.0.1:8000' });
  });
});

// PR #140 review (FB140-005): migration edge cases, plus the corrupt /
// unavailable / quota cases moved here from the CI-excluded
// InferenceModeContext.test.tsx so they actually run.
describe('InferenceModeContext legacy migration edge cases (FB140-005)', () => {
  it('is idempotent: a second load of the migrated blob changes nothing', () => {
    localStorage.setItem('inference-mode', JSON.stringify(LEGACY_BROWSER_BLOB));
    const first = renderHook(() => useInferenceMode(), { wrapper });
    const afterFirst = localStorage.getItem('inference-mode');
    const firstState = { mode: first.result.current.mode, serverUrl: first.result.current.serverUrl, ragPreset: first.result.current.ragPreset, browserEngine: first.result.current.browserEngine };
    first.unmount();

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    try {
      const second = renderHook(() => useInferenceMode(), { wrapper });
      expect(localStorage.getItem('inference-mode')).toBe(afterFirst);
      // Nothing left to migrate, so the second load writes nothing.
      expect(setItem).not.toHaveBeenCalled();
      expect({ mode: second.result.current.mode, serverUrl: second.result.current.serverUrl, ragPreset: second.result.current.ragPreset, browserEngine: second.result.current.browserEngine }).toEqual(firstState);
    } finally {
      setItem.mockRestore();
    }
  });

  it('keeps unknown sibling keys (written by other owners or newer builds) through the migration', () => {
    const futureFields = { futureFeature: { enabled: true, level: 3 }, someOtherOwnerKey: 'kept' };
    localStorage.setItem('inference-mode', JSON.stringify({ ...LEGACY_BROWSER_BLOB, ...futureFields }));
    renderHook(() => useInferenceMode(), { wrapper });
    const blob = storedBlob();
    expect(blob).not.toHaveProperty('serverUrl');
    expect(blob).toMatchObject({ mode: 'browser-local', ...futureFields, providerConfig: LEGACY_BROWSER_BLOB.providerConfig });
  });

  it('a quota error on the migration write still migrates the in-memory state', () => {
    localStorage.setItem('inference-mode', JSON.stringify(LEGACY_BROWSER_BLOB));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    try {
      const { result } = renderHook(() => useInferenceMode(), { wrapper });
      expect(setItem).toHaveBeenCalled();
      expect(result.current.mode).toBe('browser-local');
      expect(result.current.serverUrl).toBe('');
      expect(result.current.ragPreset).toBe('quality');
      expect(result.current.browserEngine).toBe('webllm');
    } finally {
      setItem.mockRestore();
    }
    // The write failed, so the stored blob is untouched (it migrates on a later load).
    expect(storedBlob()).toEqual(LEGACY_BROWSER_BLOB);
  });

  it.each([
    ['a JSON string', JSON.stringify('api')],
    ['a JSON array', JSON.stringify(['api', 'http://127.0.0.1:8000'])],
    ['JSON null', 'null'],
    ['a JSON number', '42'],
  ])('a non-object legacy blob (%s) loads the defaults without throwing or rewriting it', (_label, raw) => {
    localStorage.setItem('inference-mode', raw);
    const { result } = renderHook(() => useInferenceMode(), { wrapper });
    expect(result.current.mode).toBe('browser-local');
    expect(result.current.serverUrl).toBe('');
    expect(localStorage.getItem('inference-mode')).toBe(raw);
  });

  it('a corrupt (unparseable) blob falls back to the defaults', () => {
    localStorage.setItem('inference-mode', 'not valid json');
    const { result } = renderHook(() => useInferenceMode(), { wrapper });
    expect(result.current.mode).toBe('browser-local');
    expect(result.current.serverUrl).toBe('');
  });

  it('a throwing localStorage getter (storage disabled) falls back to the defaults', () => {
    const getter = vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('storage disabled', 'SecurityError');
    });
    try {
      const { result } = renderHook(() => useInferenceMode(), { wrapper });
      expect(getter).toHaveBeenCalled();
      expect(result.current.mode).toBe('browser-local');
      expect(result.current.serverUrl).toBe('');
      // A later persist with storage still disabled must not throw either.
      act(() => result.current.setRagPreset('fast'));
      expect(result.current.ragPreset).toBe('fast');
    } finally {
      getter.mockRestore();
    }
  });
});

describe('PR #138 provider-mode migration (universal-provider-settings-overhaul)', () => {
  it('browser: provider mode + legacy key become an ENABLED, ungrounded external config; legacy state is scrubbed', () => {
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({ mode: 'provider', ragPreset: 'fast', providerConfig: { baseUrl: 'http://127.0.0.1:8080', model: 'llama' } }),
    );
    localStorage.setItem('openai-provider-apikey', 'sk-legacy-111');
    const { result } = renderHook(() => useInferenceMode(), { wrapper });

    expect(result.current.mode).toBe('browser-local');
    expect(storedBlob()).toMatchObject({ mode: 'browser-local', ragPreset: 'fast' });
    expect(storedBlob()).not.toHaveProperty('providerConfig');
    expect(storedJson('external-provider-config')).toEqual({
      enabled: true,
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:8080',
      model: 'llama',
      grounded: false,
      rememberKey: true,
    });
    expect(localStorage.getItem('external-provider-apikey')).toBe('sk-legacy-111');
    expect(localStorage.getItem('openai-provider-apikey')).toBeNull();
  });

  it('browser: an existing external config is never overwritten by the migration', () => {
    const existing = { enabled: true, protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'c', grounded: true, rememberKey: false };
    localStorage.setItem('external-provider-config', JSON.stringify(existing));
    localStorage.setItem('inference-mode', JSON.stringify({ mode: 'provider', providerConfig: { baseUrl: 'http://127.0.0.1:8080', model: 'x' } }));
    localStorage.setItem('openai-provider-apikey', 'sk-legacy-222');
    renderHook(() => useInferenceMode(), { wrapper });
    expect(storedJson('external-provider-config')).toEqual(existing);
    expect(localStorage.getItem('openai-provider-apikey')).toBeNull();
    expect(localStorage.getItem('external-provider-apikey')).toBeNull();
  });
});
