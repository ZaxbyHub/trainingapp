/**
 * DocumentsPage.packs-gate.test.tsx — the RETIRED C9 (issue #76 / ADR-0009)
 * browser-mode Knowledge Pack capability gate, INVERTED by
 * browser-training-parity (ADR-0012, which supersedes ADR-0009): the browser
 * app now installs packs through the same Packs UI and the same drop/picker
 * routing as the desktop app.
 *   1. browser mode: a pack zip dropped on the DropZone (or selected through
 *      its picker) installs through the browser pack store — no gate notice,
 *      nothing reaches the document pipeline;
 *   2. browser mode: every .zip is a pack install attempt, exactly like the
 *      desktop routing; a refused archive surfaces the refusal as an error
 *      toast and still writes nothing to the document pipeline;
 *   3. Electron mode: a pack zip routes to the C7 installPack API exactly as
 *      before.
 * The gate notice (data-testid="pack-gate-notice") no longer exists in either
 * app; these cases assert its absence.
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

// The browser app's pack store (OPFS + IndexedDB in a real browser) is
// replaced by a spy manager: these cases pin the page's ROUTING, the store
// itself is covered by src/lib/packs/__tests__/browser-pack-manager.test.ts.
const browserManager = vi.hoisted(() => ({
  installPack: vi.fn(async (file: File) => {
    if (file.name === 'photos-archive.zip') throw new Error('photos-archive.zip: no pack.json manifest at the archive root');
    return { packId: 'opmed-core', version: '1.0.0' };
  }),
  listPacks: vi.fn(async () => []),
  collectOrphans: vi.fn(async () => undefined),
  missingCapabilities: vi.fn(() => [] as string[]),
  subscribe: vi.fn(() => () => undefined),
  storageReport: vi.fn(async () => ({ usage: 0, quota: 1024 * 1024 * 1024, available: 1024 * 1024 * 1024, persisted: true })),
  removePack: vi.fn(async () => 1),
  rollbackPack: vi.fn(async () => undefined),
}));
vi.mock('../lib/packs/browser-pack-manager', () => ({
  getBrowserPackManager: () => browserManager,
}));

/** The DropZone's file input (the Packs panel's own .zip input comes first in document order). */
const DOCUMENT_FILE_INPUT = 'input[type="file"]:not([data-testid="pack-install-input"])';

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
    // F-022 accepted residual: this stub block is a verified-identical copy of
    // web_ui/src/test/desktop-bridge-stub.ts (adopted in PacksPanel.display.test);
    // these suites override methods before it, so a blind spread refactor would
    // clobber suite-specific mocks. Consolidation is tracked as cleanup.
    // E5 (issue #88) update-channel methods: default no-op stubs; suites that
    // exercise them override per-test.
    getUpdateStatus: vi.fn(async () => ({
      optIn: false,
      feedUrl: '',
      checkedAt: null,
      candidates: [],
      refused: [],
      error: null,
      appUpdate: null,
      lastApply: null,
    })),
    setUpdateOptIn: vi.fn(async () => ({ ok: true })),
    checkForUpdates: vi.fn(async () => ({ ok: true })),
    applyPackUpdate: vi.fn(async () => ({ ok: true })),
    onUpdateAvailable: vi.fn(() => () => {}),
    openUpdateExternal: vi.fn(async () => ({ ok: true })),
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

