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

  test('a foreign interrupted row imports recovered and never resurrects after a remote delete (PRR-005 Q1)', async () => {
    const { render, act, waitFor } = await import('@testing-library/react');
    // Mount empty; reload 1 imports another crashed tab's raw 'processing'
    // row; reload 2 reflects that the other tab deleted it.
    mockLoadDocuments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'doc-zombie',
          fileName: 'zombie.txt',
          status: 'processing',
          uploadedAt: 5,
          progress: 40,
          fileSize: 5,
          fileType: 'txt',
        },
      ] as never)
      .mockResolvedValueOnce([]);
    const { DocumentsPage } = await import('./DocumentsPage');
    render(<ToastProvider><DocumentsPage /></ToastProvider>);
    await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalled());

    const calls = mockOnDocumentsRemoteChange.mock.calls;
    const remoteCb = calls[calls.length - 1]?.[0] as (() => void) | undefined;
    expect(remoteCb).toBeTypeOf('function');

    // Import: the raw processing row arrives RECOVERED (mount recovery
    // mirrored), never stuck on 'processing'.
    await act(async () => {
      remoteCb!();
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(document.body.textContent).toContain('zombie.txt');
    expect(document.body.textContent).toContain('Processing was interrupted');

    // Persistence-level proof (reviewer round-3 Q2): wait out the 500ms
    // debounce while the recovered copy is still in state — no save may
    // re-put it (the suppression closes the save-vs-delete race).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    for (const call of mockSaveDocuments.mock.calls) {
      const list = (call as unknown as [Array<{ fileName?: string }>])[0];
      expect(list.some((d) => d.fileName === 'zombie.txt')).toBe(false);
    }

    // The other tab deletes it: the reload must NOT retain the row (only
    // queued/processing rows THIS tab owns are kept; the recovered copy is
    // 'error'), so the debounced save can never re-put it.
    await act(async () => {
      remoteCb!();
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(document.body.textContent).not.toContain('zombie.txt');
  });

  test('a QUEUED own row persisted by the bulk save is not recovered as an interruption (round-3 Finding 1)', async () => {
    const { render, act, waitFor } = await import('@testing-library/react');
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

    // Mount empty; the reload after the upload returns the QUEUED row's own
    // persisted copy (the 500ms bulk save persisted it during file 1's gap —
    // it still has NO controller).
    mockLoadDocuments.mockResolvedValueOnce([]);
    await uploadFiles([
      new File(['first content'], 'own-first.txt', { type: 'text/plain' }),
      new File(['second content'], 'own-second.txt', { type: 'text/plain' }),
    ]);
    await waitFor(() => expect(encodeEntered).toBe(true));

    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-doc-id]')).find((el) =>
      (el.textContent ?? '').includes('own-second.txt')
    );
    expect(row).toBeTruthy();
    const rowId = row?.dataset.docId as string;
    mockLoadDocuments.mockResolvedValueOnce([
      {
        id: rowId,
        fileName: 'own-second.txt',
        status: 'uploading',
        uploadedAt: 11,
        progress: 0,
        fileSize: 5,
        fileType: 'txt',
      },
    ] as never);

    const calls = mockOnDocumentsRemoteChange.mock.calls;
    const remoteCb = calls[calls.length - 1]?.[0] as (() => void) | undefined;
    expect(remoteCb).toBeTypeOf('function');
    await act(async () => {
      remoteCb!();
      await new Promise((r) => setTimeout(r, 250));
    });

    // OWNED: this tab's live queue copy is served — never a false
    // 'interrupted' error (the round-5 controller-only split stamped it).
    expect(document.body.textContent).toContain('own-second.txt');
    expect(document.body.textContent).not.toContain('Processing was interrupted');

    release();
    await waitFor(() => {
      expect(mockUpsertDocument).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'own-second.txt', status: 'ready' })
      );
    });
  });

  test('remote reloads are serialized: a reload burst never runs two loads concurrently (page single-flight)', async () => {
    const { render, act, waitFor } = await import('@testing-library/react');
    let loadCalls = 0;
    let releaseFirstReload!: () => void;
    const firstReloadHold = new Promise<void>((r) => {
      releaseFirstReload = r;
    });
    let releaseDrainReload!: () => void;
    const drainReloadHold = new Promise<void>((r) => {
      releaseDrainReload = r;
    });
    let holdWhich: 'first' | 'drain' | null = null;
    mockLoadDocuments.mockImplementation(async () => {
      loadCalls += 1;
      if (holdWhich === 'first') {
        holdWhich = null;
        await firstReloadHold;
      } else if (holdWhich === 'drain') {
        holdWhich = null;
        await drainReloadHold;
      }
      return [];
    });

    const { DocumentsPage } = await import('./DocumentsPage');
    render(<ToastProvider><DocumentsPage /></ToastProvider>);
    await waitFor(() => expect(loadCalls).toBe(1)); // mount load

    const calls = mockOnDocumentsRemoteChange.mock.calls;
    const remoteCb = calls[calls.length - 1]?.[0] as (() => void) | undefined;
    expect(remoteCb).toBeTypeOf('function');

    holdWhich = 'first';
    await act(async () => {
      remoteCb!(); // announcement 1 -> reload #1 starts
    });
    await waitFor(() => expect(loadCalls).toBe(2)); // held open inside the mock

    await act(async () => {
      remoteCb!(); // announcement 2 arrives WHILE reload #1 is held
      await new Promise((r) => setTimeout(r, 250)); // past its debounce too
    });
    // Serialized: reload #2 must be QUEUED, not started (the timer-only
    // coalescer would start it concurrently with the held reload #1).
    expect(loadCalls).toBe(2);

    // Drain edge (reviewer round-4c Finding): hold the DRAINED trailing run
    // too — if the drain bypassed the guard, a later timer would start a
    // concurrent load right here.
    holdWhich = 'drain';
    releaseFirstReload();
    await waitFor(() => expect(loadCalls).toBe(3)); // drain enters loadDocuments

    await act(async () => {
      remoteCb!(); // announcement 3 during the DRAINED run
      await new Promise((r) => setTimeout(r, 250));
    });
    // The drained run is still guarded: no third concurrent load.
    expect(loadCalls).toBe(3);

    releaseDrainReload();
    // The queued trailing reload ran after the drained run settled.
    await waitFor(() => expect(loadCalls).toBe(4));
  });

  test('a queued reload does not run after unmount (teardown flag)', async () => {
    const { render, act, waitFor } = await import('@testing-library/react');
    let loadCalls = 0;
    let releaseFirstReload!: () => void;
    const firstReloadHold = new Promise<void>((r) => {
      releaseFirstReload = r;
    });
    let holdNextReload = false;
    mockLoadDocuments.mockImplementation(async () => {
      loadCalls += 1;
      if (holdNextReload) {
        holdNextReload = false;
        await firstReloadHold;
      }
      return [];
    });

    const { DocumentsPage } = await import('./DocumentsPage');
    const view = render(<ToastProvider><DocumentsPage /></ToastProvider>);
    await waitFor(() => expect(loadCalls).toBe(1)); // mount load

    const calls = mockOnDocumentsRemoteChange.mock.calls;
    const remoteCb = calls[calls.length - 1]?.[0] as (() => void) | undefined;
    expect(remoteCb).toBeTypeOf('function');

    holdNextReload = true;
    await act(async () => {
      remoteCb!(); // reload #1 starts
    });
    await waitFor(() => expect(loadCalls).toBe(2)); // held open inside the mock

    await act(async () => {
      remoteCb!(); // announcement 2 -> queued drain pending
      await new Promise((r) => setTimeout(r, 250)); // absence needs a window
    });
    expect(loadCalls).toBe(2);

    // Unmount with a queued drain pending: the cleanup flag must stop it.
    await act(async () => {
      view.unmount();
      releaseFirstReload!();
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(loadCalls).toBe(2);
    expect(view.container.textContent).toBe('');
  });
});
