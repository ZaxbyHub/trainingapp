/**
 * settings-wiring-honesty (AC10): App's section-aware openSettings seam.
 *
 * ChatPage hands `onOpenSettings` to the model-blocked overlay, whose
 * "Use a local server or cloud model" action calls it with the
 * 'model-connection' section id, while the existing "Open Settings" button
 * (and any direct onClick binding) passes no section — or a click event. App
 * must forward ONLY a string section to SettingsPage, and sidebar navigation
 * must never carry a stale section. ChatPage and SettingsPage are stubbed so
 * this pins exactly what App passes through; the SettingsPage focus behavior
 * itself is pinned in pages/__tests__/settings-wiring-honesty.test.tsx.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';

vi.mock('./db/conversations', () => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(async () => undefined),
  createConversation: vi.fn(async () => undefined),
  updateConversation: vi.fn(async () => undefined),
  deleteConversation: vi.fn(async () => undefined),
  countConversations: vi.fn(async () => 0),
}));

vi.mock('./hooks/useServiceInitialization', () => ({
  useServiceInitialization: () => ({
    isInitialized: true,
    initError: null,
    currentStep: 'Ready',
    servicesReady: {
      embeddings: true,
      vectorIndex: true,
      keywordIndex: true,
      modelCached: true,
      webgpuAvailable: false,
    },
  }),
}));

vi.mock('./lib/inference/InferenceModeContext', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => ({
    mode: 'browser-local',
    browserEngine: 'wllama',
    ragPreset: 'balanced',
    isModelReady: false,
    isServerConnected: false,
    modelLoadingProgress: 0,
    serverUrl: '',
    setModelLoadingProgress: vi.fn(),
    setMode: vi.fn(),
    setBrowserEngine: vi.fn(),
    setRagPreset: vi.fn(),
    checkServerConnectivity: vi.fn(),
    setModelReady: vi.fn(),
    modeError: null,
  }),
}));

vi.mock('./pages/ChatPage', () => ({
  ChatPage: ({ onOpenSettings }: { onOpenSettings: (section?: unknown) => void }) => (
    <div data-testid="chat-page-stub">
      <button type="button" onClick={() => onOpenSettings('model-connection')}>
        stub: external model action
      </button>
      <button type="button" onClick={() => onOpenSettings()}>
        stub: open settings
      </button>
      {/* A handler bound directly as onClick receives the click event. */}
      <button type="button" onClick={onOpenSettings as unknown as React.MouseEventHandler}>
        stub: open settings via event
      </button>
    </div>
  ),
}));

vi.mock('./pages/DocumentsPage', () => ({
  DocumentsPage: () => <div data-testid="documents-page-marker">Documents Page</div>,
}));

vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: ({ initialSection }: { initialSection?: string }) => (
    <div data-testid="settings-page-stub" data-section={initialSection ?? 'none'}>
      Settings Page
    </div>
  ),
}));

afterEach(() => cleanup());

async function openFromChat(buttonName: string): Promise<string | null> {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return (await screen.findByTestId('settings-page-stub')).getAttribute('data-section');
}

describe('App openSettings(section) seam (settings-wiring-honesty AC10)', () => {
  it('the overlay external-model action opens Settings at the model-connection section', async () => {
    expect(await openFromChat('stub: external model action')).toBe('model-connection');
  });

  it('Open Settings without a section opens Settings at the top', async () => {
    expect(await openFromChat('stub: open settings')).toBe('none');
  });

  it('a click event passed as the argument is not mistaken for a section', async () => {
    expect(await openFromChat('stub: open settings via event')).toBe('none');
  });

  it('sidebar navigation to Settings drops a previously requested section', async () => {
    expect(await openFromChat('stub: external model action')).toBe('model-connection');
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect((await screen.findByTestId('settings-page-stub')).getAttribute('data-section')).toBe('none');
  });
});