describe('browser mode: packs install (ADR-0012 inverts the C9 gate)', () => {
  it('a dropped pack zip installs through the browser pack store and writes nothing to the document pipeline', async () => {
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );

    const pack = await packZipFile();
    await dropOnDropZone([pack]);

    await waitFor(() => expect(browserManager.installPack).toHaveBeenCalledWith(pack));
    expect(await screen.findByText(/Installed opmed-core v1\.0\.0/)).toBeInTheDocument();
    expect(screen.queryByTestId('pack-gate-notice')).toBeNull();
    expect(screen.queryByText(/Knowledge Packs require the desktop app/)).toBeNull();
    expect(extractDocument).not.toHaveBeenCalled();
    expect(saveDocuments).not.toHaveBeenCalled();
  });

  it('a non-pack zip is an install attempt too (desktop routing); its refusal is an error toast', async () => {
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );

    await dropOnDropZone([await plainZipFile()]);

    await waitFor(() => {
      expect(screen.getByText(/Failed to install pack "photos-archive\.zip": .*no pack\.json manifest/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('pack-gate-notice')).toBeNull();
    expect(extractDocument).not.toHaveBeenCalled();
  });
});

describe('browser mode: mixed and repeated selections', () => {
  it('a mixed drop (pack zip + plain doc) installs the pack and processes the plain doc', async () => {
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );

    const plainTxt = new File(['plain body'], 'notes.txt', { type: 'text/plain' });
    await dropOnDropZone([await packZipFile(), plainTxt]);

    await waitFor(() => expect(browserManager.installPack).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(extractDocument).toHaveBeenCalledWith(plainTxt));
    expect(screen.queryByTestId('pack-gate-notice')).toBeNull();
  });

  it('two pack zips in one drop are installed one after the other', async () => {
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );

    const zipA = new JSZip();
    zipA.file('pack.json', JSON.stringify({ ...manifestJson(), id: 'opmed-core' }));
    zipA.file('docs/a.md', '# A');
    const zipB = new JSZip();
    zipB.file('pack.json', JSON.stringify({ ...manifestJson(), id: 'opmed-extra' }));
    zipB.file('docs/b.md', '# B');
    const fileA = fileFromBytes(await zipA.generateAsync({ type: 'uint8array' }), 'pack-a.zip');
    const fileB = fileFromBytes(await zipB.generateAsync({ type: 'uint8array' }), 'pack-b.zip');

    await dropOnDropZone([fileA, fileB]);

    await waitFor(() => expect(browserManager.installPack).toHaveBeenCalledTimes(2));
    expect(browserManager.installPack.mock.calls.map((call) => (call[0] as File).name)).toEqual(['pack-a.zip', 'pack-b.zip']);
  });

  it('a plain-file selection after a pack install processes normally', async () => {
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );

    const input = (await waitFor(() => {
      const el = document.querySelector(DOCUMENT_FILE_INPUT);
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    })) as HTMLInputElement;

    fireEvent.change(input, { target: { files: [await packZipFile()] } });
    await waitFor(() => expect(browserManager.installPack).toHaveBeenCalledTimes(1));

    const plainTxt = new File(['later doc'], 'later.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [plainTxt] } });
    await waitFor(() => expect(extractDocument).toHaveBeenCalledWith(plainTxt));
    expect(screen.queryByTestId('pack-gate-notice')).toBeNull();
  });
});

// Review PRR-218: inside Electron, before the desktop session exists, there is no pack client,
// yet the dropzone advertises .zip. A zip arriving then must say why nothing happened.
describe('Electron before its desktop session: a pack zip is refused out loud (review PRR-218)', () => {
  const NOT_READY = /Could not install pack-early\.zip: knowledge packs are not available yet/;
  const early = () => fileFromBytes(new Uint8Array([80, 75, 3, 4]), 'pack-early.zip');

  it('a dropped zip shows an error and reaches neither the pack API nor the document pipeline', async () => {
    installDesktopBridge();
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );
    await dropOnDropZone([early()]);
    expect(await screen.findByText(NOT_READY)).toBeInTheDocument();
    expect(installPack).not.toHaveBeenCalled();
    expect(browserManager.installPack).not.toHaveBeenCalled();
    expect(extractDocument).not.toHaveBeenCalled();
  });

  it('a zip picked through the file input (All files) is refused the same way', async () => {
    installDesktopBridge();
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );
    const input = (await waitFor(() => {
      const el = document.querySelector(DOCUMENT_FILE_INPUT);
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [early()] } });
    expect(await screen.findByText(NOT_READY)).toBeInTheDocument();
    expect(installPack).not.toHaveBeenCalled();
    expect(extractDocument).not.toHaveBeenCalled();
  });
});

describe('picker path (selected, not dropped)', () => {
  it('a pack zip selected via the DropZone file input installs in the browser and writes nothing to the document pipeline', async () => {
    render(
      <ToastProvider>
        <DocumentsPage />
      </ToastProvider>
    );

    // The DropZone input forwards selections to handleFilesSelected with no
    // accept filtering — the HTML accept attribute is a chooser hint, not an
    // enforcement boundary, so this is the path a "selected" pack takes.
    const input = (await waitFor(() => {
      const el = document.querySelector(DOCUMENT_FILE_INPUT);
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    })) as HTMLInputElement;
    const pack = await packZipFile();
    fireEvent.change(input, { target: { files: [pack] } });

    await waitFor(() => expect(browserManager.installPack).toHaveBeenCalledWith(pack));
    expect(screen.queryByTestId('pack-gate-notice')).toBeNull();
    expect(extractDocument).not.toHaveBeenCalled();
    expect(saveDocuments).not.toHaveBeenCalled();
  });

  it('a pack zip selected in Electron mode routes to the desktop installPack API', async () => {
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
      const el = document.querySelector(DOCUMENT_FILE_INPUT);
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [await packZipFile()] } });

    await waitFor(() => expect(installPack).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('pack-gate-notice')).toBeNull();
  });
});

describe('Electron mode', () => {
  it('a dropped pack zip routes to the C7 desktop install path', async () => {
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
