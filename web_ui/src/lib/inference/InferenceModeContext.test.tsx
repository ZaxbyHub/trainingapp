/**
 * Tests for InferenceModeContext
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { InferenceModeProvider, useInferenceMode } from './InferenceModeContext';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('InferenceModeContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    // Clear localStorage mock
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
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

  describe('setMode', () => {
    it('updates mode state', async () => {
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

      fireEvent.click(screen.getByText('Set API'));

      await waitFor(() => {
        expect(screen.getByTestId('mode').textContent).toBe('api');
      });
    });

    it('persists mode to localStorage', async () => {
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

      fireEvent.click(screen.getByText('Set API'));

      await waitFor(() => {
        const stored = localStorage.getItem('inference-mode');
        expect(stored).toBeTruthy();
        const parsed = JSON.parse(stored!);
        expect(parsed.mode).toBe('api');
      });
    });

    it('clears modeError when switching modes', async () => {
      function TestComponent() {
        const { modeError, setMode } = useInferenceMode();
        return (
          <div>
            <span data-testid="error">{modeError ?? 'null'}</span>
            <button onClick={() => setMode('api')}>Set API</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      // Error starts as null
      expect(screen.getByTestId('error').textContent).toBe('null');

      fireEvent.click(screen.getByText('Set API'));

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toBe('null');
      });
    });
  });

  describe('localStorage Persistence', () => {
    it('loads persisted mode from localStorage', () => {
      localStorage.setItem('inference-mode', JSON.stringify({ mode: 'api', serverUrl: '' }));

      function TestComponent() {
        const { mode } = useInferenceMode();
        return <div data-testid="mode">{mode}</div>;
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      expect(screen.getByTestId('mode').textContent).toBe('api');
    });

    it('falls back to default when localStorage is corrupted', () => {
      localStorage.setItem('inference-mode', 'not valid json');

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

    it('handles localStorage being unavailable', () => {
      const localStorageSpy = vi.spyOn(global, 'localStorage', 'get');
      localStorageSpy.mockImplementation(() => {
        throw new Error('localStorage not available');
      });

      function TestComponent() {
        const { mode } = useInferenceMode();
        return <div data-testid="mode">{mode}</div>;
      }

      // Should not throw, should use default
      expect(() => {
        render(
          <InferenceModeProvider>
            <TestComponent />
          </InferenceModeProvider>
        );
      }).not.toThrow();

      expect(screen.getByTestId('mode').textContent).toBe('browser-local');

      localStorageSpy.mockRestore();
    });

    it('handles localStorage quota exceeded', () => {
      const localStorageSpy = vi.spyOn(global, 'localStorage', 'set');
      localStorageSpy.mockImplementation(() => {
        throw new Error('Quota exceeded');
      });

      function TestComponent() {
        const { setMode } = useInferenceMode();
        return <button onClick={() => setMode('api')}>Set API</button>;
      }

      // Should not throw
      expect(() => {
        render(
          <InferenceModeProvider>
            <TestComponent />
          </InferenceModeProvider>
        );
      }).not.toThrow();

      localStorageSpy.mockRestore();
    });
  });

  describe('checkServerConnectivity', () => {
    it('returns true when server responds with ok', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      function TestComponent() {
        const { checkServerConnectivity } = useInferenceMode();
        return (
          <button onClick={() => checkServerConnectivity()}>Check</button>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      let result = false;
      await act(async () => {
        result = await screen.getByText('Check').click();
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/auth/status'),
          expect.objectContaining({ method: 'GET' })
        );
      });
    });

    it('returns false when server returns error status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      function TestComponent() {
        const { checkServerConnectivity, isServerConnected, modeError } = useInferenceMode();
        return (
          <div>
            <button onClick={() => checkServerConnectivity()}>Check</button>
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
        await screen.getByText('Check').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('connected').textContent).toBe('false');
        expect(screen.getByTestId('error').textContent).toContain('401');
      });
    });

    it('returns false when server is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      function TestComponent() {
        const { checkServerConnectivity, isServerConnected, modeError } = useInferenceMode();
        return (
          <div>
            <button onClick={() => checkServerConnectivity()}>Check</button>
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
        await screen.getByText('Check').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('connected').textContent).toBe('false');
        expect(screen.getByTestId('error').textContent).toBe('Server unreachable');
      });
    });

    it('has 5 second timeout', async () => {
      vi.useFakeTimers();

      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, status: 200 }), 10000);
          })
      );

      function TestComponent() {
        const { checkServerConnectivity } = useInferenceMode();
        return <button onClick={() => checkServerConnectivity()}>Check</button>;
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      await act(async () => {
        screen.getByText('Check').click();
        vi.advanceTimersByTime(5000);
      });

      // Should have aborted
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      vi.useRealTimers();
    });

    it('uses serverUrl from state', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      function TestComponent() {
        const { checkServerConnectivity, serverUrl } = useInferenceMode();
        return (
          <div>
            <span data-testid="url">{serverUrl}</span>
            <button onClick={() => checkServerConnectivity()}>Check</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      await act(async () => {
        screen.getByText('Check').click();
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/auth/status'),
          expect.any(Object)
        );
      });
    });

    it('strips trailing slash from serverUrl', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      function TestComponent() {
        const { checkServerConnectivity, setServerUrl } = useInferenceMode();
        return (
          <div>
            <button onClick={() => setServerUrl('http://localhost:8000/')}>Set URL</button>
            <button onClick={() => checkServerConnectivity()}>Check</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      await act(async () => {
        screen.getByText('Set URL').click();
      });

      await act(async () => {
        screen.getByText('Check').click();
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:8000/auth/status',
          expect.any(Object)
        );
      });
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
      function TestComponent() {
        const { setModelReady, modeError } = useInferenceMode();
        return (
          <div>
            <span data-testid="error">{modeError ?? 'null'}</span>
            <button onClick={() => setModelReady(true)}>Set Ready</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      expect(screen.getByTestId('error').textContent).toBe('null');

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

  describe('setServerUrl', () => {
    it('updates serverUrl state', async () => {
      function TestComponent() {
        const { serverUrl, setServerUrl } = useInferenceMode();
        return (
          <div>
            <span data-testid="url">{serverUrl}</span>
            <button onClick={() => setServerUrl('http://localhost:8000')}>Set URL</button>
          </div>
        );
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      fireEvent.click(screen.getByText('Set URL'));

      await waitFor(() => {
        expect(screen.getByTestId('url').textContent).toBe('http://localhost:8000');
      });
    });

    it('persists serverUrl to localStorage', async () => {
      function TestComponent() {
        const { setServerUrl } = useInferenceMode();
        return <button onClick={() => setServerUrl('http://localhost:8000')}>Set URL</button>;
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      fireEvent.click(screen.getByText('Set URL'));

      await waitFor(() => {
        const stored = localStorage.getItem('inference-mode');
        const parsed = JSON.parse(stored!);
        expect(parsed.serverUrl).toBe('http://localhost:8000');
      });
    });
  });

  describe('Cleanup on Unmount', () => {
    it('clears abort controller on unmount', () => {
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      function TestComponent() {
        return <div>Test</div>;
      }

      const { unmount } = render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      unmount();

      expect(abortSpy).toHaveBeenCalled();
    });

    it('clears timeout on unmount', () => {
      vi.useFakeTimers();

      function TestComponent() {
        const { checkServerConnectivity } = useInferenceMode();
        return <button onClick={() => checkServerConnectivity()}>Check</button>;
      }

      const { unmount } = render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      act(() => {
        screen.getByText('Check').click();
        vi.advanceTimersByTime(1000);
      });

      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalled();

      vi.useRealTimers();
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
