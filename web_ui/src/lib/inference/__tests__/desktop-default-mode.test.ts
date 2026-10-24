/**
 * desktop-default-mode.test.ts — issue #247 R1 (collated trace
 * .agents/issue-traces/collated-246-247, approved plan rev 5, AC10).
 *
 * AC10: inside Electron the inference-mode DEFAULT is the desktop backend
 * ('api'); the browser app keeps 'browser-local'. Pinned for BOTH the
 * no-stored-blob path and the loadStoredState() catch fall-through (an
 * unreadable/corrupt blob), with isElectron() stubbed BOTH ways. The
 * allow-list and legacy-migration behavior is unchanged (already covered by
 * InferenceModeContext.test.tsx / .migration.test.tsx / desktop-seed.test.ts).
 *
 * isElectron is imported by InferenceModeContext.tsx from '../desktop-session'
 * (web_ui/src/lib/desktop-session.tsx); the mock below targets that module so
 * both the context's reads and the migration short-circuit see the stub.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const electron = vi.hoisted(() => ({ on: false }));

vi.mock('../../desktop-session', () => ({
  isElectron: () => electron.on,
  initDesktopSession: vi.fn(async () => ({ token: 'stub-token' }) as never),
  useDesktopSession: vi.fn(() => ({ session: null, models: null, loading: false, error: null })),
  resetDesktopSession: vi.fn(),
  DesktopSessionError: class extends Error {},
}));

vi.mock('../../llm/llm-factory', () => ({
  disposeBrowserEngine: vi.fn(),
  getLLMService: vi.fn(),
  DEFAULT_BROWSER_ENGINE: 'wllama',
}));

const mockFetch = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response);

import { InferenceModeProvider, useInferenceMode } from '../InferenceModeContext';
import { INFERENCE_MODE_KEY } from '../../storage/persisted-keys';

function ModeProbe(): React.ReactElement {
  const { mode } = useInferenceMode();
  return React.createElement('div', { 'data-testid': 'mode' }, mode);
}

function renderMode(): string | null {
  render(React.createElement(InferenceModeProvider, null, React.createElement(ModeProbe)));
  return screen.getByTestId('mode').textContent;
}

beforeEach(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('desktop-default-mode: Electron (isElectron() true)', () => {
  beforeEach(() => {
    electron.on = true;
  });

  test('no stored blob defaults to the desktop backend (api)', () => {
    expect(renderMode()).toBe('api');
  });

  test('a corrupt stored blob (catch fall-through) still defaults to api', () => {
    localStorage.setItem(INFERENCE_MODE_KEY, '{ not json');
    expect(renderMode()).toBe('api');
  });

  test('an unreadable localStorage (getItem throws) still defaults to api', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('quota / private mode');
    });
    try {
      expect(renderMode()).toBe('api');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('desktop-default-mode: browser app (isElectron() false)', () => {
  beforeEach(() => {
    electron.on = false;
  });

  test('no stored blob keeps browser-local as the default', () => {
    expect(renderMode()).toBe('browser-local');
  });

  test('a corrupt stored blob (catch fall-through) keeps browser-local', () => {
    localStorage.setItem(INFERENCE_MODE_KEY, '{ not json');
    expect(renderMode()).toBe('browser-local');
  });

  test('an unreadable localStorage (getItem throws) keeps browser-local', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('quota / private mode');
    });
    try {
      expect(renderMode()).toBe('browser-local');
    } finally {
      spy.mockRestore();
    }
  });
});
