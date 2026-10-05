/**
 * DocumentsPage.tabs-defer.test.tsx — Lumen phase 6 review L5: a mixed bulk
 * drop (a training .zip plus documents) installs the pack first and then uploads
 * the documents. The automatic switch to the "Training packs" tab must wait for
 * the whole drop to finish instead of swapping the Documents tab away mid-upload.
 * A manual tab change supersedes a pending deferral (review L1), and the header
 * Upload action opens the document picker from either tab (review L2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../components/ToastProvider';
import type { PackInfo } from '../lib/api';

vi.mock('../lib/desktop-session', () => ({
  useDesktopSession: () => ({ session: null }),
  isElectron: () => false,
}));
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
  getKeywordIndex: vi.fn(() => ({ addDocuments: () => {}, save: async () => {}, isReady: () => false })),
}));
vi.mock('../lib/embeddings/embedding-service', () => ({
  getEmbeddingService: vi.fn(() => ({ isReady: () => false })),
}));
const extraction = vi.hoisted(() => ({
  // The most recent extraction, and every extraction by file name (two drops can be in flight).
  release: null as null | (() => void),
  byName: new Map<string, () => void>(),
}));
vi.mock('../lib/processing/extractor-factory', () => ({
  // Held open until the test releases it: the document upload is "in flight".
  extractDocument: vi.fn(
    (file: File) =>
      new Promise((resolve) => {
        extraction.release = () => resolve({ fullText: 'plain text body', pages: undefined });
        extraction.byName.set(file.name, extraction.release);
      })
  ),
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
  ensureEmbeddingServiceReady: vi.fn(async () => false),
}));

const store = vi.hoisted(() => ({ packs: [] as PackInfo[], listeners: new Set<() => void>() }));
const install = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'reject' | 'install-then-reject',
  // When set, installPack waits on it (lets a test move the user before the pack lands).
  hold: null as null | Promise<void>,
}));
const packClient = vi.hoisted(() => ({
  kind: 'browser',
  listPacks: async () => [...store.packs],
  installPack: async () => {
    if (install.hold !== null) await install.hold;
    if (install.mode === 'reject') throw new Error('boom');
    store.packs.push({
      packId: 'course-a',
      version: '1.0.0',
      name: 'Course A',
      sourceClass: 'training',
      publishedAt: null,
      active: true,
      supersedes: [],
    });
    store.listeners.forEach((fn) => fn());
    if (install.mode === 'install-then-reject') throw new Error('post-install failure');
    return { packId: 'course-a', version: '1.0.0' };
  },
  removePack: async () => undefined,
  rollbackPack: async () => undefined,
  subscribe: (fn: () => void) => {
    store.listeners.add(fn);
    return () => store.listeners.delete(fn);
  },
}));
vi.mock('../lib/packs/pack-client', () => ({ usePackClient: () => packClient }));

import { DocumentsPage } from './DocumentsPage';

afterEach(() => {
  cleanup();
  store.packs = [];
  store.listeners.clear();
  extraction.release = null;
  extraction.byName.clear();
  install.mode = 'ok';
  install.hold = null;
  vi.restoreAllMocks();
});

describe('Documents tabs: no switch mid-drop (review L5)', () => {
  it('switches to Training packs only after the mixed drop finished uploading', async () => {
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );
    await screen.findByTestId('packs-panel');
    const documentsTab = screen.getByRole('tab', { name: 'Documents' });
    const trainingTab = screen.getByRole('tab', { name: 'Training packs' });

    const zip = new File([new Uint8Array([1, 2, 3])], 'course-a.zip', { type: 'application/zip' });
    const doc = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByRole('button', { name: /drop files here or click to select/i }), {
      dataTransfer: { files: [zip, doc] },
    });

    // The pack installed and its row was listed while the document upload is still open...
    await waitFor(() => expect(extraction.release).not.toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(store.packs).toHaveLength(1);
    // ...yet the Documents tab stays put.
    expect(documentsTab).toHaveAttribute('aria-selected', 'true');
    expect(trainingTab).toHaveAttribute('aria-selected', 'false');

    // The upload finishes (here at its embedding-not-ready terminal state): now it switches.
    await act(async () => extraction.release?.());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByTestId('pack-row-course-a-1.0.0')).toBeTruthy();
  });

  it('a failing install does not stick the deferral: the counter returns to 0 and a later pack switches at once (N2)', async () => {
    install.mode = 'reject';
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );
    await screen.findByTestId('packs-panel');
    const zip = new File([new Uint8Array([1, 2, 3])], 'course-a.zip', { type: 'application/zip' });
    // Zip-only drop whose install rejects: nothing installed, nothing to switch to.
    fireEvent.drop(screen.getByRole('button', { name: /drop files here or click to select/i }), {
      dataTransfer: { files: [zip] },
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(store.packs).toHaveLength(0);
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');

    // The drop finished (counter back to 0): a pack that appears now switches
    // immediately rather than waiting on a stuck in-flight drop.
    install.mode = 'ok';
    await act(async () => {
      await packClient.installPack();
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('aria-selected', 'true'));
  });

  it('an install that rejects after the pack landed still switches once the drop finished (N2)', async () => {
    install.mode = 'install-then-reject';
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );
    await screen.findByTestId('packs-panel');
    const zip = new File([new Uint8Array([1, 2, 3])], 'course-a.zip', { type: 'application/zip' });
    const doc = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByRole('button', { name: /drop files here or click to select/i }), {
      dataTransfer: { files: [zip, doc] },
    });
    await waitFor(() => expect(extraction.release).not.toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(store.packs).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');

    await act(async () => extraction.release?.());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('aria-selected', 'true'));
  });
});

const renderPage = async () => {
  render(
    <ToastProvider>
      <DocumentsPage />
    </ToastProvider>
  );
  await screen.findByTestId('packs-panel');
};
const dropZipAndDoc = () => {
  const zip = new File([new Uint8Array([1, 2, 3])], 'course-a.zip', { type: 'application/zip' });
  const doc = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  fireEvent.drop(screen.getByRole('button', { name: /drop files here or click to select/i }), {
    dataTransfer: { files: [zip, doc] },
  });
};
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

describe('Documents tabs: a manual tab change supersedes the deferred switch (review L1)', () => {
  it('leaving and returning mid-drop: the finished drop does not yank the tab back', async () => {
    await renderPage();
    dropZipAndDoc();
    await waitFor(() => expect(extraction.release).not.toBeNull());
    await settle();
    expect(store.packs).toHaveLength(1); // pack appeared mid-drop: the switch is deferred

    // The user visits Training packs and comes back while the upload is still open.
    fireEvent.click(screen.getByRole('tab', { name: 'Training packs' }));
    await screen.findByTestId('pack-row-course-a-1.0.0');
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');

    await act(async () => extraction.release?.());
    await settle();
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('aria-selected', 'false');
  });

  it('a pack that lands while Training packs is already showing is not deferred: no later switch', async () => {
    let land: () => void = () => undefined;
    install.hold = new Promise<void>((resolve) => {
      land = resolve;
    });
    await renderPage();
    dropZipAndDoc();
    // The user is on Training packs before the pack lands...
    fireEvent.click(screen.getByRole('tab', { name: 'Training packs' }));
    await act(async () => land());
    await screen.findByTestId('pack-row-course-a-1.0.0');
    await waitFor(() => expect(extraction.release).not.toBeNull());
    // ...then returns to Documents mid-drop and the drop finishes.
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    await act(async () => extraction.release?.());
    await settle();
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Documents tabs: a manual tab change also drops the pack panel signal (critic N5)', () => {
  it('after the deferral is superseded, a later manual Training click does not announce a new pack', async () => {
    await renderPage();
    dropZipAndDoc();
    await waitFor(() => expect(extraction.release).not.toBeNull());
    await settle();
    expect(store.packs).toHaveLength(1); // pack appeared mid-drop: switch deferred, panel signal pending

    // The user re-chooses Documents (a manual tab change): the page drops its deferral.
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    await act(async () => extraction.release?.());
    await settle();
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');

    // Later they open Training packs themselves, with focus on the tab (not lost): the
    // stale signal must not announce "A new training pack was added..." for a switch
    // that never happened.
    const trainingTab = screen.getByRole('tab', { name: 'Training packs' });
    trainingTab.focus();
    fireEvent.click(trainingTab);
    await screen.findByTestId('pack-row-course-a-1.0.0');
    await settle();
    expect(screen.queryByText(/A new training pack was added/)).toBeNull();
  });

  it('control: an automatic (deferred) switch with focus elsewhere still announces', async () => {
    await renderPage();
    const documentsTab = screen.getByRole('tab', { name: 'Documents' });
    documentsTab.focus();
    dropZipAndDoc();
    await waitFor(() => expect(extraction.release).not.toBeNull());
    await settle();
    await act(async () => extraction.release?.());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByText(/A new training pack was added/)).toBeTruthy();
  });
});

describe('Documents header Upload action (review L2)', () => {
  it('opens the document picker directly from the Documents tab', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0]).toMatchObject({ type: 'file' });
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
  });

  it('from the Training packs tab it switches to Documents, then opens the picker once', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    await renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Training packs' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('aria-selected', 'true'));
    click.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true'));
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0]).toMatchObject({ type: 'file' });

    // The pending open was consumed: later renders do not reopen the picker.
    await settle();
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('Documents header Upload supersedes a pending deferred switch (review PRR-207)', () => {
  it('a drop that finishes while the file dialog is open does not switch tabs or unmount the picker', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    await renderPage();
    dropZipAndDoc();
    await waitFor(() => expect(extraction.release).not.toBeNull());
    await settle();
    expect(store.packs).toHaveLength(1); // pack appeared mid-drop: the switch is deferred

    // The user clicks Upload: the OS file dialog opens on the Documents tab's own input.
    const pickerInput = document.querySelector('input[type="file"][accept*=".txt"]');
    expect(pickerInput).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(click).toHaveBeenCalledTimes(1);

    // The drop finishes while the dialog is still open: no yank, the input is still mounted.
    await act(async () => extraction.release?.());
    await settle();
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('aria-selected', 'false');
    expect(pickerInput?.isConnected).toBe(true);
    expect(screen.queryByText(/A new training pack was added/)).toBeNull();
  });
});

// PRE-b (review): the picker is opened from the header Upload button (or the dropzone, which
// keeps focus itself). Nothing in the page may move focus off the control that opened the dialog,
// because the browser hands focus back to the previously focused element when the dialog closes.
describe('Documents header Upload keeps focus on its own button (review PRE-b)', () => {
  it('stays focused after opening the picker from the Documents tab', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    await renderPage();
    const upload = screen.getByRole('button', { name: 'Upload' });
    upload.focus();
    fireEvent.click(upload);
    await settle();
    expect(document.activeElement).toBe(upload);
  });

  it('stays focused after the switch from the Training packs tab and the picker open', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    await renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Training packs' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('aria-selected', 'true'));
    click.mockClear();
    const upload = screen.getByRole('button', { name: 'Upload' });
    upload.focus();
    fireEvent.click(upload);
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    await settle();
    expect(document.activeElement).toBe(upload);
  });
});

// PRR-221: two drops can be in flight at once (a second drop while the first still uploads).
// The deferred Training switch belongs to the LAST drop to finish, not the first.
describe('Documents tabs: two concurrent drops (review PRR-221)', () => {
  it('finishing the second drop first does not switch tabs; finishing the last one does; both documents are listed', async () => {
    await renderPage();
    dropZipAndDoc(); // drop A: course-a.zip + notes.txt
    await waitFor(() => expect(extraction.byName.has('notes.txt')).toBe(true));
    await settle();
    expect(store.packs).toHaveLength(1); // the pack landed mid-drop A: the switch is deferred

    // Drop B arrives while A is still uploading.
    fireEvent.drop(screen.getByRole('button', { name: /drop files here or click to select/i }), {
      dataTransfer: { files: [new File(['again'], 'second.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(extraction.byName.has('second.txt')).toBe(true));
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('second.txt')).toBeInTheDocument();

    // B finishes first: A is still in flight, so the tab must not move.
    await act(async () => extraction.byName.get('second.txt')?.());
    await settle();
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('second.txt')).toBeInTheDocument();

    // A (the last drop in flight) finishes: now the deferred switch fires, exactly once.
    await act(async () => extraction.byName.get('notes.txt')?.());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Training packs' })).toHaveAttribute('aria-selected', 'true'));

    // Both documents survived the switch.
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('second.txt')).toBeInTheDocument();
  });
});
