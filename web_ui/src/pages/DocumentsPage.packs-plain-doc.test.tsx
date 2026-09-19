/**
 * DocumentsPage.packs-plain-doc.test.tsx — PRESERVING acceptance check for
 * issue #74 AC3 (C7: Documents page pack surface).
 *
 * Contract being preserved: a PLAIN document dropped on the Documents page
 * keeps using the EXISTING document pipeline, untouched by the new pack
 * surface.
 *   - Electron mode: a plain `.txt` routes through the existing
 *     `apiClient.uploadFile` path and never calls any pack-install method
 *     (installPack / removePack / rollbackPack).
 *   - Browser mode (no preload bridge): the same drop still enters the
 *     existing browser-local pipeline (extractDocument) — the pack surface
 *     must not hijack or alter it.
 *
 * This suite imports ONLY existing modules: DocumentsPage,
 * DesktopSessionProvider, and the browser-local boundary mocks used by
 * DocumentsPage.electron.test.tsx. It MUST PASS on the base tree (before any
 * pack surface exists) — run it whenever the pack UI lands to prove the
 * plain-document path is byte-for-byte unchanged.
 *
 * The stub apiClient here MAY declare the pack methods as inert vi.fn()s so
 * the suite can assert they are never invoked; `listPacks` resolves to an
 * empty list so the (future) packs panel has a defined empty state.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DocumentsPage } from './DocumentsPage';
import { ToastProvider } from '../components/ToastProvider';
import { DesktopSessionProvider, type DesktopSession } from '../lib/desktop-session';
import type { DesktopApiBridge, FirstRunStatus } from '../types/desktop';
import type { ApiClient } from '../lib/api';

// Browser-local boundary mocks — the set DocumentsPage.electron.test.tsx
// mocks, with shapes rich enough for the browser-mode pipeline to run to its
// (controlled) embedding-not-ready terminal state. saveDocuments/deleteDocument
// return promises: the browser-mode unmount flush calls .catch on them.
vi.mock('../lib/storage/document-store', () => ({
  loadDocuments: vi.fn(async () => []),
  saveDocuments: vi.fn(async () => undefined),
  deleteDocument: vi.fn(async () => undefined),
}));
vi.mock('../lib/storage/profile', () => ({
  migrateOrphanedNamespaces: vi.fn(async () => undefined),
  getProfilePrefix: vi.fn(() => 'testprfx'),
}));
vi.mock('../lib/search/vector-index', () => ({
  getVectorIndex: vi.fn(() => ({ initialize: async () => {}, isReady: () => false })),
}));
vi.mock('../lib/search/keyword-index', () => ({
  getKeywordIndex: vi.fn(() => ({ addDocuments: () => {}, save: async () => {} })),
}));
vi.mock('../lib/embeddings/embedding-service', () => ({
  getEmbeddingService: vi.fn(() => ({ isReady: () => false })),
}));
vi.mock('../lib/processing/extractor-factory', () => ({
  extractDocument: vi.fn(async () => ({ fullText: 'plain text body', pages: undefined })),
  SUPPORTED_EXTENSIONS: ['.pdf', '.txt'],
}));
vi.mock('../lib/processing/text-chunker', () => ({
  TextChunker: class {
    chunkText(text: string, source: string) {
      return [{ text, docId: '', source, page: undefined }];
    }
  },
}));
vi.mock('../hooks/useServiceInitialization', () => ({
  // false -> the browser pipeline stops at its OWN well-defined gate (the
  // embedding-service-not-ready error), never reaching real model code.
  ensureEmbeddingServiceReady: vi.fn(async () => false),
}));

import { extractDocument } from '../lib/processing/extractor-factory';

/** Minimal type-honest FirstRunStatus for inert bridge stubs (PRR-004). */
function stubFirstRunStatus(): FirstRunStatus {
  return {
    needed: false,
    reason: 'complete',
    rerun: false,
    engine: 'stub',
    hardware: { freeBytes: 0 },
    profile: {
      recommended: 'fast',
      warning: null,
      stored: 'fast',
      contextSize: 8192,
      models: { quality: null, fast: null },
    },
    manifest: { staged: false, packaged: false, failures: [], verifiedCount: 0 },
    packs: { toolsAvailable: false, required: [], installed: [] },
    licenses: { available: false, path: null, content: null },
    state: { completed: false, selectedProfile: 'fast', completedAt: '', acknowledgedLicenses: false },
  };
}

