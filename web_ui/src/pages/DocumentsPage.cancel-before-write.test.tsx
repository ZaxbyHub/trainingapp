/**
 * Frozen check C8 (trace collated-270-273). cancel during encodeBatch writes nothing to either index (AC1 of issue #273).
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

async function uploadFiles(files: File[]): Promise<void> {
  const { render, act, waitFor } = await import('@testing-library/react');
  const { DocumentsPage } = await import('./DocumentsPage');
  render(<ToastProvider><DocumentsPage /></ToastProvider>);
  await waitFor(() =>
    expect(document.querySelector(DOCUMENT_FILE_INPUT)).toBeTruthy()
  );
  const input = document.querySelector(DOCUMENT_FILE_INPUT) as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(input, 'files', { value: files, writable: false, configurable: true });
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

describe('DocumentsPage.cancel-before-write (C8)', () => {
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


  test('cancel during encodeBatch writes nothing to either index', async () => {
    const { waitFor } = await import('@testing-library/react');
    // Park encodeBatch on a deferred; cancel while it is in flight; release.
    let release!: () => void;
    const parked = new Promise<void>((r) => { release = r; });
    let encodeEntered = false;
    mockEmbeddingService.encodeBatch.mockImplementation(async (texts: string[]) => {
      encodeEntered = true;
      await parked;
      return texts.map(() => new Array(768).fill(0));
    });

    await upload('cancelwrite.txt');
    await waitFor(() => expect(encodeEntered).toBe(true));
    await clickCancelFor('cancelwrite.txt');
    release();
    await waitFor(() => {
      const row = lastPersistedRow('cancelwrite.txt');
      expect(row?.status).toBe('error');
      expect(row?.errorMessage).toBe('Indexing cancelled');
    });

    // The canceled document never became searchable: zero index WRITES
    // (addBatch/addDocuments). removeByDocId/save calls from the terminal
    // purge are legitimate and expected.
    expect(mockVectorIndex.addBatch).not.toHaveBeenCalled();
    expect(mockKeywordIndex.addDocuments).not.toHaveBeenCalled();
  });

  test('a remote change preserves the not-yet-persisted in-flight row (PRR-005)', async () => {
    const { waitFor, act } = await import('@testing-library/react');
    // Park encodeBatch so the row stays non-terminal (processing).
    let release!: () => void;
    const parked = new Promise<void>((r) => {
      release = r;
    });
    let encodeEntered = false;
    mockEmbeddingService.encodeBatch.mockImplementation(async (texts: string[]) => {
      encodeEntered = true;
      await parked;
      return texts.map(() => new Array(768).fill(0));
    });

    await upload('inflight.txt');
    await waitFor(() => expect(encodeEntered).toBe(true));

    // Another tab commits a change. The reload sees an EMPTY persisted list:
    // this row's 500ms debounced save has not fired yet.
    const calls = mockOnDocumentsRemoteChange.mock.calls;
    const remoteCb = calls[calls.length - 1]?.[0] as (() => void) | undefined;
    expect(remoteCb).toBeTypeOf('function');
    await act(async () => {
      remoteCb!();
      await new Promise((r) => setTimeout(r, 250)); // > the 100ms coalesce window
    });

    // The row survived the reload (merge, not replace): its processing UI is
    // still mounted...
    expect(document.querySelector('button[aria-label="Cancel indexing inflight.txt"]')).toBeTruthy();

    // ...so the terminal write still finds it (PC-13 upsert) - no orphaned
    // index chunks and no lost terminal row.
    release();
    await waitFor(() => {
      expect(mockUpsertDocument).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'inflight.txt', status: 'ready' })
      );
    });
  });

  test('remote-change bursts coalesce into one reload (PRR-021)', async () => {
    const { render, act, waitFor } = await import('@testing-library/react');
    const { DocumentsPage } = await import('./DocumentsPage');
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );
    await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalled());

    const before = mockLoadDocuments.mock.calls.length;
    const calls = mockOnDocumentsRemoteChange.mock.calls;
    const remoteCb = calls[calls.length - 1]?.[0] as (() => void) | undefined;
    expect(remoteCb).toBeTypeOf('function');
    await act(async () => {
      remoteCb!();
      remoteCb!();
      remoteCb!();
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(mockLoadDocuments.mock.calls.length).toBe(before + 1);
  });

  test('a remote change keeps QUEUED upload rows that have no cancel controller yet (PRR-005)', async () => {
    const { waitFor, act } = await import('@testing-library/react');
    // Park encodeBatch so file 1 blocks the sequential processFile loop while
    // file 2's row sits QUEUED (added upfront, no controller until its turn).
    let release!: () => void;
    const parked = new Promise<void>((r) => {
      release = r;
    });
    let encodeEntered = false;
    mockEmbeddingService.encodeBatch.mockImplementation(async (texts: string[]) => {
      encodeEntered = true;
      await parked;
      return texts.map(() => new Array(768).fill(0));
    });

    await uploadFiles([
      new File(['first content'], 'first.txt', { type: 'text/plain' }),
      new File(['second content'], 'second.txt', { type: 'text/plain' }),
    ]);
    await waitFor(() => expect(encodeEntered).toBe(true));
    // Both rows were added upfront; second.txt is queued (no controller).
    expect(document.body.textContent).toContain('first.txt');
    expect(document.body.textContent).toContain('second.txt');

    const calls = mockOnDocumentsRemoteChange.mock.calls;
    const remoteCb = calls[calls.length - 1]?.[0] as (() => void) | undefined;
    expect(remoteCb).toBeTypeOf('function');
    await act(async () => {
      remoteCb!();
      await new Promise((r) => setTimeout(r, 250)); // > the 100ms coalesce window
    });

    // The QUEUED row survived the reload (the pre-fix controller gate dropped
    // it), and the processing row's cancel control is still mounted.
    expect(document.body.textContent).toContain('second.txt');
    expect(document.querySelector('button[aria-label="Cancel indexing first.txt"]')).toBeTruthy();

    // Release: file 1 settles, then file 2 runs — its terminal upsert finds
    // the row, proving no orphaned chunks (the pre-fix drop made readyRow
    // undefined, so this upsert never fired).
    release();
    await waitFor(() => {
      expect(mockUpsertDocument).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'second.txt', status: 'ready' })
      );
    });
  });
});
