/**
 * Frozen check C2 (trace collated-275-268, AC2 of issue #275).
 *
 * Deleting an accepted-but-not-yet-started (queued) row while an earlier
 * file of the same batch is still processing must leave both search indexes
 * without any entry for the deleted row's docId and must never persist a
 * row for it afterwards. At base the sequential ingest loop
 * (DocumentsPage.tsx:968 `await processFile(file, entry.id)`) never
 * re-checks ownership, so the deleted file's chunks are indexed through both
 * indexes while the terminal upsert is gated off (:707) - permanently
 * searchable content with no library row.
 *
 * Determinism: file 1's processing is parked inside its vector-index save
 * (a test-controlled deferred, no wall-clock sleeps); file 2 is still queued
 * at that point, so its delete lands before the loop reaches its turn.
 *
 * RED at base (chunks for the deleted file are indexed), GREEN after the fix.
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
  // The chunk text/source carry the FILE NAME so the spec can tell which
  // file's chunks reached which index without touching generated doc ids.
  TextChunker: class TextChunker {
    chunkText(_fullText: string, fileName: string, _pages?: unknown) {
      return [
        { docId: '', chunkIndex: 0, text: `${fileName} chunk zero`, source: fileName, pageNumber: 1, startChar: 0, endChar: 20 },
        { docId: '', chunkIndex: 1, text: `${fileName} chunk one`, source: fileName, pageNumber: 1, startChar: 21, endChar: 40 },
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

async function uploadTwoFiles(first: string, second: string): Promise<void> {
  const { render, act, waitFor } = await import('@testing-library/react');
  const { DocumentsPage } = await import('./DocumentsPage');
  render(<ToastProvider><DocumentsPage /></ToastProvider>);
  await waitFor(() =>
    expect(document.querySelector(DOCUMENT_FILE_INPUT)).toBeTruthy()
  );
  const fileA = new File(['first file spec content'], first, { type: 'text/plain' });
  const fileB = new File(['second file different sized content'], second, { type: 'text/plain' });
  const input = document.querySelector(DOCUMENT_FILE_INPUT) as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [fileA, fileB], writable: false, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function confirmDeleteFor(fileName: string): Promise<void> {
  const { act } = await import('@testing-library/react');
  const delBtn = document.querySelector(
    `button[aria-label="Delete ${fileName}"]`
  ) as HTMLButtonElement | null;
  expect(delBtn).toBeTruthy();
  await act(async () => { delBtn!.click(); });
  const confirmBtn = document.querySelector(
    `button[aria-label="Confirm delete ${fileName}"]`
  ) as HTMLButtonElement | null;
  expect(confirmBtn).toBeTruthy();
  await act(async () => { confirmBtn!.click(); });
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function settle(): Promise<void> {
  const { act } = await import('@testing-library/react');
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      await flush();
    }
  });
}

function lastPersistedRow(
  fileName: string
): { status?: string; errorMessage?: string } | undefined {
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

/** Any vector-index entry belonging to the given file (by source/text). */
function vectorEntriesFor(fileName: string): number {
  let count = 0;
  for (const call of mockVectorIndex.addBatch.mock.calls) {
    const entries = (call as unknown as [Array<{ source?: string; text?: string }>])[0] ?? [];
    for (const entry of entries) {
      if (entry.source === fileName || (entry.text ?? '').includes(fileName)) count++;
    }
  }
  return count;
}

/** Any keyword-index chunk belonging to the given file (by source/text). */
function keywordChunksFor(fileName: string): number {
  let count = 0;
  for (const call of mockKeywordIndex.addDocuments.mock.calls) {
    const chunks = (call as unknown as [Array<{ source?: string; text?: string }>])[0] ?? [];
    for (const chunk of chunks) {
      if (chunk.source === fileName || (chunk.text ?? '').includes(fileName)) count++;
    }
  }
  return count;
}

describe('DocumentsPage.queued-delete (C2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureEmbeddingServiceReady.mockResolvedValue(true);
    mockEmbeddingService.isReady.mockReturnValue(true);
    mockVectorIndex.isReady.mockReturnValue(true);
    mockKeywordIndex.isReady.mockReturnValue(true);
    // navigator.storage is undefined in jsdom by default; sibling suites
    // install it for the persistence gate - this spec does not need it.
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(navigator, 'storage');
  });

  test('deleting a queued row during an earlier file\u2019s processing never indexes or persists it', async () => {
    const { waitFor } = await import('@testing-library/react');

    // Park file 1's processing inside its vector-index save; file 2 is queued
    // behind it (the sequential loop has not started it yet).
    let releaseFirstSave!: () => void;
    let firstSaveParked = false;
    mockVectorIndex.save.mockImplementationOnce(async () => {
      firstSaveParked = true;
      await new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    });

    await uploadTwoFiles('first.txt', 'second.txt');
    await waitFor(() => expect(firstSaveParked).toBe(true));

    // second.txt is accepted-but-not-started: no in-flight promise exists for
    // its docId, so this delete only purges (nothing indexed yet) and drops
    // the row - exactly the queued-delete trigger of issue #275 item 2.
    await confirmDeleteFor('second.txt');
    await waitFor(() => expect(mockDeleteDocumentFromStore).toHaveBeenCalledTimes(1));
    // Snapshot persistence call counts at delete completion: the accept-time
    // debounced bulk save may legitimately still carry the queued row from
    // BEFORE the delete (it is cancelled by the delete's state change), so
    // "never persists afterwards" is asserted on calls from here on.
    const bulkSavesAtDelete = mockSaveDocuments.mock.calls.length;

    // Let file 1 finish and the loop reach (and at base, run) file 2's turn.
    releaseFirstSave();
    await waitFor(() => {
      const row = lastPersistedRow('first.txt');
      expect(row?.status).toBe('ready');
    });
    await settle();

    // The deleted file's chunks must be in NEITHER index.
    expect(vectorEntriesFor('second.txt')).toBe(0);
    expect(keywordChunksFor('second.txt')).toBe(0);

    // And no row for it is ever persisted: the per-document upsert path never
    // carried it (the terminal upsert is gated on the row's presence), and no
    // bulk save AFTER the delete re-creates it.
    for (const call of mockUpsertDocument.mock.calls as unknown as Array<
      [{ fileName?: string }]
    >) {
      expect(call[0]?.fileName).not.toBe('second.txt');
    }
    const bulkSavesAfterDelete = mockSaveDocuments.mock.calls.slice(bulkSavesAtDelete);
    for (const call of bulkSavesAfterDelete as unknown as Array<
      [Array<{ fileName: string }>]
    >) {
      expect((call[0] ?? []).some((row) => row.fileName === 'second.txt')).toBe(false);
    }

    // Control: the surviving file WAS indexed and completed ready, so the
    // assertions above cannot pass vacuously.
    expect(vectorEntriesFor('first.txt')).toBeGreaterThan(0);
    expect(keywordChunksFor('first.txt')).toBeGreaterThan(0);
  });
});
