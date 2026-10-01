/**
 * universal-provider-settings-overhaul (parity with the browser overlay,
 * settings-wiring-honesty AC10): the Electron missing-model overlay offers
 * "Use a local server or cloud model", which opens Settings at the section
 * hosting the External model region (MODEL_CONNECTION_SECTION_ID) through
 * the same section-aware onOpenSettings seam; "Open Settings" without a
 * section keeps working. The focused destination itself (External model
 * heading in the Electron app) is pinned in
 * pages/__tests__/settings-wiring-honesty.test.tsx ("overlay destination").
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  it('without onOpenSettings it renders no actions and Tab stays on the heading (unchanged behavior)', () => {
    render(<DesktopModelBlockedOverlay open />);
    const dialog = screen.getByRole('alertdialog', DIALOG);
    expect(dialog.querySelectorAll('button')).toHaveLength(0);
    const heading = screen.getByRole('heading', DIALOG);
    expect(heading).toHaveFocus();
    const notPrevented = fireEvent.keyDown(heading, { key: 'Tab' });
    expect(notPrevented).toBe(false);
    expect(heading).toHaveFocus();
  });

  it('"Use a local server or cloud model" opens Settings at the External model section', () => {
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

  it('keeps focus inside the dialog: heading on open, Tab cycles the actions both ways', () => {
    render(<DesktopModelBlockedOverlay open onOpenSettings={vi.fn()} />);
    const heading = screen.getByRole('heading', DIALOG);
    const openSettings = screen.getByRole('button', { name: 'Open Settings' });
    const external = screen.getByRole('button', EXTERNAL_ACTION);
    expect(heading).toHaveFocus();
    fireEvent.keyDown(heading, { key: 'Tab' });
    expect(openSettings).toHaveFocus();
    external.focus();
    fireEvent.keyDown(external, { key: 'Tab' });
    expect(openSettings).toHaveFocus();
    fireEvent.keyDown(openSettings, { key: 'Tab', shiftKey: true });
    expect(external).toHaveFocus();
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
