/**
 * Lumen phase 5: the Chat header model chip, rendered in the REAL ChatPage.
 * The chip must describe the generator the send path routes to (same inputs
 * as runGeneration) and deep-link to Settings > model connection.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('../../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));
vi.mock('../../lib/theme', () => ({
  useTheme: vi.fn(),
}));
vi.mock('../../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn(),
}));
vi.mock('../../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn(),
  disposeBrowserEngine: vi.fn(),
}));
vi.mock('../../lib/llm/web-llm-service', () => ({
  WEBLLM_DEFAULT_MODEL_ID: 'test-webllm-model',
}));
vi.mock('../../lib/llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn(() => Promise.resolve()),
  getReadinessResultSnapshot: vi.fn(() => null),
  resetReadinessCache: vi.fn(),
}));
vi.mock('../../lib/models/model-manifest', () => ({
  LLM_MODEL_DIR: 'gemma-4-e2b-it',
}));
vi.mock('../../lib/desktop-session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/desktop-session')>();
  return {
    isElectron: vi.fn(() => false),
    initDesktopSession: vi.fn(() => Promise.reject(new Error('no desktop in tests'))),
    useDesktopSession: vi.fn(() => ({ session: null, models: null, loading: false, error: null })),
    fetchModelStatus: vi.fn(() => Promise.reject(new Error('no desktop in tests'))),
    modelsAbsentForRealEngine: real.modelsAbsentForRealEngine,
  };
});

import { ChatPage } from '../ChatPage';
import * as inferenceModule from '../../lib/inference';
import * as themeModule from '../../lib/theme';
import * as desktopSessionModule from '../../lib/desktop-session';
import { MODEL_CONNECTION_SECTION_ID } from '../../lib/settings-sections';

function mockContext(mode: 'browser-local' | 'api', browserEngine: 'wllama' | 'webllm' = 'wllama'): void {
  vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
    mode,
    browserEngine,
    ragPreset: 'balanced',
    isServerConnected: true,
    isModelReady: true,
    modelLoadingProgress: 0,
    modeError: null,
    serverUrl: '',
    setMode: vi.fn(),
    setBrowserEngine: vi.fn(),
    setRagPreset: vi.fn(),
    checkServerConnectivity: vi.fn(() => Promise.resolve(true)),
    setModelReady: vi.fn(),
    setModelLoadingProgress: vi.fn(),
  } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
  vi.mocked(themeModule.useTheme).mockReturnValue({
    theme: 'light',
    themePreference: 'system',
    setTheme: vi.fn(),
    isDark: false,
  } as unknown as ReturnType<typeof themeModule.useTheme>);
}

function renderChat(onOpenSettings = vi.fn()) {
  render(
    <ChatPage
      messages={[]}
      onMessagesChange={vi.fn()}
      onSaveConversation={vi.fn()}
      currentConversationId={undefined}
      setCurrentConversationId={vi.fn()}
      onNewChat={vi.fn()}
      onOpenSettings={onOpenSettings}
    />
  );
  return onOpenSettings;
}

describe('ChatPage header model chip', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.mocked(desktopSessionModule.isElectron).mockReturnValue(false);
    vi.mocked(desktopSessionModule.useDesktopSession).mockReturnValue({
      session: null,
      models: null,
      loading: false,
      error: null,
    });
  });

  test('browser app, local wllama: names the packaged model and deep-links to model settings', () => {
    mockContext('browser-local');
    const onOpenSettings = renderChat();
    const chip = screen.getByTestId('chat-model-chip');
    expect(chip).toHaveTextContent('Local · Google Gemma 4 E2B-it');
    fireEvent.click(chip);
    expect(onOpenSettings).toHaveBeenCalledWith(MODEL_CONNECTION_SECTION_ID);
  });

  test('browser app, local WebLLM: the model id the load path uses', () => {
    mockContext('browser-local', 'webllm');
    renderChat();
    expect(screen.getByTestId('chat-model-chip')).toHaveTextContent('Local · test-webllm-model');
  });

  test('browser app, active external endpoint: hostname and model, never the URL path or key', () => {
    localStorage.setItem(
      'external-provider-config',
      JSON.stringify({
        enabled: true,
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'local-model',
        grounded: true,
        rememberKey: false,
      })
    );
    mockContext('browser-local');
    renderChat();
    const chip = screen.getByTestId('chat-model-chip');
    expect(chip).toHaveAttribute('data-kind', 'external');
    expect(chip).toHaveTextContent('127.0.0.1 · local-model');
    expect(chip.textContent).not.toContain('/v1');
  });

  test('desktop app, backend on an external engine: the mode only, even with a stale browser config stored', () => {
    localStorage.setItem(
      'external-provider-config',
      JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: 'http://127.0.0.1:1234', model: 'stale', grounded: true })
    );
    vi.mocked(desktopSessionModule.isElectron).mockReturnValue(true);
    vi.mocked(desktopSessionModule.useDesktopSession).mockReturnValue({
      session: {
        baseUrl: 'http://127.0.0.1:4567',
        token: 't',
        mode: 'node',
        apiClient: {} as never,
        sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
      },
      models: {
        engine: 'external',
        profile: 'quality',
        models: { quality: { present: false }, fast: { present: false } },
      },
      loading: false,
      error: null,
    });
    mockContext('browser-local');
    renderChat();
    const chip = screen.getByTestId('chat-model-chip');
    expect(chip).toHaveAttribute('data-kind', 'desktop-external');
    expect(chip).toHaveTextContent(/^External model$/);
  });
});
