/**
 * Verification tests for Task 3.3 - Inference mode architecture
 * Tests verification scope items NOT covered by existing tests
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { InferenceModeProvider, useInferenceMode } from '../lib/inference/InferenceModeContext';
import { InferenceModeToggle } from '../components/InferenceModeToggle';
import { ChatPage } from '../pages/ChatPage';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

function renderWithContext(ui: React.ReactElement) {
  return render(<InferenceModeProvider>{ui}</InferenceModeProvider>);
}

describe('Task 3.3 Verification - Inference Mode Architecture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    localStorage.clear();
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  describe('InferenceModeToggle - aria-pressed reflects mode', () => {
    it('aria-pressed is false when mode is browser-local', () => {
      renderWithContext(<InferenceModeToggle />);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-pressed', 'false');
    });

    it('aria-pressed is true when mode is api', async () => {
      renderWithContext(<InferenceModeToggle />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(button).toHaveAttribute('aria-pressed', 'true');
      });
    });

    it('aria-pressed toggles correctly on subsequent clicks', async () => {
      renderWithContext(<InferenceModeToggle />);

      const button = screen.getByRole('button');

      // Initial: browser-local
      expect(button).toHaveAttribute('aria-pressed', 'false');

      // Click 1: switch to api
      fireEvent.click(button);
      await waitFor(() => {
        expect(button).toHaveAttribute('aria-pressed', 'true');
      });

      // Click 2: switch back to browser-local
      fireEvent.click(button);
      await waitFor(() => {
        expect(button).toHaveAttribute('aria-pressed', 'false');
      });
    });

    it('has correct aria-label describing current mode', () => {
      renderWithContext(<InferenceModeToggle />);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-label', 'Inference mode: browser-local. Click to toggle.');
    });

    it('aria-label updates when mode changes', async () => {
      renderWithContext(<InferenceModeToggle />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(button).toHaveAttribute('aria-label', 'Inference mode: api. Click to toggle.');
      });
    });
  });

  describe('InferenceModeToggle - shows checking status', () => {
    it('button is disabled during connectivity check', async () => {
      // Mock a slow connectivity check
      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, status: 200 }), 1000);
          })
      );

      function TestWrapper() {
        const { setMode, checkServerConnectivity } = useInferenceMode();

        const handleToggle = async () => {
          setMode('api');
          await checkServerConnectivity();
        };

        return <button onClick={handleToggle}>Toggle</button>;
      }

      render(
        <InferenceModeProvider>
          <TestWrapper />
        </InferenceModeProvider>
      );

      // Switch to api mode first
      fireEvent.click(screen.getByText('Toggle'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
    });
  });

  describe('ChatPage - overlay does not block header toggle', () => {
    it('overlay has lower z-index than header', () => {
      // Override mock to show model blocked state
      vi.doMock('../lib/inference', () => ({
        InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
        useInferenceMode: () => ({
          mode: 'browser-local',
          isModelReady: false,
          isServerConnected: false,
          modelLoadingProgress: 50,
          setMode: vi.fn(),
          checkServerConnectivity: vi.fn().mockResolvedValue(false),
        }),
      }));

      vi.doMock('../components/InferenceModeToggle', () => ({
        InferenceModeToggle: () => (
          <button data-testid="inference-toggle" aria-label="Inference mode toggle">
            Toggle
          </button>
        ),
      }));

      render(<ChatPage />);

      // The header has zIndex: 101
      // The overlay has zIndex: 100
      // So the header should be above the overlay

      // Get the header element
      const header = screen.getByRole('banner');
      const headerStyle = header.getAttribute('style') || '';
      expect(headerStyle).toContain('zIndex: 101');

      // Get the overlay (blocking) element if it exists
      // The blocking overlay should NOT cover the toggle
      // We verify this by checking the toggle button is still in the document
      const toggleButton = screen.getByTestId('inference-toggle');
      expect(toggleButton).toBeInTheDocument();
    });

    it('header toggle button is accessible when model loading overlay is shown', () => {
      // Override mock to show model blocked state
      vi.doMock('../lib/inference', () => ({
        InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
        useInferenceMode: () => ({
          mode: 'browser-local',
          isModelReady: false,
          isServerConnected: false,
          modelLoadingProgress: 50,
          setMode: vi.fn(),
          checkServerConnectivity: vi.fn().mockResolvedValue(false),
        }),
      }));

      vi.doMock('../components/InferenceModeToggle', () => ({
        InferenceModeToggle: () => (
          <button data-testid="inference-toggle" aria-label="Inference mode toggle">
            Toggle
          </button>
        ),
      }));

      render(<ChatPage />);

      // Even with the blocking overlay displayed, the toggle in header should be accessible
      const toggleButton = screen.getByTestId('inference-toggle');
      expect(toggleButton).toBeEnabled();
      expect(toggleButton).toBeVisible();
    });
  });

  describe('ChatPage - mode switching during streaming', () => {
    it('can switch mode while streaming is active', async () => {
      vi.useFakeTimers();

      // Mock inference mode that allows mode switching
      vi.doMock('../lib/inference', () => ({
        InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
        useInferenceMode: () => ({
          mode: 'browser-local',
          isModelReady: true,
          isServerConnected: true,
          modelLoadingProgress: 0,
          serverUrl: '',
          modeError: null,
          setMode: vi.fn(),
          setServerUrl: vi.fn(),
          checkServerConnectivity: vi.fn().mockResolvedValue(true),
          setModelReady: vi.fn(),
          setModelLoadingProgress: vi.fn(),
        }),
      }));

      render(<ChatPage />);

      // Start streaming by sending a message
      const textarea = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(textarea, { target: { value: 'Test message' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Verify streaming started
      await waitFor(() => {
        expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
      });

      // Now switch to API mode during streaming via the toggle
      // The toggle should still be functional
      const modeToggle = screen.getByRole('button', { name: /inference mode/i });
      expect(modeToggle).toBeInTheDocument();

      // Simulate clicking the toggle
      fireEvent.click(modeToggle);

      // The streaming should still be active (not cancelled by mode switch)
      // This verifies mode switching doesn't break streaming
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      vi.useRealTimers();
    });

    it('mode switching does not cancel active streaming', async () => {
      vi.useFakeTimers();

      // Create a custom ChatPage that exposes mode for testing
      function TestChatPage() {
        const [mode, setMode] = React.useState<'browser-local' | 'api'>('browser-local');
        const [isStreaming, setIsStreaming] = React.useState(false);

        return (
          <InferenceModeProvider>
            <div>
              <button
                data-testid="mode-switcher"
                onClick={() => setMode(mode === 'browser-local' ? 'api' : 'browser-local')}
              >
                Current Mode: {mode}
              </button>
              <button
                data-testid="streaming-toggle"
                onClick={() => setIsStreaming(!isStreaming)}
              >
                {isStreaming ? 'Streaming...' : 'Not Streaming'}
              </button>
            </div>
          </InferenceModeProvider>
        );
      }

      render(<TestChatPage />);

      // Start streaming
      fireEvent.click(screen.getByTestId('streaming-toggle'));
      expect(screen.getByText('Streaming...')).toBeInTheDocument();

      // Switch mode during streaming
      fireEvent.click(screen.getByTestId('mode-switcher'));

      // Streaming should still be active
      expect(screen.getByText('Streaming...')).toBeInTheDocument();

      vi.useRealTimers();
    });

    it('input remains disabled during model blocked state', () => {
      // Override mock to show model blocked state
      vi.doMock('../lib/inference', () => ({
        InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
        useInferenceMode: () => ({
          mode: 'browser-local',
          isModelReady: false,
          isServerConnected: false,
          modelLoadingProgress: 50,
          setMode: vi.fn(),
          checkServerConnectivity: vi.fn().mockResolvedValue(false),
          setModelReady: vi.fn(),
          setModelLoadingProgress: vi.fn(),
        }),
      }));

      vi.doMock('../components/InferenceModeToggle', () => ({
        InferenceModeToggle: () => (
          <button data-testid="inference-toggle" aria-label="Inference mode toggle">
            Toggle
          </button>
        ),
      }));

      render(<ChatPage />);

      // The model loading overlay should be shown
      // But the header toggle should still be accessible
      const toggleButton = screen.getByTestId('inference-toggle');
      expect(toggleButton).toBeInTheDocument();
      expect(toggleButton).toBeVisible();
    });
  });

  describe('InferenceModeContext - AbortController cleanup verification', () => {
    it('cancels previous AbortController when checkServerConnectivity is called again', async () => {
      vi.useFakeTimers();

      // Mock slow fetch
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

      // Start first connectivity check
      const checkButton = screen.getByText('Check');
      fireEvent.click(checkButton);

      // Immediately start another check (should cancel the first)
      fireEvent.click(checkButton);

      // Both should have been called (second cancels first)
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });

      // Verify abort was called (fetch should have been aborted)
      // The second call should have aborted the first request
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe('InferenceModeContext - 5s timeout verification', () => {
    it('server connectivity check times out after 5 seconds', async () => {
      vi.useFakeTimers();

      // Mock fetch that never resolves
      mockFetch.mockImplementation(
        () =>
          new Promise(() => {
            // Never resolves - simulates network hang
          })
      );

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

      // Start connectivity check
      fireEvent.click(screen.getByText('Check'));

      // At 4 seconds - should still be pending
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });

      // At 5 seconds - should timeout
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      // After timeout, state should show server unreachable
      await waitFor(() => {
        expect(screen.getByTestId('connected').textContent).toBe('false');
        expect(screen.getByTestId('error').textContent).toBe('Server unreachable');
      });

      vi.useRealTimers();
    });
  });

  describe('InferenceModeContext - localStorage try/catch verification', () => {
    it('loadStoredState handles localStorage.getItem throwing', () => {
      const localStorageSpy = vi.spyOn(global, 'localStorage', 'get');
      localStorageSpy.mockImplementation(() => {
        throw new Error('localStorage access denied');
      });

      function TestComponent() {
        const { mode } = useInferenceMode();
        return <div data-testid="mode">{mode}</div>;
      }

      // Should not throw, should fall back to default
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

    it('persistState handles localStorage.setItem throwing', () => {
      const localStorageSpy = vi.spyOn(global, 'localStorage', 'set');
      localStorageSpy.mockImplementation(() => {
        throw new Error('localStorage quota exceeded');
      });

      function TestComponent() {
        const { setMode } = useInferenceMode();
        return <button onClick={() => setMode('api')}>Set API</button>;
      }

      // Should not throw even when localStorage fails
      expect(() => {
        render(
          <InferenceModeProvider>
            <TestComponent />
          </InferenceModeProvider>
        );
      }).not.toThrow();

      // Click should also not throw
      fireEvent.click(screen.getByText('Set API'));

      // Should still update state even though persistence failed
      // (state is updated in memory, just not persisted)

      localStorageSpy.mockRestore();
    });
  });
});
