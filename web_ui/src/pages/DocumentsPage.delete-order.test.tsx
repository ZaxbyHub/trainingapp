/**
 * Frozen check C10 (trace collated-270-273). delete removes indexes BEFORE the row and fails closed on removal failure or a not-ready index (AC3).
 *
 * RED/ERROR at base (spec absent), GREEN after the fix.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';

const showToastSpy = vi.fn();
vi.mock('../components/ToastProvider', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useToast: () => ({ showToast: showToastSpy }),
}));
import { ToastProvider } from '../components/ToastProvider';
import { cleanup } from '@testing-library/react';

const mockEmbeddingService = {
  isReady: vi.fn(() => true),
  encodeBatch: vi.fn(async (texts: string[]) => texts.map(() => new Array(768).fill(0))),
};
const mockVectorIndex = {
  isReady: vi.fn(() => true),
  initialize: vi.fn(async () => {}),
  addBatch: vi.fn(async () => {}),
  save: vi.fn(async () => {}),
  removeByDocId: vi.fn(async (_docId: string) => {}),
};
const mockKeywordIndex = {
  isReady: vi.fn(() => true),
  addDocuments: vi.fn((_chunks: unknown[]) => {}),
  save: vi.fn(async () => {}),
  removeByDocId: vi.fn((_docId: string) => {}),
};
const mockLoadDocuments = vi.fn(async () => [] as Array<{ id: string; fileName: string; status: string; uploadedAt: number; progress: number; fileSize: number; fileType: string }>);
const mockSaveDocuments = vi.fn(async () => {});
const mockDeleteDocumentFromStore = vi.fn(async () => {});
const mockUpsertDocument = vi.fn(async () => {});
const mockOnDocumentsRemoteChange = vi.fn((_cb: () => void) => () => {});
const mockEnsureEmbeddingServiceReady = vi.fn(async () => true);

vi.mock('../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: () => mockEnsureEmbeddingServiceReady(),
}));
vi.mock('../lib/processing/text-chunker', () => ({
  TextChunker: class TextChunker {
    chunkText(_fullText: string, _fileName: string, _pages?: unknown) {
      return [
        { docId: '', chunkIndex: 0, text: 'This is test document content', pageNumber: 1, startChar: 0, endChar: 35 },
        { docId: '', chunkIndex: 1, text: 'with multiple chunks.', pageNumber: 1, startChar: 36, endChar: 53 },
      ];
    }
  },
}));
vi.mock('../lib/embeddings/embedding-service', () => ({
  getEmbeddingService: () => mockEmbeddingService,
}));
vi.mock('../lib/search/vector-index', () => ({
  getVectorIndex: () => mockVectorIndex,
}));
vi.mock('../lib/search/keyword-index', () => ({
  getKeywordIndex: () => mockKeywordIndex,
}));
vi.mock('../lib/storage/document-store', () => ({
  loadDocuments: mockLoadDocuments,
  saveDocuments: mockSaveDocuments,
  upsertDocument: mockUpsertDocument,
  deleteDocument: mockDeleteDocumentFromStore,
  onDocumentsRemoteChange: mockOnDocumentsRemoteChange,
}));
vi.mock('../lib/processing/extractor-factory', () => ({
  extractDocument: vi.fn(async () => ({
    fullText: 'This is test document content with multiple chunks.',
    pages: 1,
    metadata: {},
  })),
  SUPPORTED_EXTENSIONS: ['.txt', '.pdf', '.docx'],
}));

const DOCUMENT_FILE_INPUT = 'input[type="file"]:not([data-testid="pack-install-input"])';

async function upload(fileName: string): Promise<void> {
  const { render, act, waitFor } = await import('@testing-library/react');
  const { DocumentsPage } = await import('./DocumentsPage');
  render(<ToastProvider><DocumentsPage /></ToastProvider>);
  await waitFor(() =>
    expect(document.querySelector(DOCUMENT_FILE_INPUT)).toBeTruthy()
  );
  const file = new File(['spec content'], fileName, { type: 'text/plain' });
  const input = document.querySelector(DOCUMENT_FILE_INPUT) as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], writable: false, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function clickCancelFor(fileName: string): Promise<void> {
  const { act } = await import('@testing-library/react');
  const button = document.querySelector(
    `button[aria-label="Cancel indexing ${fileName}"]`
  ) as HTMLButtonElement | null;
  expect(button).toBeTruthy();
  await act(async () => {
    button!.click();
  });
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function lastPersistedRow(
  fileName: string
): { status?: string; errorMessage?: string } | undefined {
  // The terminal row is persisted immediately through the per-document
  // production path (upsert); the debounced bulk save lags behind it.
  const ups = mockUpsertDocument.mock.calls as unknown as Array<
    [{ id?: string; fileName?: string; status?: string; errorMessage?: string }]
  >;
  for (let i = ups.length - 1; i >= 0; i--) {
    const row = ups[i]?.[0];
    if (row?.fileName === fileName) return row;
  }
  const calls = mockSaveDocuments.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const list = (calls[i] as unknown as Array<{ fileName: string; status: string; errorMessage?: string }> | undefined);
    const row = list?.find((d) => d.fileName === fileName);
    if (row) return row;
  }
  return undefined;
}

describe('DocumentsPage.delete-order (C10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureEmbeddingServiceReady.mockResolvedValue(true);
    mockEmbeddingService.isReady.mockReturnValue(true);
    mockVectorIndex.isReady.mockReturnValue(true);
    mockKeywordIndex.isReady.mockReturnValue(true);
    // navigator.storage is undefined in jsdom by default; C12 tests install it.
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(navigator, 'storage');
  });


  test('delete removes indexes before the row', async () => {
    const { waitFor, act } = await import('@testing-library/react');
    mockLoadDocuments.mockResolvedValue([
      { id: 'doc-del', fileName: 'del.txt', status: 'ready', uploadedAt: 1, progress: 100, fileSize: 5, fileType: 'txt' },
    ]);
    const { DocumentsPage } = await import('./DocumentsPage');
    const { render } = await import('@testing-library/react');
    render(<ToastProvider><DocumentsPage /></ToastProvider>);
    await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalled());

    // Two-step delete: arm the inline confirm, then confirm.
    const delBtn = document.querySelector('button[aria-label="Delete del.txt"]') as HTMLButtonElement | null;
    expect(delBtn).toBeTruthy();
    await act(async () => { delBtn!.click(); });
    const confirmBtn = document.querySelector('button[aria-label="Confirm delete del.txt"]') as HTMLButtonElement | null;
    expect(confirmBtn).toBeTruthy();
    await act(async () => { confirmBtn!.click(); });

    await waitFor(() => expect(mockDeleteDocumentFromStore).toHaveBeenCalledWith('doc-del'));
    const vectorOrder = mockVectorIndex.removeByDocId.mock.invocationCallOrder[0];
    const keywordOrder = mockKeywordIndex.removeByDocId.mock.invocationCallOrder[0];
    const rowOrder = mockDeleteDocumentFromStore.mock.invocationCallOrder[0];
    expect(vectorOrder).toBeLessThan(rowOrder);
    expect(keywordOrder).toBeLessThan(rowOrder);
  });

  test('delete keeps the row when index removal fails', async () => {
    const { waitFor, act } = await import('@testing-library/react');
    mockLoadDocuments.mockResolvedValue([
      { id: 'doc-keep', fileName: 'keep.txt', status: 'ready', uploadedAt: 1, progress: 100, fileSize: 5, fileType: 'txt' },
    ]);
    mockVectorIndex.removeByDocId.mockRejectedValueOnce(new Error('removal failed'));
    const { DocumentsPage } = await import('./DocumentsPage');
    const { render } = await import('@testing-library/react');
    render(<ToastProvider><DocumentsPage /></ToastProvider>);
    await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalled());

    const delBtn = document.querySelector('button[aria-label="Delete keep.txt"]') as HTMLButtonElement | null;
    expect(delBtn).toBeTruthy();
    await act(async () => { delBtn!.click(); });
    const confirmBtn = document.querySelector('button[aria-label="Confirm delete keep.txt"]') as HTMLButtonElement | null;
    expect(confirmBtn).toBeTruthy();
    await act(async () => { confirmBtn!.click(); });

    await waitFor(() => {
      expect(showToastSpy.mock.calls.some(([, type]) => type === 'error')).toBe(true);
    });
    // fail closed: the row was NOT deleted
    expect(mockDeleteDocumentFromStore).not.toHaveBeenCalledWith('doc-keep');
  });

  test('delete fails closed when an index is not ready', async () => {
    const { waitFor, act } = await import('@testing-library/react');
    mockLoadDocuments.mockResolvedValue([
      { id: 'doc-nr', fileName: 'notready.txt', status: 'ready', uploadedAt: 1, progress: 100, fileSize: 5, fileType: 'txt' },
    ]);
    mockVectorIndex.isReady.mockReturnValue(false);
    const { DocumentsPage } = await import('./DocumentsPage');
    const { render } = await import('@testing-library/react');
    render(<ToastProvider><DocumentsPage /></ToastProvider>);
    await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalled());

    const delBtn = document.querySelector('button[aria-label="Delete notready.txt"]') as HTMLButtonElement | null;
    expect(delBtn).toBeTruthy();
    await act(async () => { delBtn!.click(); });
    const confirmBtn = document.querySelector('button[aria-label="Confirm delete notready.txt"]') as HTMLButtonElement | null;
    expect(confirmBtn).toBeTruthy();
    await act(async () => { confirmBtn!.click(); });

    await waitFor(() => {
      expect(showToastSpy.mock.calls.some(([, type]) => type === 'error')).toBe(true);
    });
    expect(mockVectorIndex.removeByDocId).not.toHaveBeenCalled();
    expect(mockDeleteDocumentFromStore).not.toHaveBeenCalledWith('doc-nr');
  });

});
