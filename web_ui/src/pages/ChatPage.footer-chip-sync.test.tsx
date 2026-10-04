/**
 * PRR-107: the sidebar footer chip and the Chat header chip must name the same model.
 *
 * The footer reads App's /status/models snapshot (refreshed only on models-changed events);
 * the header reads ChatPage's own ~2s poll. The desktop backend swaps its resident model
 * lazily (desktop/main/backend/inference/llama-engine.ts: a profile change commits the
 * setting, the model loads on the next query), so the footer must be refreshed when the
 * resident state/profile moves, not only when the setting is saved. This harness mirrors
 * App's wiring (state fed by subscribeLatestModelStatus) around the REAL ChatPage and
 * SidebarConnectionChip.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('../lib/rag/rag-orchestrator', () => ({
  RAGOrchestrator: vi.fn().mockImplementation(function () {
    return { query: vi.fn() };
  }),
}));
vi.mock('../lib/llm/llm-factory', () => ({
  getLLMService: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(),
    supportsImages: vi.fn().mockReturnValue(false),
  })),
  DEFAULT_BROWSER_ENGINE: 'wllama',
  disposeBrowserEngine: vi.fn(),
  getPreferredBrowserEngine: vi.fn().mockReturnValue('wllama'),
}));
vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: vi.fn(),
}));
vi.mock('../lib/llm/readiness-gate', () => ({
  ensureReadinessGateChecked: vi.fn().mockResolvedValue(null),
  getReadinessResultSnapshot: vi.fn().mockReturnValue(null),
  resetReadinessCache: vi.fn(),
}));
vi.mock('../lib/api/auth', () => ({ getToken: vi.fn().mockReturnValue(null) }));
vi.mock('../hooks/useDocumentCount', () => ({
  useDocumentCount: () => ({ count: 3, loading: false }),
}));

import { ChatPage } from './ChatPage';
import { SidebarConnectionChip } from '../components/SidebarConnectionChip';
import { AppShell } from '../ui';
import * as inferenceModule from '../lib/inference';
import { DesktopSessionProvider, fetchModelStatus, type DesktopSession } from '../lib/desktop-session';
import { DESKTOP_MODELS_CHANGED_EVENT, subscribeLatestModelStatus } from '../lib/desktop-models-events';
import type { ModelStatus } from '../lib/api/types';

function status(profile: 'quality' | 'fast'): ModelStatus {
  return {
    engine: 'llama.cpp',
    profile,
    models: { quality: { present: true }, fast: { present: true } },
    resident: { state: 'ready', profile, loadStartedAt: null },
  };
}

const session = {
  baseUrl: 'http://127.0.0.1:4567',
  token: 't',
  mode: 'node',
  apiClient: {},
  sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
} as unknown as DesktopSession;

/** Mirrors App.tsx: snapshot state + subscribeLatestModelStatus(fetchModelStatus). */
function AppLike({ initial = status('quality') }: { initial?: ModelStatus | null } = {}) {
  const [models, setModels] = React.useState<ModelStatus | null>(initial);
  React.useEffect(
    () =>
      subscribeLatestModelStatus(
        () => fetchModelStatus(session),
        (m) => setModels(m),
      ),
    [],
  );
  const value = React.useMemo(() => ({ session, models, loading: false, error: null }), [models]);
  return (
    <DesktopSessionProvider value={value}>
      <AppShell productName="TrainingApp" collapsed={false} onToggleCollapsed={() => {}} sidebar={<SidebarConnectionChip onOpenModelSettings={() => {}} />}>
        <ChatPage
          messages={[]}
          onMessagesChange={() => {}}
          onSaveConversation={() => {}}
          currentConversationId="c"
          setCurrentConversationId={() => {}}
          onNewChat={() => {}}
          onOpenSettings={() => {}}
        />
      </AppShell>
    </DesktopSessionProvider>
  );
}

describe('footer chip follows the resident model (PRR-107)', () => {
  let served: ModelStatus;
  beforeEach(() => {
    served = status('quality');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/status/models')) return { ok: true, status: 200, json: async () => served };
        throw new Error('offline (test stub)');
      }),
    );
    vi.mocked(inferenceModule.useInferenceMode).mockReturnValue({
      mode: 'api',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isModelReady: true,
      isServerConnected: true,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      setServerUrl: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    } as unknown as ReturnType<typeof inferenceModule.useInferenceMode>);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test('L2: a swap that happened while Chat was not mounted is announced on the first poll', async () => {
    served = status('fast'); // backend already moved; App's snapshot (seeded 'quality') is stale
    render(<AppLike />);
    const footer = await screen.findByTestId('sidebar-model-chip');
    await waitFor(() => expect(footer).toHaveTextContent('Fast profile'), { timeout: 2500 });
  }, 10_000);

  test('INFO-1: App snapshot missing at boot -> first successful poll notifies once', async () => {
    let changed = 0;
    const count = () => {
      changed += 1;
    };
    window.addEventListener(DESKTOP_MODELS_CHANGED_EVENT, count);
    try {
      render(<AppLike initial={null} />);
      const footer = await screen.findByTestId('sidebar-model-chip');
      await waitFor(() => expect(footer).toHaveTextContent('Quality profile'), { timeout: 2500 });
      // Two more unchanged polls: no further notifications (no loop).
      await new Promise((r) => setTimeout(r, 4300));
      expect(changed).toBe(1);
    } finally {
      window.removeEventListener(DESKTOP_MODELS_CHANGED_EVENT, count);
    }
  }, 15_000);

  test('L3: unchanged polls do not cause App re-reads (no notify storm)', async () => {
    let changed = 0;
    const count = () => {
      changed += 1;
    };
    window.addEventListener(DESKTOP_MODELS_CHANGED_EVENT, count);
    try {
      render(<AppLike />);
      await screen.findByTestId('chat-model-chip');
      // >= 2 polls (2s interval) with the backend unchanged.
      await new Promise((r) => setTimeout(r, 4600));
      expect(changed).toBe(0);
    } finally {
      window.removeEventListener(DESKTOP_MODELS_CHANGED_EVENT, count);
    }
  }, 15_000);

  test('after the backend swaps its resident profile, header and footer chips both name the new one', async () => {
    render(<AppLike />);
    const header = await screen.findByTestId('chat-model-chip');
    const footer = screen.getByTestId('sidebar-model-chip');
    expect(header).toHaveTextContent('Quality profile');
    expect(footer).toHaveTextContent('Quality profile');

    // The next query loads the other profile; /status/models now reports it as resident.
    served = status('fast');

    // ChatPage's 2s poll sees the transition, announces it, App re-reads, the footer follows.
    await waitFor(() => expect(header).toHaveTextContent('Fast profile'), { timeout: 4500 });
    await waitFor(() => expect(footer).toHaveTextContent('Fast profile'), { timeout: 2500 });
  }, 10_000);
});
