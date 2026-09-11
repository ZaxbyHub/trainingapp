/**
 * B9 (issue #67) — AC2: under Electron, document upload/list/delete go
 * through `apiClient` (the desktop backend), NOT `document-store.ts`.
 *
 * The page consumes the session via `useDesktopSession`, so this suite wraps
 * `DocumentsPage` in a `DesktopSessionProvider` carrying a stub session whose
 * `apiClient` is a spy. `isElectron()` is forced true by exposing
 * `window.desktopApi`, and the browser-local storage/index modules are mocked
 * so any accidental call fails the test loudly (asserted explicitly below).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DocumentsPage } from './DocumentsPage';
import { ToastProvider } from '../components/ToastProvider';
import { DesktopSessionProvider, type DesktopSession } from '../lib/desktop-session';
import type { DesktopApiBridge } from '../types/desktop';
import type { ApiClient } from '../lib/api';

vi.mock('../lib/storage/document-store', () => ({
  loadDocuments: vi.fn(async () => []),
  saveDocuments: vi.fn(),
  deleteDocument: vi.fn(),
}));
vi.mock('../lib/storage/profile', () => ({
  migrateOrphanedNamespaces: vi.fn(async () => undefined),
  getProfilePrefix: vi.fn(() => 'testprfx'),
}));
// AC2's whole point: the browser-local pipeline must never even LOAD in
// Electron mode. Mocking these modules enforces that structurally — any
// static side effect (edgevec WASM import, transformers.js) or runtime call
// would either fail the suite or be caught by the not-called assertions.
const seenEvents: string[] = [];
const documentsChangedListener = (e: Event): void => {
  seenEvents.push(e.type);
};
vi.mock('../lib/search/vector-index', () => ({ getVectorIndex: vi.fn() }));
vi.mock('../lib/search/keyword-index', () => ({ getKeywordIndex: vi.fn() }));
vi.mock('../lib/embeddings/embedding-service', () => ({ getEmbeddingService: vi.fn() }));
vi.mock('../lib/processing/extractor-factory', () => ({
  extractDocument: vi.fn(),
  SUPPORTED_EXTENSIONS: ['.pdf', '.txt'],
}));
vi.mock('../lib/processing/text-chunker', () => ({ TextChunker: vi.fn() }));
vi.mock('../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: vi.fn(async () => true),
}));

import { loadDocuments, saveDocuments, deleteDocument } from '../lib/storage/document-store';

const mockStore = { loadDocuments, saveDocuments, deleteDocument };

function makeSession(overrides: {
  listDocuments?: ReturnType<typeof vi.fn>;
  uploadFile?: ReturnType<typeof vi.fn>;
  clearDocuments?: ReturnType<typeof vi.fn>;
}): DesktopSession {
  const apiClient = {
    listDocuments:
      overrides.listDocuments ??
      vi.fn(async () => ({
        documents: [{ id: 'C:/docs/manual.pdf', chunk_count: 12 }],
        total: 1,
      })),
    uploadFile:
      overrides.uploadFile ??
      vi.fn(async () => ({ success: true, documents: [], chunks_added: 7 })),
    clearDocuments: overrides.clearDocuments ?? vi.fn(async () => ({ status: 'cleared' })),
  } as unknown as ApiClient;
  return {
    baseUrl: 'http://127.0.0.1:4567',
    token: 'session-token',
    mode: 'node',
    apiClient,
    sseUrl: () => 'http://127.0.0.1:4567/ask/stream',
  };
}

function renderWithSession(session: DesktopSession) {
  return render(
    <ToastProvider>
      <DesktopSessionProvider
        value={{ session, models: null, loading: false, error: null }}
      >
        <DocumentsPage />
      </DesktopSessionProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  seenEvents.length = 0;
  window.addEventListener('documents-changed', documentsChangedListener);
  (window as { desktopApi?: DesktopApiBridge }).desktopApi = {
    getAuthToken: vi.fn(async () => 't'),
    getBackendInfo: vi.fn(async () => ({ mode: 'node', port: 1, url: 'http://127.0.0.1:1' })),
  };
  vi.mocked(window.fetch ?? fetch).mockRestore?.();
});

afterEach(() => {
  cleanup();
  window.removeEventListener('documents-changed', documentsChangedListener);
  delete (window as { desktopApi?: DesktopApiBridge }).desktopApi;
  vi.clearAllMocks();
});

describe('DocumentsPage — Electron mode (AC2)', () => {
  it('LIST reads from the backend via apiClient, never document-store', async () => {
    const session = makeSession({});
    renderWithSession(session);
    await waitFor(() => expect(screen.getByText(/manual\.pdf/i)).toBeTruthy());
    expect(session.apiClient.listDocuments).toHaveBeenCalledTimes(1);
    expect(mockStore.loadDocuments).not.toHaveBeenCalled();
  });

  it('UPLOAD round-trips through apiClient.uploadFile (not the browser pipeline)', async () => {
    seenEvents.length = 0;
    const listDocuments = vi.fn(async () => ({ documents: [], total: 0 }));
    const uploadFile = vi.fn(async () => ({ success: true, documents: [], chunks_added: 5 }));
    renderWithSession(makeSession({ listDocuments, uploadFile }));

    const input = await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    });
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadFile).toHaveBeenCalled());
    // C-7: same-tab count refresh — the page signals useDocumentCount.
    await waitFor(() => expect(seenEvents).toContain('documents-changed'));
    expect((uploadFile.mock.calls[0] as unknown as [File])[0].name).toBe('notes.txt');
    // The ready row shows the server-side chunk count from the upload response.
    await waitFor(() => expect(screen.getByText(/notes\.txt/i)).toBeTruthy());
    // Browser-local ingestion modules must never be touched.
    expect(mockStore.saveDocuments).not.toHaveBeenCalled();
  });

  it('DELETE is clear-all via the header button (no per-document delete in the contract)', async () => {
    const clearDocuments = vi.fn(async () => ({ status: 'cleared' }));
    const listDocuments = vi.fn(async () => ({
      documents: [{ id: 'C:/docs/manual.pdf', chunk_count: 12 }],
      total: 1,
    }));
    renderWithSession(makeSession({ listDocuments, clearDocuments }));
    await waitFor(() => expect(screen.getByText(/manual\.pdf/i)).toBeTruthy());

    // Per-document delete buttons are NOT rendered in Electron mode.
    expect(screen.queryByLabelText(/delete manual\.pdf/i)).toBeNull();

    // Two-step clear-all confirm, then the backend was cleared + re-listed.
    fireEvent.click(screen.getByLabelText('Clear all documents'));
    fireEvent.click(screen.getByLabelText('Confirm clear all documents'));
    await waitFor(() => expect(clearDocuments).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(seenEvents).toContain('documents-changed'));
    expect(listDocuments).toHaveBeenCalledTimes(2);
    expect(mockStore.deleteDocument).not.toHaveBeenCalled();
  });
});
