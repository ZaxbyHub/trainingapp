/**
 * #265 (AC6, frozen check C4): inside Electron the chat-header inference-mode
 * control is a NON-FLIPPING status — it renders (never null) and offers no
 * button that would switch the app to browser-local, because the desktop
 * package ships no browser-LLM weights (decision comment 6825525627:
 * Electron browser-local hidden).
 *
 * Electron is mocked in (the same seam inference-mode-toggle-status.test.tsx
 * uses); the browser-app render path returns null (pinned there).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('../../lib/inference', () => ({ useInferenceMode: vi.fn() }));
vi.mock('../../lib/desktop-session', () => ({ isElectron: vi.fn(() => true) }));

import { InferenceModeToggle } from '../InferenceModeToggle';
import * as inference from '../../lib/inference';

function ctx(over: Partial<{ mode: 'browser-local' | 'api'; isModelReady: boolean; modelLoadingProgress: number; isServerConnected: boolean; modeError: string | null; serverUrl: string }>) {
  vi.mocked(inference.useInferenceMode).mockReturnValue({
    mode: 'api',
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

describe('InferenceModeToggle in Electron: non-flipping status (#265 AC6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a status (never null) with no flip button', () => {
    ctx({ mode: 'api', isServerConnected: true });
    render(<InferenceModeToggle />);
    expect(screen.getByTestId('inference-mode-status')).toBeInTheDocument();
    // THE pin: no control exists that could switch to browser-local.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the non-flipping status even before the per-launch serverUrl is seeded', () => {
    ctx({ mode: 'api', isServerConnected: false, serverUrl: '' });
    render(<InferenceModeToggle />);
    expect(screen.getByTestId('inference-mode-status')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // The hidden sentence still announces the honest state.
    expect(screen.getByTestId('inference-mode-status')).toHaveTextContent('Desktop backend (not connected)');
  });

  it('reports the connected desktop backend status', () => {
    ctx({ mode: 'api', isServerConnected: true });
    render(<InferenceModeToggle />);
    const el = screen.getByTestId('inference-mode-status');
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.ui-visually-hidden').forEach((n) => n.remove());
    expect(clone.textContent).toBe('Connected');
  });

  it('switching modes is impossible from the header: no mode button exists in ANY state', () => {
    ctx({ mode: 'browser-local', isModelReady: true });
    const { rerender } = render(<InferenceModeToggle />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    ctx({ mode: 'api', isServerConnected: false, modeError: 'boom' });
    rerender(<InferenceModeToggle />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
