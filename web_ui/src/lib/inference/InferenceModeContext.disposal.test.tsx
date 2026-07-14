/**
 * Regression tests for InferenceModeContext's `setBrowserEngine` disposal
 * behavior.
 *
 * `setBrowserEngine` must dispose the previously-selected browser engine
 * whenever the engine PREFERENCE is actually changing — regardless of the
 * CURRENT `mode`. Previously it only disposed when `mode === 'browser-local'`,
 * which leaked the old engine when a user changed their engine preference
 * while in `'api'` mode (a real, UI-reachable path via SettingsPage's
 * non-mode-gated "Browser Engine" radio control). See issue #21 F-LEAK
 * follow-up.
 *
 * This file is intentionally separate from (and does not import)
 * `InferenceModeContext.test.tsx`, which is excluded from CI for unrelated
 * pre-existing fake-timer/mock drift reasons.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { InferenceModeProvider, useInferenceMode } from './InferenceModeContext';

// Mock the llm-factory module so we never pull in the real WASM/model-backed
// WebLLM/wllama service singletons — we only care that `disposeBrowserEngine`
// is invoked with the right argument.
const mockDisposeBrowserEngine = vi.fn();
vi.mock('../llm/llm-factory', () => ({
  disposeBrowserEngine: (...args: unknown[]) => mockDisposeBrowserEngine(...args),
}));

// Mock fetch since the provider's boot effect may call checkServerConnectivity
// when the persisted mode is 'api'.
const mockFetch = vi.fn();
global.fetch = mockFetch;

function wrapper({ children }: { children: React.ReactNode }) {
  return <InferenceModeProvider>{children}</InferenceModeProvider>;
}

describe('InferenceModeContext setBrowserEngine disposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    localStorage.clear();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    cleanup();
  });

  it('disposes the previous engine when changing engine while mode is browser-local', () => {
    const { result } = renderHook(() => useInferenceMode(), { wrapper });

    expect(result.current.mode).toBe('browser-local');
    expect(result.current.browserEngine).toBe('wllama');

    act(() => {
      result.current.setBrowserEngine('webllm');
    });

    expect(mockDisposeBrowserEngine).toHaveBeenCalledTimes(1);
    expect(mockDisposeBrowserEngine).toHaveBeenCalledWith('wllama');
    expect(result.current.browserEngine).toBe('webllm');
  });

  it('disposes the previous engine when changing engine while mode is api (regression for issue #21 F-LEAK follow-up)', () => {
    const { result } = renderHook(() => useInferenceMode(), { wrapper });

    act(() => {
      result.current.setMode('api');
    });
    expect(result.current.mode).toBe('api');

    // Sanity: no disposal has happened yet from the mode switch itself.
    expect(mockDisposeBrowserEngine).not.toHaveBeenCalled();

    act(() => {
      result.current.setBrowserEngine('webllm');
    });

    // This is the crux of the fix: even though mode is 'api' (not
    // 'browser-local'), the previously-selected engine preference must still
    // be disposed because the PREFERENCE changed.
    expect(mockDisposeBrowserEngine).toHaveBeenCalledTimes(1);
    expect(mockDisposeBrowserEngine).toHaveBeenCalledWith('wllama');
    expect(result.current.browserEngine).toBe('webllm');
  });

  it('does not dispose when setBrowserEngine is called with the same value (no actual change)', () => {
    const { result } = renderHook(() => useInferenceMode(), { wrapper });

    expect(result.current.browserEngine).toBe('wllama');

    act(() => {
      result.current.setBrowserEngine('wllama');
    });

    expect(mockDisposeBrowserEngine).not.toHaveBeenCalled();
    expect(result.current.browserEngine).toBe('wllama');
  });
});
