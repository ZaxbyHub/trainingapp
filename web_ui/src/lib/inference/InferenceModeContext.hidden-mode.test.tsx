/**
 * TST-5 (#265 A3-ii, hidden-mode seam): the REAL provider's loadStoredState
 * path with WEBLLM_VISIBLE = false — a persisted browserEngine 'webllm' that
 * outlives a switch to a packaged/offline build loads as 'wllama' in memory.
 * The visible-mode context legs live in InferenceModeContext.test.tsx; this
 * file pins the hidden-mode normalization through the provider itself (a
 * minimal consumer of the context, mirroring how those tests construct
 * state).
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The seam under test: the packaged-build visibility policy.
vi.mock('../llm/engine-visibility', () => ({ WEBLLM_VISIBLE: false }));

import { InferenceModeProvider, useInferenceMode } from './InferenceModeContext';

function EngineProbe() {
  const { mode, browserEngine } = useInferenceMode();
  return (
    <>
      <div data-testid="mode">{mode}</div>
      <div data-testid="engine">{browserEngine}</div>
    </>
  );
}

describe('InferenceModeContext hidden mode (WEBLLM_VISIBLE = false, #265 A3-ii)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it("a persisted browserEngine 'webllm' loads as 'wllama' through the real provider's loadStoredState path", () => {
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({ mode: 'browser-local', browserEngine: 'webllm', ragPreset: 'balanced' }),
    );

    render(
      <InferenceModeProvider>
        <EngineProbe />
      </InferenceModeProvider>,
    );

    expect(screen.getByTestId('mode').textContent).toBe('browser-local');
    expect(screen.getByTestId('engine').textContent).toBe('wllama');
  });

  it("a persisted browserEngine 'wllama' is untouched (hidden mode only normalizes the hidden engine)", () => {
    localStorage.setItem(
      'inference-mode',
      JSON.stringify({ mode: 'browser-local', browserEngine: 'wllama', ragPreset: 'balanced' }),
    );

    render(
      <InferenceModeProvider>
        <EngineProbe />
      </InferenceModeProvider>,
    );

    expect(screen.getByTestId('engine').textContent).toBe('wllama');
  });
});
