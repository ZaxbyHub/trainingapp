/**
 * universal-provider-settings-overhaul (parity with the browser overlay,
 * settings-wiring-honesty AC10): the Electron missing-model overlay offers
 * "Use a local server or cloud model", which opens Settings at the section
 * Model & connection (MODEL_CONNECTION_SECTION_ID) through
 * the same section-aware onOpenSettings seam; "Open Settings" without a
 * section keeps working. The focused destination itself (Model & connection
 * heading in the Electron app) is pinned in
 * pages/__tests__/settings-wiring-honesty.test.tsx ("overlay destination").
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

vi.mock('../../lib/rag/rag-orchestrator', () => ({ RAGOrchestrator: vi.fn() }));
vi.mock('../../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn(),
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn(() => 'wllama'),
}));
vi.mock('../../lib/llm/web-llm-service', () => ({ WEBLLM_DEFAULT_MODEL_ID: 'test-webllm' }));
vi.mock('../../lib/llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn(async () => undefined),
  getReadinessResultSnapshot: vi.fn(() => null),
  resetReadinessCache: vi.fn(),
}));
vi.mock('../../lib/models/model-manifest', () => ({ LLM_MODEL_DIR: 'test-model-dir' }));
vi.mock('../../lib/export/conversation-export', () => ({ downloadConversation: vi.fn() }));
vi.mock('../../hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: vi.fn() }));

import { DesktopModelBlockedOverlay } from '../DesktopModelBlockedOverlay';
import { ChatPage } from '../../pages/ChatPage';
import { InferenceModeProvider } from '../../lib/inference';
import { DesktopSessionProvider, type DesktopSession, type DesktopSessionState } from '../../lib/desktop-session';
import { MODEL_CONNECTION_SECTION_ID } from '../../lib/settings-sections';
import type { ModelStatus } from '../../lib/api/types';

const DIALOG = { name: /AI models are not installed yet/i };
const EXTERNAL_ACTION = { name: 'Use a local server or cloud model' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test stub)'))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DesktopModelBlockedOverlay actions', () => {
  it('PRR-151-049: onOpenSettings is required, so the non-dismissible gate can never render actionless', () => {
    // Compile-time pin (tsc -p tsconfig.test.json): making the prop optional again
    // turns this expect-error into an unused directive, which fails the typecheck.
    // @ts-expect-error onOpenSettings is required
    const actionless = <DesktopModelBlockedOverlay open />;
    expect(actionless.props.open).toBe(true);
    render(<DesktopModelBlockedOverlay open onOpenSettings={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', DIALOG);
    expect(dialog.querySelectorAll('button')).toHaveLength(2);
    expect(dialog).toHaveAccessibleDescription(/Or connect an external model \(a local server or a cloud provider\) in Settings\./);
  });

  it('is a non-modal alertdialog described by its body, built from Dialog + Banner + Button (no inline styles)', () => {
    const { container } = render(<DesktopModelBlockedOverlay open onOpenSettings={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', DIALOG);
    // The gate blocks the chat page only; the shell navigation stays usable, so no aria-modal claim.
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(dialog).toHaveAccessibleDescription(/Neither the Quality nor the Fast language model was found/);
    expect(dialog.querySelector('.ui-banner')).not.toBeNull();
    expect(screen.getByRole('button', EXTERNAL_ACTION)).toHaveClass('ui-button--primary');
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    // Contained to the chat region (not a window-wide z-9000 layer).
    expect(screen.getByTestId('ui-dialog-backdrop')).toHaveClass('ui-dialog__backdrop--contained');
  });

  it('"Use a local server or cloud model" opens Settings at the Model & connection section', () => {
    const onOpenSettings = vi.fn();
    render(<DesktopModelBlockedOverlay open onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole('button', EXTERNAL_ACTION));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledWith(MODEL_CONNECTION_SECTION_ID);
    expect(MODEL_CONNECTION_SECTION_ID).toBe('model-connection');
  });

  it('"Open Settings" still opens Settings without a section', () => {
    const onOpenSettings = vi.fn();
    render(<DesktopModelBlockedOverlay open onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings.mock.calls[0]).toEqual([]);
  });

  it('focus opens on the dialog; Tab moves through the actions and is not trapped (non-modal)', async () => {
    const user = userEvent.setup();
    render(<DesktopModelBlockedOverlay open onOpenSettings={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', DIALOG);
    const openSettings = screen.getByRole('button', { name: 'Open Settings' });
    const external = screen.getByRole('button', EXTERNAL_ACTION);
    expect(dialog).toHaveFocus();
    await user.tab();
    expect(openSettings).toHaveFocus();
    await user.tab();
    expect(external).toHaveFocus();
    // Edge presses are not intercepted: the browser decides where focus goes next.
    expect(fireEvent.keyDown(external, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(openSettings, { key: 'Tab', shiftKey: true })).toBe(true);
  });

  it('F-011: Escape is swallowed and the blocking overlay stays open (no dismiss path), as documented', () => {
    render(<DesktopModelBlockedOverlay open onOpenSettings={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', DIALOG);
    // fireEvent returns false when the handler called preventDefault().
    expect(fireEvent.keyDown(dialog, { key: 'Escape' })).toBe(false);
    expect(screen.getByRole('alertdialog', DIALOG)).toBeInTheDocument();
    expect(dialog).toHaveFocus();
    // A scrim press does not dismiss it either.
    fireEvent.mouseDown(screen.getByTestId('ui-dialog-backdrop'));
    expect(screen.getByRole('alertdialog', DIALOG)).toBeInTheDocument();
    // The docstring must describe that behavior, not claim the overlay closes.
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'DesktopModelBlockedOverlay.tsx'),
      'utf8',
    );
    const docblock = source.slice(0, source.indexOf('*/'));
    expect(docblock).not.toMatch(/closes on\s+(?:\*\s*)?Escape/i);
    expect(docblock).toMatch(/does NOT\s+(?:\*\s*)?close on Escape/);
  });

  it('renders nothing when closed', () => {
    render(<DesktopModelBlockedOverlay open={false} onOpenSettings={vi.fn()} />);
    expect(screen.queryByRole('alertdialog', DIALOG)).toBeNull();
  });
});

