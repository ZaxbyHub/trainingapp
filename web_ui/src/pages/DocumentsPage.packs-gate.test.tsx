/**
 * DocumentsPage.packs-gate.test.tsx — implementation-side coverage for the
 * C9 (issue #76 / ADR-0009) browser-mode Knowledge Pack capability gate.
 *
 * Contract provenance: the FROZEN acceptance check for this surface is the
 * Playwright spec web_ui/e2e/packs-gate.spec.ts (checkpoint-manifest C3,
 * driver .agents/issue-traces/76-browser-packs-adr/repro/c3-browser-gate-poc.sh
 * — trace-local per repo convention). This suite adds the fast CI-wired
 * component-level half:
 *   1. browser mode: a pack zip dropped on the DropZone shows the persistent
 *      gate notice (data-testid="pack-gate-notice") and writes NOTHING to the
 *      document pipeline (no extraction, no save);
 *   2. browser mode: a NON-pack zip keeps the generic unsupported-type toast
 *      and does NOT trigger the gate;
 *   3. Electron mode: a pack zip is NOT gated — it routes to the C7
 *      installPack API exactly as before (the gate is scoped to !electronMode).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DocumentsPage } from './DocumentsPage';
import { ToastProvider } from '../components/ToastProvider';
import { DesktopSessionProvider, type DesktopSession } from '../lib/desktop-session';
import type { DesktopApiBridge, FirstRunStatus } from '../types/desktop';
import type { ApiClient } from '../lib/api';
import JSZip from 'jszip';
import { fileFromBytes } from '../test/pack-test-utils';

// Browser-local boundary mocks — the set DocumentsPage.packs-plain-doc.test.tsx
// uses, so this suite runs the page's real browser-mode wiring without model
// or native-deps imports.
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
  extractDocument: vi.fn(async () => ({ fullText: 'x', pages: undefined })),
  SUPPORTED_EXTENSIONS: ['.pdf', '.txt', '.md'],
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

import { extractDocument } from '../lib/processing/extractor-factory';
import { saveDocuments } from '../lib/storage/document-store';

/** Schema-honest minimal C1 pack manifest (mirrors the frozen e2e fixture). */
function manifestJson(): Record<string, unknown> {
  return {
    id: 'opmed-core',
    name: 'OpMed Core Bundle',
    version: '1.0.0',
    published_at: '2026-09-20T00:00:00Z',
    source_class: 'bundled',
    embedding: { model_id: 'bge-small-en-v1.5', dims: 384, normalize: true },
    chunking: { strategy: 'fixed-words', size: 220, overlap: 30 },
    docs: [
      {
        path: 'docs/welcome.md',
        sha256: 'a'.repeat(64),
        title: 'Welcome',
        mime: 'text/markdown',
      },
    ],
  };
}

async function packZipFile(): Promise<File> {
  const zip = new JSZip();
  zip.file('pack.json', JSON.stringify(manifestJson()));
  zip.file('docs/welcome.md', '# Welcome');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return fileFromBytes(bytes, 'opmed-core-v1.0.0.zip');
}

async function plainZipFile(): Promise<File> {
  const zip = new JSZip();
  zip.file('notes.txt', 'just an archive');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return fileFromBytes(bytes, 'photos-archive.zip');
}

async function dropOnDropZone(files: File[]): Promise<void> {
  const zone = await screen.findByRole('button', { name: /drop files here/i });
  fireEvent.drop(zone, { dataTransfer: { files } });
}

/** Minimal type-honest FirstRunStatus for inert bridge stubs (PRR-004 shape). */
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

const installPack = vi.fn(async () => ({ packId: 'opmed-core', version: '1.0.0' }));
const removePack = vi.fn(async () => undefined);
const rollbackPack = vi.fn(async () => undefined);
const listPacks = vi.fn(async () => []);
const uploadFile = vi.fn(async () => ({ success: true, documents: [], chunks_added: 5 }));

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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  delete (window as { desktopApi?: DesktopApiBridge }).desktopApi;
});

describe('C9 gate — browser mode', () => {
  it('a dropped pack zip shows the persistent gate notice and writes nothing', async () => {
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );

    await dropOnDropZone([await packZipFile()]);

    const gate = await screen.findByTestId('pack-gate-notice');
    expect(gate).toHaveTextContent('Knowledge Packs require the desktop app');

    // No import happened: the document pipeline and its storage were untouched.
    expect(extractDocument).not.toHaveBeenCalled();
    expect(saveDocuments).not.toHaveBeenCalled();
    expect(screen.queryByText(/opmed-core-v1.0.0\.zip/)).toBeTruthy();
  });

  it('a non-pack zip keeps the generic unsupported-type toast and does not gate', async () => {
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );

    await dropOnDropZone([await plainZipFile()]);

    await waitFor(() => {
      expect(screen.getByText(/Unsupported file type/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('pack-gate-notice')).toBeNull();
  });
});

describe('C9 gate — picker path (selected, not dropped)', () => {
  it('a pack zip selected via the file input is gated and writes nothing', async () => {
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );

    // The DropZone input forwards selections to handleFilesSelected with no
    // accept filtering — the HTML accept attribute is a chooser hint, not an
    // enforcement boundary, so this is the path a "selected" pack takes.
    const input = (await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [await packZipFile()] } });

    const gate = await screen.findByTestId('pack-gate-notice');
    expect(gate).toHaveTextContent('Knowledge Packs require the desktop app');
    expect(extractDocument).not.toHaveBeenCalled();
    expect(saveDocuments).not.toHaveBeenCalled();
  });

  it('a pack zip selected in Electron mode is NOT gated; installPack owns it', async () => {
    installDesktopBridge();
    const session = makeElectronSession();
    render(
      <ToastProvider>
        <DesktopSessionProvider value={{ session, models: null, loading: false, error: null }}>
          <DocumentsPage />
        </DesktopSessionProvider>
      </ToastProvider>
    );

    const input = (await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [await packZipFile()] } });

    await waitFor(() => expect(installPack).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('pack-gate-notice')).toBeNull();
  });
});

describe('C9 gate — Electron mode negative', () => {
  it('a dropped pack zip is NOT gated; the C7 install path owns it', async () => {
    installDesktopBridge();
    const session = makeElectronSession();
    render(
      <ToastProvider>
        <DesktopSessionProvider value={{ session, models: null, loading: false, error: null }}>
          <DocumentsPage />
        </DesktopSessionProvider>
      </ToastProvider>
    );

    await dropOnDropZone([await packZipFile()]);

    await waitFor(() => expect(installPack).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('pack-gate-notice')).toBeNull();
  });
});
