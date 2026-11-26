/**
 * Verification tests for Task 3.3 — inference mode architecture (issue #348:
 * quarantine discharge), repaired against the CURRENT product.
 *
 * What changed vs the original spec and where the retired legs are covered green:
 * - The header inference control is a NON-FLIPPING STATUS with no button and
 *   renders null outside Electron (#265 AC6). The obsolete flip-button legs
 *   (aria-pressed true/false/toggle, aria-label wording, disabled-during-check)
 *   are covered by src/components/__tests__/inference-mode-toggle-status.test.tsx
 *   (lines 44-102: honest status words/labels per state; lines 104-117: the
 *   control is a status, NO button renders in any state) and
 *   src/components/__tests__/inference-mode-toggle-desktop.test.tsx:39-72
 *   (inside Electron it renders, never null, and no flip button exists in any
 *   state — mode switching moved to Settings).
 * - 'can switch mode while streaming is active' / 'mode switching does not
 *   cancel active streaming' pinned a browser-app mode flip that no longer
 *   exists (no flip control) and, in the second case, only asserted React
 *   local state of a locally-defined fake component. The real product's
 *   mid-stream switch handling is covered by
 *   src/pages/ChatPage.streaming-persistence.test.tsx (engine-switch effect:
 *   the live stream is terminalized and persisted, ~lines 1135, 1248-1270).
 * - The 5 s connectivity-timeout leg now lives in
 *   src/lib/inference/InferenceModeContext.test.tsx (where the probe's
 *   contract is pinned); it is not duplicated here.
 *
 * ChatPage here renders inside the REAL InferenceModeProvider (the page calls
 * useInferenceMode unconditionally); only the heavy engine/stream modules
 * ChatPage imports unconditionally are stubbed (sibling convention:
 * ChatPage.overlay.test.tsx).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { InferenceModeProvider, useInferenceMode } from '../lib/inference/InferenceModeContext';
import { ChatPage } from './ChatPage';

const fetchMock = vi.fn();

// Inert stubs for modules ChatPage imports unconditionally (it is blocked in
// every state asserted here, so none of these are exercised). Note
// disposeBrowserEngine: the REAL InferenceModeContext (kept real below)
// imports it from the same module.
vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn(() => ({
    initialize: vi.fn(async () => undefined),
    generate: async function* () {
      yield 'ok';
    },
    generateComplete: async () => 'ok',
    isReady: () => false,
    getModelInfo: () => null,
    getInferenceMode: () => 'wasm' as const,
    interrupt: () => undefined,
  })),
  disposeBrowserEngine: vi.fn(),
}));
vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(() => ({ query: vi.fn() })),
}));
vi.mock('../lib/streaming', () => ({
  TokenStreamManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    cancel: vi.fn(),
    onToken: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    pushToken: vi.fn(),
    complete: vi.fn(),
    dispose: vi.fn(),
  })),
}));
// Keeps the blocked overlay on its stable "Preparing the model…" state instead
// of racing a real readiness probe (ChatPage.overlay.test.tsx convention).
vi.mock('../lib/llm/readiness-gate', () => ({
  getReadinessSnapshot: () => ({ modelCached: false, webgpuAvailable: false }),
  getReadinessResultSnapshot: () => null,
  getReadinessGateInstance: () => null,
  applyReadinessFromEvent: vi.fn(),
  resetReadinessCache: vi.fn(),
  ensureReadinessGateChecked: vi.fn(async () => null),
}));

function renderChatPage() {
  return render(
    <InferenceModeProvider>
      <ChatPage
        messages={[]}
        onMessagesChange={() => {}}
        onSaveConversation={() => {}}
        onNewChat={() => {}}
        currentConversationId={undefined}
        setCurrentConversationId={() => {}}
        onOpenSettings={() => {}}
      />
    </InferenceModeProvider>
  );
}

describe('Task 3.3 Verification - Inference Mode Architecture', () => {
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
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  describe('ChatPage - overlay does not remove the header', () => {
    it('header controls stay in the document while the blocking overlay is mounted', () => {
      // REAL ChatPage inside the REAL provider: the browser app boots
      // browser-local with the model not ready and no external model, so the
      // model gate (role=alertdialog) is up.
      renderChatPage();

      const overlay = screen.getByRole('alertdialog');
      expect(overlay).toBeInTheDocument();

      // Real header controls that exist in the browser app (there is no
      // inference-toggle testid and no inference status outside Electron):
      // the PageHeader title and the model chip's settings button. They stay
      // MOUNTED while the gate is up — but Lumen phase 7 makes the covered
      // content inert, so accessibility-tree queries need `hidden: true` to
      // see them (which is itself the pinned behavior: mounted, not removed).
      const heading = screen.getByRole('heading', { name: 'Chat', hidden: true });
      expect(heading).toBeInTheDocument();
      const modelChip = screen.getByTestId('chat-model-chip');
      expect(modelChip).toBeInTheDocument();
      expect(modelChip).toHaveAttribute('aria-label', expect.stringContaining('Open model settings'));

      // The inert gate: the header is excluded from the accessibility tree
      // (not unmounted) while the overlay is up.
      expect(heading.closest('.chat-page__content')).toHaveAttribute('inert');
      expect(screen.queryByRole('heading', { name: 'Chat' })).not.toBeInTheDocument();

      // #265 AC6: the inference control is desktop-only; in the browser app
      // the header carries no inference-mode status at all.
      expect(screen.queryByTestId('inference-mode-status')).not.toBeInTheDocument();
    });

    it('input remains disabled during model blocked state', () => {
      // Same REAL blocked state as above: browser-local, model not ready.
      renderChatPage();

      // The blocking overlay is mounted…
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      // …and the composer is disabled while the gate is up. The textarea sits
      // in the inert subtree, so the role query needs `hidden: true`.
      const textarea = screen.getByRole('textbox', { hidden: true });
      expect(textarea).toBeDisabled();
    });
  });

  describe('InferenceModeContext - AbortController cleanup verification', () => {
    it('a second connectivity check aborts the previous in-flight request', async () => {
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
      // Capture each request's signal; mirror real fetch abort semantics.
      const signals: AbortSignal[] = [];
      fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => {
        signals.push(init!.signal!);
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      });

      function TestComponent() {
        const { checkServerConnectivity } = useInferenceMode();
        return <button onClick={() => void checkServerConnectivity()}>Check</button>;
      }

      render(
        <InferenceModeProvider>
          <TestComponent />
        </InferenceModeProvider>
      );

      // Start the first connectivity check.
      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      // A second check cancels the first (InferenceModeContext.tsx:266-274).
      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
      expect(abortSpy).toHaveBeenCalledTimes(1);

      abortSpy.mockRestore();
    });
  });

  describe('InferenceModeContext - localStorage try/catch verification', () => {
    it('loadStoredState handles localStorage.getItem throwing', () => {
      const getter = vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
        throw new DOMException('localStorage access denied', 'SecurityError');
      });

      function TestComponent() {
        const { mode } = useInferenceMode();
        return <div data-testid="mode">{mode}</div>;
      }

      try {
        // Should not throw, should fall back to the default.
        expect(() => {
          render(
            <InferenceModeProvider>
              <TestComponent />
            </InferenceModeProvider>
          );
        }).not.toThrow();

        expect(screen.getByTestId('mode').textContent).toBe('browser-local');
      } finally {
        getter.mockRestore();
      }
    });

    it('persistState handles localStorage.setItem throwing (in-memory state still updates)', () => {
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('localStorage quota exceeded', 'QuotaExceededError');
      });

      function TestComponent() {
        const { ragPreset, setRagPreset } = useInferenceMode();
        return (
          <div>
            <span data-testid="preset">{ragPreset}</span>
            <button onClick={() => setRagPreset('quality')}>Set quality</button>
          </div>
        );
      }

      try {
        // Mounting must not throw even though every write fails.
        expect(() => {
          render(
            <InferenceModeProvider>
              <TestComponent />
            </InferenceModeProvider>
          );
        }).not.toThrow();

        expect(screen.getByTestId('preset').textContent).toBe('balanced');

        // setRagPreset persists through persistState (whose setItem throws
        // and is swallowed): the in-memory state must still update.
        act(() => {
          fireEvent.click(screen.getByText('Set quality'));
        });

        expect(screen.getByTestId('preset').textContent).toBe('quality');
        // And nothing was written.
        expect(localStorage.getItem('inference-mode')).toBeNull();
      } finally {
        setItem.mockRestore();
      }
    });
  });
});