function installDesktopBridge(): void {
  (window as { desktopApi?: DesktopApiBridge }).desktopApi = {
    getAuthToken: vi.fn(async () => 't'),
    getBackendInfo: vi.fn(async () => ({ mode: 'node', port: 1, url: 'http://127.0.0.1:1' })),
    getFirstRunStatus: vi.fn(async () => stubFirstRunStatus()),
    activateFirstRunPacks: vi.fn(async () => ({ ok: true, results: [] })),
    completeFirstRun: vi.fn(async () => ({ ok: true })),
    resetFirstRun: vi.fn(async () => ({ ok: true })),
    onFirstRunRequired: vi.fn(() => () => {}),
  };
}

/**
 * The plain-document DropZone input: the input[type=file] WITHOUT the pack
 * install testid (on base it is the only file input; once the pack surface
 * lands, pack-install-input is a separate input that must be excluded here).
 * The input mounts only after the page's initial load state settles, so the
 * lookup waits for it.
 */
async function plainDocInput(): Promise<HTMLInputElement> {
  return waitFor(() => {
    const el = document.querySelector(
      'input[type="file"]:not([data-testid="pack-install-input"])',
    );
    expect(el).toBeTruthy();
    return el as HTMLInputElement;
  });
}

const installPack = vi.fn(async () => ({ packId: 'stub', version: '0.0.0' }));
const removePack = vi.fn(async () => undefined);
const rollbackPack = vi.fn(async () => undefined);
const listPacks = vi.fn(async () => []);
const uploadFile = vi.fn(async () => ({ success: true, documents: [], chunks_added: 5 }));

function makeElectronSession(): DesktopSession {
  const apiClient = {
    listDocuments: vi.fn(async () => ({ documents: [], total: 0 })),
    uploadFile,
    clearDocuments: vi.fn(async () => ({ status: 'cleared' })),
    listPacks,
    installPack,
    removePack,
    rollbackPack,
  } as unknown as ApiClient;
  return {
    baseUrl: 'http://127.0.0.1:4567',
    token: 'session-token',
    mode: 'node',
    apiClient,
    sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
  };
}

afterEach(() => {
  cleanup();
  delete (window as { desktopApi?: DesktopApiBridge }).desktopApi;
  vi.clearAllMocks();
});

describe('AC3 — plain documents keep using the existing pipeline', () => {
  it('Electron mode: a plain .txt upload calls uploadFile and never a pack method', async () => {
    installDesktopBridge();
    const session = makeElectronSession();
    render(
      <ToastProvider>
        <DesktopSessionProvider
          value={{ session, models: null, loading: false, error: null }}
        >
          <DocumentsPage />
        </DesktopSessionProvider>
      </ToastProvider>,
    );

    const file = new File(['hello plain doc'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(await plainDocInput(), { target: { files: [file] } });

    // The existing server upload path is used, with the exact File.
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect((uploadFile.mock.calls[0] as unknown as [File])[0].name).toBe('notes.txt');
    // The ready row appears (server round-trip acknowledged).
    await waitFor(() => expect(screen.getByText(/notes\.txt/i)).toBeTruthy());

    // No pack-install method was touched by the plain-document drop.
    expect(installPack).not.toHaveBeenCalled();
    expect(removePack).not.toHaveBeenCalled();
    expect(rollbackPack).not.toHaveBeenCalled();
  });

  it('browser mode: a plain .txt drop still enters the browser-local extraction pipeline', async () => {
    // No window.desktopApi and no session: pure browser mode.
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>,
    );

    const file = new File(['browser plain doc'], 'browser-notes.txt', {
      type: 'text/plain',
    });
    fireEvent.change(await plainDocInput(), { target: { files: [file] } });

    // The existing browser pipeline is entered (extraction is its first
    // stage); nothing about the pack surface may bypass or alter it.
    await waitFor(() => expect(extractDocument).toHaveBeenCalledWith(file));

    // And no pack method is involved in browser mode either.
    expect(installPack).not.toHaveBeenCalled();
    expect(removePack).not.toHaveBeenCalled();
    expect(rollbackPack).not.toHaveBeenCalled();
  });
});
