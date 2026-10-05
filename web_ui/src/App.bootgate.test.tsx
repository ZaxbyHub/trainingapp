/**
 * Lumen phase 7: the blocking boot state (LoadingOverlay / DesktopBootGate) is
 * built from ui/Dialog + ui/ProgressBar + ui/Banner + ui/Button. While connecting
 * it is a non-dismissible dialog with an indeterminate progress bar; a boot
 * failure shows a danger Banner (role="alert") and a Retry that really re-runs
 * the boot (initDesktopSession clears its memo on failure), then mounts the app.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('./lib/llm/llm-factory', () => ({
  getLLMService: () => ({}),
  disposeBrowserEngine: () => undefined,
  getPreferredBrowserEngine: () => 'wllama',
}));
vi.mock('./lib/rag/rag-orchestrator', () => ({ RAGOrchestrator: vi.fn() }));
vi.mock('./hooks/useServiceInitialization', () => ({
  useServiceInitialization: () => ({ isInitialized: true, initError: null, currentStep: 'Ready', servicesReady: {} }),
}));
vi.mock('./db/conversations', () => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(async () => undefined),
  createConversation: vi.fn(async () => undefined),
  updateConversation: vi.fn(async () => undefined),
  deleteConversation: vi.fn(async () => undefined),
  countConversations: vi.fn(async () => 0),
}));
vi.mock('./components/StreamingIndicator', () => ({ StreamingIndicator: () => null }));
vi.mock('./components/InferenceModeToggle', () => ({ InferenceModeToggle: () => null }));
vi.mock('./lib/streaming', () => ({ TokenStreamManager: vi.fn() }));
vi.mock('./pages/DocumentsPage', () => ({ DocumentsPage: () => null }));
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: () => null }));
vi.mock('./lib/inference/desktop-seed', () => ({ seedInferenceModeForDesktop: vi.fn() }));
vi.mock('./lib/llm/external-migration', () => ({ migrateLegacyProviderToDesktop: vi.fn(async () => false) }));

import { DesktopBootGate, LoadingOverlay } from './App';
import { resetDesktopSessionForTests } from './lib/desktop-session';

beforeEach(() => {
  resetDesktopSessionForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ engine: 'stub', profile: 'auto', models: {} }), { status: 200 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { desktopApi?: unknown }).desktopApi;
  resetDesktopSessionForTests();
});

describe('LoadingOverlay', () => {
  it('connecting: a non-dismissible dialog named by the step with an indeterminate progress bar and no inline style', () => {
    const onKey = vi.fn();
    const { container } = render(
      <div onKeyDown={onKey}>
        <LoadingOverlay currentStep="Connecting to the desktop backend..." initError={null} />
      </div>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Connecting to the desktop backend...' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/--color-/);
    // The ProgressBar's own width style is the only inline style allowed (determinate only).
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    expect(fireEvent.keyDown(dialog, { key: 'Escape' })).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Connecting/ })).toBeInTheDocument();
  });

  it('failure: a danger Banner with role=alert; Retry appears only when onRetry is provided', () => {
    const { rerender } = render(<LoadingOverlay currentStep="Desktop backend unavailable" initError="bridge down" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('ui-banner--danger');
    expect(alert).toHaveTextContent('bridge down');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    const onRetry = vi.fn();
    rerender(<LoadingOverlay currentStep="Desktop backend unavailable" initError="bridge down" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('DesktopBootGate Retry', () => {
  it('a failed boot offers Retry; Retry re-runs the boot and mounts the app when it succeeds', async () => {
    const getBackendInfo = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc not ready'))
      .mockResolvedValue({ url: 'http://127.0.0.1:4567', mode: 'node' });
    const getAuthToken = vi.fn(async () => 'tok');
    (window as unknown as { desktopApi: unknown }).desktopApi = { getBackendInfo, getAuthToken };

    render(
      <DesktopBootGate>
        <div data-testid="app-mounted">app</div>
      </DesktopBootGate>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/ipc not ready/);
    expect(screen.queryByTestId('app-mounted')).toBeNull();
    expect(getBackendInfo).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(await screen.findByTestId('app-mounted')).toBeInTheDocument();
    expect(getBackendInfo).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a repeat failure after Retry shows the error again (and re-runs the boot each time)', async () => {
    const getBackendInfo = vi.fn().mockRejectedValue(new Error('still down'));
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      getBackendInfo,
      getAuthToken: vi.fn(async () => 'tok'),
    };
    render(
      <DesktopBootGate>
        <div data-testid="app-mounted" />
      </DesktopBootGate>,
    );
    await screen.findByRole('alert');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/still down/);
    expect(getBackendInfo).toHaveBeenCalledTimes(2);
  });
});
