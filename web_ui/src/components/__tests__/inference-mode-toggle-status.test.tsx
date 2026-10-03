/**
 * Lumen phase 5 review (F3, F8): InferenceModeToggle states only what is true.
 * - "Loading…" only while a load reports progress (0 < progress < 100);
 *   a model that is not ready and not loading is "Not ready".
 * - In api mode without a connection the toggle shows no visible status word,
 *   because ChatPage's "Server not connected" pill already says it.
 * - The button's accessible name contains its visible label (WCAG 2.5.3).
 * (The legacy InferenceModeToggle.test.tsx stays excluded in vitest.config.ts.)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../lib/inference', () => ({ useInferenceMode: vi.fn() }));
vi.mock('../../lib/desktop-session', () => ({ isElectron: vi.fn(() => true) }));

import { InferenceModeToggle } from '../InferenceModeToggle';
import * as inference from '../../lib/inference';

function ctx(over: Partial<{ mode: 'browser-local' | 'api'; isModelReady: boolean; modelLoadingProgress: number; isServerConnected: boolean; modeError: string | null }>) {
  vi.mocked(inference.useInferenceMode).mockReturnValue({
    mode: 'browser-local',
    isModelReady: false,
    modelLoadingProgress: 0,
    isServerConnected: false,
    modeError: null,
    serverUrl: 'http://127.0.0.1:4567',
    setMode: vi.fn(),
    checkServerConnectivity: vi.fn(async () => true),
    ...over,
  } as unknown as ReturnType<typeof inference.useInferenceMode>);
}

const statusWord = () => {
  const el = screen.getByTestId('inference-mode-status');
  // Visible text only: drop the visually hidden sentence.
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.ui-visually-hidden').forEach((n) => n.remove());
  return clone.textContent ?? '';
};

describe('InferenceModeToggle honest status', () => {
  beforeEach(() => vi.clearAllMocks());

  it('browser-local, not ready, nothing loading: "Not ready" (never "Loading…")', () => {
    ctx({ isModelReady: false, modelLoadingProgress: 0 });
    render(<InferenceModeToggle />);
    expect(statusWord()).toBe('Not ready');
    expect(screen.getByTestId('inference-mode-status')).toHaveAttribute('title', 'Browser-local mode (model not loaded)');
  });

  it('browser-local, finished boot progress (100) but not ready: still "Not ready"', () => {
    ctx({ isModelReady: false, modelLoadingProgress: 100 });
    render(<InferenceModeToggle />);
    expect(statusWord()).toBe('Not ready');
  });

  it('browser-local, load in progress: "Loading…" with the percentage in the tooltip', () => {
    ctx({ isModelReady: false, modelLoadingProgress: 42 });
    render(<InferenceModeToggle />);
    expect(statusWord()).toBe('Loading…');
    expect(screen.getByTestId('inference-mode-status')).toHaveAttribute('title', 'Browser-local mode (model loading, 42%)');
  });

  it('browser-local, ready: "Ready"', () => {
    ctx({ isModelReady: true, modelLoadingProgress: 100 });
    render(<InferenceModeToggle />);
    expect(statusWord()).toBe('Ready');
  });

  it('api mode, connected: "Connected"', () => {
    ctx({ mode: 'api', isServerConnected: true });
    render(<InferenceModeToggle />);
    expect(statusWord()).toBe('Connected');
  });

  it('api mode, not connected: no visible duplicate of the page pill, state still announced', () => {
    ctx({ mode: 'api', isServerConnected: false });
    render(<InferenceModeToggle />);
    expect(statusWord()).toBe('');
    expect(screen.getByTestId('inference-mode-status')).toHaveTextContent('Desktop backend (not connected)');
  });

  it('the toggle button name contains its visible label (WCAG 2.5.3)', () => {
    ctx({ mode: 'browser-local' });
    const { unmount } = render(<InferenceModeToggle />);
    let btn = screen.getByRole('button');
    expect(btn).toHaveTextContent('On this computer');
    expect(btn.getAttribute('aria-label')).toContain('On this computer');
    unmount();
    ctx({ mode: 'api', isServerConnected: true });
    render(<InferenceModeToggle />);
    btn = screen.getByRole('button');
    expect(btn).toHaveTextContent('Desktop backend');
    expect(btn.getAttribute('aria-label')).toContain('Desktop backend');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });
});
