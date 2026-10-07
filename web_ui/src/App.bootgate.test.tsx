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
import { DESKTOP_BRIDGE_TIMEOUT_MS, resetDesktopSessionForTests } from './lib/desktop-session';
import { seedInferenceModeForDesktop } from './lib/inference/desktop-seed';

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
    const dialog = screen.getByRole('dialog', { name: 'Starting TrainingApp' });
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to the desktop backend...');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/--color-/);
    // The ProgressBar's own width style is the only inline style allowed (determinate only).
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    expect(fireEvent.keyDown(dialog, { key: 'Escape' })).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Starting TrainingApp' })).toBeInTheDocument();
  });

  it('boot step changes are announced: the step text sits in a role=status that updates in place', () => {
    const { rerender } = render(<LoadingOverlay currentStep="Loading embeddings" initError={null} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading embeddings');
    rerender(<LoadingOverlay currentStep="Building the index" initError={null} />);
    expect(screen.getByRole('status')).toBe(status); // same live region, new text
    expect(status).toHaveTextContent('Building the index');
  });

  it('PRR-151-035: the boot surface title is the document h1 (loading and failure)', () => {
    const { rerender } = render(<LoadingOverlay currentStep="Connecting..." initError={null} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Starting TrainingApp' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    rerender(<LoadingOverlay currentStep="Desktop backend unavailable" initError="down" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Desktop backend unavailable' })).toBeInTheDocument();
  });

  it('PRR-151-041: the status region exists (empty) before its first text lands, so the first step is a content change', () => {
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    render(<LoadingOverlay currentStep="Connecting to the desktop backend..." initError={null} />);
    const status = screen.getByRole('status');
    const records = observer.takeRecords();
    observer.disconnect();
    // A text node was added INTO the already-inserted status element (not inserted along with it).
    expect(records.some((r) => r.target === status && Array.from(r.addedNodes).some((n) => n.nodeType === Node.TEXT_NODE))).toBe(true);
    expect(status).toHaveTextContent('Connecting to the desktop backend...');
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
  it('PRR-151-016: after Retry the focus is inside the loading dialog, not dropped to body', async () => {
    const getBackendInfo = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc not ready'))
      .mockReturnValue(new Promise(() => undefined));
    (window as unknown as { desktopApi: unknown }).desktopApi = { getBackendInfo, getAuthToken: vi.fn(async () => 'tok') };
    render(<DesktopBootGate><div /></DesktopBootGate>);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    await act(async () => {
      fireEvent.click(retry);
    });
    const dialog = screen.getByRole('dialog', { name: 'Starting TrainingApp' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('PRR-151-016: a wedged getBackendInfo becomes an error with Retry after the timeout, and Retry re-asks', async () => {
    vi.useFakeTimers();
    try {
      const getBackendInfo = vi.fn().mockReturnValue(new Promise(() => undefined));
      (window as unknown as { desktopApi: unknown }).desktopApi = { getBackendInfo, getAuthToken: vi.fn(async () => 'tok') };
      render(<DesktopBootGate><div /></DesktopBootGate>);
      expect(screen.queryByRole('alert')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DESKTOP_BRIDGE_TIMEOUT_MS + 1);
      });
      expect(screen.getByRole('alert')).toHaveTextContent(/Timed out/);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      });
      // The memo was cleared on timeout: Retry is a real second call, not the wedged promise.
      expect(getBackendInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('PRR-151-010: a throw AFTER discovery resolved (seed) still leaves Retry a real re-run', async () => {
    const getBackendInfo = vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:4567', mode: 'node' });
    (window as unknown as { desktopApi: unknown }).desktopApi = { getBackendInfo, getAuthToken: vi.fn(async () => 'tok') };
    vi.mocked(seedInferenceModeForDesktop).mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    render(<DesktopBootGate><div data-testid="app-mounted" /></DesktopBootGate>);
    expect(await screen.findByRole('alert')).toHaveTextContent(/QuotaExceededError/);
    expect(getBackendInfo).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(await screen.findByTestId('app-mounted')).toBeInTheDocument();
    expect(getBackendInfo).toHaveBeenCalledTimes(2);
  });

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
