/**
 * Tests for InferenceModeContext (issue #348: quarantine discharge).
 *
 * Current contract (settings-wiring-honesty AC4 / #265): 'api' is the desktop
 * app's built-in backend ONLY. Outside Electron `setMode('api')` is a no-op,
 * and a legacy stored `{mode:'api',serverUrl}` blob is migrated once to
 * browser-local with `serverUrl` deleted. The connectivity probe uses
 * `state.serverUrl` (absolute URL inside Electron plus the per-launch
 * `X-Desktop-Token` header), arms a 5 s AbortController timeout, and a second
 * check aborts the previous in-flight request.
 *
 * Migration edge cases (corrupt blob, non-object JSON, storage disabled,
 * migration-write quota) are pinned green in
 * InferenceModeContext.migration.test.tsx; this file pins the live context
 * behavior on top of the REAL provider.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { InferenceModeProvider, useInferenceMode } from './InferenceModeContext';
import { installDesktopBridgeStub, removeDesktopBridgeStub } from '../../test/desktop-bridge-stub';
import { resetDesktopSessionForTests } from '../desktop-session';

const fetchMock = vi.fn();

/** Mirrors real fetch abort semantics: rejects with an AbortError when the
 * request's signal aborts, so the 5 s timeout path actually resolves. */
