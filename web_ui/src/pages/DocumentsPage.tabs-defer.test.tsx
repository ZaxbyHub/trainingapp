/**
 * DocumentsPage.tabs-defer.test.tsx — Lumen phase 6 review L5: a mixed bulk
 * drop (a training .zip plus documents) installs the pack first and then uploads
 * the documents. The automatic switch to the "Training packs" tab must wait for
 * the whole drop to finish instead of swapping the Documents tab away mid-upload.
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
const extraction = vi.hoisted(() => ({ release: null as null | (() => void) }));
vi.mock('../lib/processing/extractor-factory', () => ({
  // Held open until the test releases it: the document upload is "in flight".
  extractDocument: vi.fn(
    () =>
      new Promise((resolve) => {
        extraction.release = () => resolve({ fullText: 'plain text body', pages: undefined });
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
const install = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'reject' | 'install-then-reject' }));
const packClient = vi.hoisted(() => ({
  kind: 'browser',
  listPacks: async () => [...store.packs],
  installPack: async () => {
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
  install.mode = 'ok';
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
