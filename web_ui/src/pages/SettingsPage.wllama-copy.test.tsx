/**
 * #265 (AC2, frozen check C1): the Settings wllama option tells the truth
 * about the packaged LFM model — "WebGPU when available, CPU otherwise",
 * text-only — and the stale "multimodal"/"image input" copy is gone.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

const inferenceMock = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('../lib/inference', () => ({
  InferenceModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useInferenceMode: () => inferenceMock.state as unknown as ReturnType<typeof import('../lib/inference').useInferenceMode>,
}));
vi.mock('../lib/theme', () => ({
  useTheme: () => ({ theme: 'light', themePreference: 'system', setTheme: vi.fn(), isDark: false }),
}));
vi.mock('../lib/storage/profile', () => ({
  getProfilePrefix: () => 'testprfx',
  deleteNamespace: vi.fn(() => Promise.resolve()),
  listStalePrefixes: vi.fn(() => Promise.resolve([])),
  listRegisteredProfiles: () => ({ profiles: ['testprfx'], healthy: true }),
  isRegisteredProfile: () => false,
  registerProfile: () => true,
  unregisterProfile: () => true,
  newProfilePrefix: () => 'newprof',
  resetProfileRegistry: () => false,
  getStorageDbNames: () => ({
    documents: 'x-doc-qa-documents',
    vectorMapping: 'x-doc-qa-indexes',
    vector: 'x-doc-qa-index',
    keyword: 'x-doc-qa-keywords',
    conversations: 'x-doc-qa-conversations',
  }),
}));
vi.mock('../lib/llm/model-download', () => ({
  ModelDownloadManager: vi.fn().mockImplementation(() => ({ downloadModel: vi.fn(), cancelDownload: vi.fn() })),
}));
vi.mock('../lib/llm/model-readiness', () => ({
  ModelReadinessGate: vi.fn().mockImplementation(() => ({ checkModelCached: vi.fn(() => Promise.resolve(false)) })),
}));
vi.mock('../lib/embeddings/memory-aware', () => ({
  getMemoryBudget: vi.fn(() => ({ availableMB: 8192, totalMB: 16384 })),
  getMemoryPressureStatus: vi.fn(() => 'normal'),
}));
vi.mock('../lib/models/model-manifest', () => ({
  checkPackagedModels: vi.fn(() => Promise.resolve(null)),
  LLM_MODEL_DIR: 'lfm2-1.2b-rag',
}));
vi.mock('../lib/llm/engine-capability', () => ({
  detectEngineCapability: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../components/ModelDownloadProgress', () => ({ ModelDownloadProgress: () => null }));

import { SettingsPage } from './SettingsPage';

describe('SettingsPage wllama copy (#265 AC2)', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    (globalThis as Record<string, unknown>).indexedDB = {
      open: vi.fn(() => {
        const req: Record<string, unknown> = { onsuccess: null, onerror: null };
        setTimeout(() => (req.onsuccess as ((e: Event) => void) | null)?.call(req, new Event('success')), 0);
        return req;
      }),
      deleteDatabase: vi.fn(() => {
        const req: Record<string, unknown> = { onsuccess: null, onerror: null };
        setTimeout(() => (req.onsuccess as ((e: Event) => void) | null)?.call(req, new Event('success')), 0);
        return req;
      }),
    } as unknown as typeof globalThis.indexedDB;
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
    inferenceMock.state = {
      mode: 'browser-local',
      browserEngine: 'wllama',
      ragPreset: 'balanced',
      isServerConnected: false,
      isModelReady: false,
      modelLoadingProgress: 0,
      modeError: null,
      serverUrl: '',
      setMode: vi.fn(),
      setBrowserEngine: vi.fn(),
      setRagPreset: vi.fn(),
      checkServerConnectivity: vi.fn(() => Promise.resolve(false)),
      setModelReady: vi.fn(),
      setModelLoadingProgress: vi.fn(),
    };
  });

  test('the wllama radio states the derived backend truthfully and is text-only', async () => {
    render(<SettingsPage />);
    const group = await waitFor(() => {
      const g = screen.getByRole('group', { name: /^browser engine$/i });
      expect(g).toBeInTheDocument();
      return g;
    });
    const wllama = screen.getByRole('radio', { name: /wllama \(webgpu when available, cpu otherwise\)/i });
    expect(wllama).toBeChecked();
    // The option's description (aria-describedby) says: bundled LFM2 model,
    // offline, TEXT ONLY.
    expect(screen.getByText(/runs the bundled lfm2 model offline; text only\./i)).toBeInTheDocument();
    expect(group.textContent).not.toMatch(/multimodal|image input|image\/screenshot/i);
  });

  test('no engine surface carries the stale multimodal/image wording', async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /^browser engine$/i })).toBeInTheDocument();
    });
    expect(container.textContent ?? '').not.toMatch(/multimodal|image input|image\/screenshot/i);
  });

  test('the WebLLM option (visible in dev builds) names the internet download honestly', async () => {
    render(<SettingsPage />);
    await screen.findByRole('radio', { name: /webllm \(webgpu\)/i });
    expect(
      screen.getByText(/downloads llama 3\.2 \(~1\.9 gb\) from the internet; not the packaged model\./i),
    ).toBeInTheDocument();
  });
});