function fetchPendingUntilAbort(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

const okStatusResponse = () => ({ ok: true, status: 200, json: async () => ({ enabled: false }) });

describe('InferenceModeContext', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    removeDesktopBridgeStub();
    resetDesktopSessionForTests();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Initial State', () => {
    it('has default mode as browser-local', () => {
      function TestComponent() {
        const { mode } = useInferenceMode();
        return <div data-testid="mode">{mode}</div>;
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      expect(screen.getByTestId('mode').textContent).toBe('browser-local');
    });

    it('has isModelReady as false initially', () => {
      function TestComponent() {
        const { isModelReady } = useInferenceMode();
        return <div data-testid="ready">{String(isModelReady)}</div>;
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      expect(screen.getByTestId('ready').textContent).toBe('false');
    });

    it('has isServerConnected as false initially', () => {
      function TestComponent() {
        const { isServerConnected } = useInferenceMode();
        return <div data-testid="connected">{String(isServerConnected)}</div>;
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      expect(screen.getByTestId('connected').textContent).toBe('false');
    });

    it('has modelLoadingProgress as 0 initially', () => {
      function TestComponent() {
        const { modelLoadingProgress } = useInferenceMode();
        return <div data-testid="progress">{modelLoadingProgress}</div>;
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      expect(screen.getByTestId('progress').textContent).toBe('0');
    });

    it('has modeError as null initially', () => {
      function TestComponent() {
        const { modeError } = useInferenceMode();
        return <div data-testid="error">{modeError ?? 'null'}</div>;
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      expect(screen.getByTestId('error').textContent).toBe('null');
    });
  });

  describe('setMode (browser app: no API-server mode)', () => {
    it('setMode("api") is a no-op outside Electron: mode stays browser-local and nothing is persisted', () => {
      function TestComponent() {
        const { mode, setMode } = useInferenceMode();
        return (
          <div>
            <span data-testid="mode">{mode}</span>
            <button onClick={() => setMode('api')}>Set API</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      act(() => {
        fireEvent.click(screen.getByText('Set API'));
      });

      // The early return (InferenceModeContext.tsx setMode) keeps the current
      // mode AND skips the persist entirely.
      expect(screen.getByTestId('mode').textContent).toBe('browser-local');
      expect(localStorage.getItem('inference-mode')).toBeNull();
    });

    it('a legacy stored {mode:"api",serverUrl} blob boots as browser-local with serverUrl removed', () => {
      localStorage.setItem(
        'inference-mode',
        JSON.stringify({ mode: 'api', serverUrl: 'http://127.0.0.1:8000' })
      );

      function TestComponent() {
        const { mode, serverUrl } = useInferenceMode();
        return (
          <div>
            <span data-testid="mode">{mode}</span>
            <span data-testid="url">{serverUrl}</span>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      expect(screen.getByTestId('mode').textContent).toBe('browser-local');
      expect(screen.getByTestId('url').textContent).toBe('');
      const stored = JSON.parse(localStorage.getItem('inference-mode')!);
      expect(stored.mode).toBe('browser-local');
      expect(stored).not.toHaveProperty('serverUrl');
    });

    it('clears modeError when switching modes', async () => {
      // Seed a REAL error first: an unreachable server sets modeError.
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      function TestComponent() {
        const { modeError, setMode, checkServerConnectivity } = useInferenceMode();
        return (
          <div>
            <span data-testid="error">{modeError ?? 'null'}</span>
            <button onClick={() => void checkServerConnectivity()}>Check</button>
            <button onClick={() => setMode('browser-local')}>Set Local</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toBe('Server unreachable');
      });

      // A mode switch clears the error (setMode resets modeError to null).
      act(() => {
        fireEvent.click(screen.getByText('Set Local'));
      });

      expect(screen.getByTestId('error').textContent).toBe('null');
    });
  });

  describe('checkServerConnectivity', () => {
    it('marks the server connected when /auth/status responds ok', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(okStatusResponse()));

      function TestComponent() {
        const { checkServerConnectivity, isServerConnected, modeError } = useInferenceMode();
        return (
          <div>
            <button onClick={() => void checkServerConnectivity()}>Check</button>
            <span data-testid="connected">{String(isServerConnected)}</span>
            <span data-testid="error">{modeError ?? 'null'}</span>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      // Browser app: no stored serverUrl, so the probe is the relative endpoint.
      expect(fetchMock).toHaveBeenCalledWith(
        '/auth/status',
        expect.objectContaining({ method: 'GET', credentials: 'include' })
      );
      await waitFor(() => {
        expect(screen.getByTestId('connected').textContent).toBe('true');
        expect(screen.getByTestId('error').textContent).toBe('null');
      });
    });

    it('reports Server returned <status> for an error status', async () => {
      fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 401 }));

      function TestComponent() {
        const { checkServerConnectivity, isServerConnected, modeError } = useInferenceMode();
        return (
          <div>
            <button onClick={() => void checkServerConnectivity()}>Check</button>
            <span data-testid="connected">{String(isServerConnected)}</span>
            <span data-testid="error">{modeError ?? 'null'}</span>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('connected').textContent).toBe('false');
        expect(screen.getByTestId('error').textContent).toBe('Server returned 401');
      });
    });

    it('reports Server unreachable when the request rejects', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      function TestComponent() {
        const { checkServerConnectivity, isServerConnected, modeError } = useInferenceMode();
        return (
          <div>
            <button onClick={() => void checkServerConnectivity()}>Check</button>
            <span data-testid="connected">{String(isServerConnected)}</span>
            <span data-testid="error">{modeError ?? 'null'}</span>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('connected').textContent).toBe('false');
        expect(screen.getByTestId('error').textContent).toBe('Server unreachable');
      });
    });

    it('aborts the probe and reports Server unreachable after 5 seconds', async () => {
      vi.useFakeTimers();
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      try {
        // The request never settles on its own; only the abort can end it.
        fetchMock.mockImplementation(fetchPendingUntilAbort);

        function TestComponent() {
          const { checkServerConnectivity, isServerConnected, modeError } = useInferenceMode();
          return (
            <div>
              <button onClick={() => void checkServerConnectivity()}>Check</button>
              <span data-testid="connected">{String(isServerConnected)}</span>
              <span data-testid="error">{modeError ?? 'null'}</span>
            </div>
          );
        }

        render(
          <InferenceModeProvider>
            <TestComponent />
          </InferenceModeProvider>
        );

        await act(async () => {
          fireEvent.click(screen.getByText('Check'));
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(4000);
        });
        // Still pending at 4 s: no abort, no state change.
        expect(abortSpy).not.toHaveBeenCalled();
        expect(screen.getByTestId('error').textContent).toBe('null');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });

        // The 5 s timeout aborted the in-flight request and the catch path
        // reported it (never just "fetch was called").
        expect(abortSpy).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('connected').textContent).toBe('false');
        expect(screen.getByTestId('error').textContent).toBe('Server unreachable');
      } finally {
        abortSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('a superseded check neither disarms the replacement watchdog nor clobbers its state', async () => {
      // Regression (found while reworking this spec, fixed in this PR): a second
      // checkServerConnectivity aborts the first in flight. The first request's
      // catch block used to clear `timeoutIdRef` — which by then holds the
      // SECOND request's 5 s watchdog — and to write `Server unreachable` while
      // the replacement was still running.
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        });
      });

      function TestComponent() {
        const { checkServerConnectivity, modeError } = useInferenceMode();
        return (
          <div>
            <button onClick={() => void checkServerConnectivity()}>Check</button>
            <span data-testid="error">{modeError ?? 'null'}</span>
          </div>
        );
      }

      try {
        render(
          <InferenceModeProvider>
            <TestComponent />
          </InferenceModeProvider>
        );

        act(() => {
          fireEvent.click(screen.getByText('Check'));
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        act(() => {
          fireEvent.click(screen.getByText('Check'));
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(signals).toHaveLength(2);
        // The superseded request is aborted...
        expect(signals[0].aborted).toBe(true);
        // ...but its failure must NOT be reported while the replacement runs.
        expect(screen.getByTestId('error').textContent).toBe('null');

        // The replacement's own watchdog is still armed: only after its 5 s
        // budget does it abort and report the failure.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(signals[1].aborted).toBe(true);
        expect(screen.getByTestId('error').textContent).toBe('Server unreachable');
      } finally {
        vi.useRealTimers();
      }
    });

    it('probes the stored serverUrl with X-Desktop-Token inside Electron (desktop leg)', async () => {
      installDesktopBridgeStub();
      localStorage.setItem(
        'inference-mode',
        JSON.stringify({ mode: 'api', serverUrl: 'http://127.0.0.1:9999' })
      );
      fetchMock.mockImplementation(() => Promise.resolve(okStatusResponse()));

      function TestComponent() {
        const { mode, serverUrl, checkServerConnectivity } = useInferenceMode();
        return (
          <div>
            <span data-testid="mode">{mode}</span>
            <span data-testid="url">{serverUrl}</span>
            <button onClick={() => void checkServerConnectivity()}>Check</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      // The desktop default mode is 'api' and the stored serverUrl survives.
      expect(screen.getByTestId('mode').textContent).toBe('api');
      expect(screen.getByTestId('url').textContent).toBe('http://127.0.0.1:9999');

      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      // Exact endpoint: the stored serverUrl makes the probe ABSOLUTE, and the
      // per-launch desktop token rides the request (issue #67 B9).
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:9999/auth/status',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ 'X-Desktop-Token': 'test-token' }),
        })
      );
    });
  });

  describe('setModelReady', () => {
    it('updates isModelReady state', async () => {
      function TestComponent() {
        const { isModelReady, setModelReady } = useInferenceMode();
        return (
          <div>
            <span data-testid="ready">{String(isModelReady)}</span>
            <button onClick={() => setModelReady(true)}>Set Ready</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      fireEvent.click(screen.getByText('Set Ready'));

      await waitFor(() => {
        expect(screen.getByTestId('ready').textContent).toBe('true');
      });
    });

    it('clears modeError when model becomes ready', async () => {
      // Seed a REAL error first, then clear it via setModelReady(true).
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      function TestComponent() {
        const { setModelReady, modeError, checkServerConnectivity } = useInferenceMode();
        return (
          <div>
            <span data-testid="error">{modeError ?? 'null'}</span>
            <button onClick={() => void checkServerConnectivity()}>Check</button>
            <button onClick={() => setModelReady(true)}>Set Ready</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toBe('Server unreachable');
      });

      fireEvent.click(screen.getByText('Set Ready'));

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toBe('null');
      });
    });
  });

  describe('setModelLoadingProgress', () => {
    it('updates modelLoadingProgress state', async () => {
      function TestComponent() {
        const { modelLoadingProgress, setModelLoadingProgress } = useInferenceMode();
        return (
          <div>
            <span data-testid="progress">{modelLoadingProgress}</span>
            <button onClick={() => setModelLoadingProgress(50)}>Set 50%</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      fireEvent.click(screen.getByText('Set 50%'));

      await waitFor(() => {
        expect(screen.getByTestId('progress').textContent).toBe('50');
      });
    });

    it('clamps progress to 0-100 range', async () => {
      function TestComponent() {
        const { modelLoadingProgress, setModelLoadingProgress } = useInferenceMode();
        return (
          <div>
            <span data-testid="progress">{modelLoadingProgress}</span>
            <button onClick={() => setModelLoadingProgress(150)}>Set 150%</button>
            <button onClick={() => setModelLoadingProgress(-10)}>Set -10%</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      fireEvent.click(screen.getByText('Set 150%'));
      await waitFor(() => {
        expect(screen.getByTestId('progress').textContent).toBe('100');
      });

      fireEvent.click(screen.getByText('Set -10%'));
      await waitFor(() => {
        expect(screen.getByTestId('progress').textContent).toBe('0');
      });
    });
  });

  describe('Cleanup on Unmount', () => {
    it('aborts an in-flight connectivity check on unmount', () => {
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
      fetchMock.mockImplementation(fetchPendingUntilAbort);

      function TestComponent() {
        const { checkServerConnectivity } = useInferenceMode();
        return <button onClick={() => void checkServerConnectivity()}>Check</button>;
      }

      const { unmount } = render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      act(() => {
        fireEvent.click(screen.getByText('Check'));
      });

      // The check is in flight; nothing has aborted yet.
      expect(abortSpy).not.toHaveBeenCalled();

      unmount();

      // The unmount cleanup aborts the in-flight request (the current code
      // only aborts when a request is actually in flight).
      expect(abortSpy).toHaveBeenCalledTimes(1);

      abortSpy.mockRestore();
    });

    it('clears the pending timeout on unmount', () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(fetchPendingUntilAbort);

      try {
        function TestComponent() {
          const { checkServerConnectivity } = useInferenceMode();
          return <button onClick={() => void checkServerConnectivity()}>Check</button>;
        }

        const { unmount } = render(
          <InferenceModeProvider>
            <TestComponent />
          </InferenceModeProvider>
        );

        act(() => {
          fireEvent.click(screen.getByText('Check'));
          vi.advanceTimersByTime(1000);
        });

        const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
        unmount();

        expect(clearTimeoutSpy).toHaveBeenCalled();

        clearTimeoutSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('useInferenceMode Hook', () => {
    it('throws error when used outside provider', () => {
      function TestComponent() {
        useInferenceMode();
        return <div>Test</div>;
      }

      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<TestComponent />);
      }).toThrow('useInferenceMode must be used within InferenceModeProvider');

      consoleSpy.mockRestore();
    });
  });
});