describe('ChatPage wires the desktop overlay to the section-aware Settings seam', () => {
  function session(): DesktopSession {
    return {
      baseUrl: 'http://127.0.0.1:4567',
      token: 'session-token',
      mode: 'node',
      apiClient: {
        listDocuments: vi.fn(async () => ({ documents: [], total: 0 })),
      } as unknown as DesktopSession['apiClient'],
      sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
    };
  }

  it('a real engine with no staged models: the overlay action calls onOpenSettings("model-connection")', async () => {
    const models = {
      engine: 'llama.cpp',
      profile: 'auto',
      models: { quality: { present: false }, fast: { present: false } },
    } as ModelStatus;
    const state: DesktopSessionState = { session: session(), models, loading: false, error: null };
    const onOpenSettings = vi.fn();
    render(
      <InferenceModeProvider>
        <DesktopSessionProvider value={state}>
          <ChatPage
            messages={[]}
            onMessagesChange={() => undefined}
            onSaveConversation={vi.fn()}
            currentConversationId={undefined}
            setCurrentConversationId={vi.fn()}
            onNewChat={vi.fn()}
            onOpenSettings={onOpenSettings}
            onNavigateToDocuments={vi.fn()}
          />
        </DesktopSessionProvider>
      </InferenceModeProvider>,
    );
    const dialog = await screen.findByRole('alertdialog', DIALOG);
    fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === EXTERNAL_ACTION.name) as HTMLButtonElement,
    );
    expect(onOpenSettings).toHaveBeenCalledWith(MODEL_CONNECTION_SECTION_ID);
  });
});
