/**
 * DocumentsPage.packs.test.tsx — unit acceptance checks for issue #74
 * (C7: Documents page pack surface), Electron mode, jsdom + @testing-library.
 *
 * Frozen check subjects (driven per-AC with `vitest run -t "<grep>"`):
 *   AC4  remove requires confirmation: clicking a row's remove control shows
 *        a confirm; Cancel leaves the pack listed and never calls the remove
 *        API. Confirming calls removePack(packId, version) and refreshes.
 *   AC5  rollback: clicking rollback on a superseded version calls
 *        rollbackPack(packId, toVersion) and the refreshed list shows the
 *        target version active (and the previously active one superseded).
 *   AC8  mode branching: during install/remove/rollback flows the
 *        browser-local stores (lib/storage/profile, lib/storage/document-store)
 *        are never touched in Electron mode.
 *
 * ---------------------------------------------------------------------------
 * SEAMS THE IMPLEMENTATION MUST PROVIDE (frozen contract — the same seams the
 * e2e spec desktop/e2e/c7-packs.spec.ts asserts; keep both in sync):
 *   - Panel heading: role="heading", accessible name `Knowledge Packs`
 *     (rendered by DocumentsPage in Electron mode).
 *   - data-testid="packs-panel"                      — panel container
 *   - data-testid="pack-row-<packId>-<version>"      — one row per installed
 *     version; row text contains name, version, source_class.
 *   - data-testid="pack-status-<packId>-<version>"   — status word element,
 *     visible text `active` or `superseded`.
 *   - data-testid="pack-install-input"               — .zip install file input
 *   - data-testid="pack-remove-<packId>-<version>"   — remove control,
 *     aria-label `Remove <packId> <version>`
 *   - data-testid="pack-remove-confirm"              — confirmation button
 *   - data-testid="pack-remove-cancel"               — cancel button
 *   - data-testid="pack-rollback-<packId>-<version>" — rollback control,
 *     aria-label `Rollback <packId> to <version>`
 *
 * apiClient additions the implementation must add (asserted via stubs):
 *   listPacks(): Promise<PackInfo[]>
 *   installPack(file: File): Promise<{ packId: string; version: string }>
 *   removePack(packId: string, version?: string): Promise<void>
 *   rollbackPack(packId: string, toVersion: string): Promise<void>
 *
 * PackInfo shape asserted throughout (camelCase mirrors of the fixture
 * pack.json fields id/version/name/source_class/published_at):
 *   { packId, version, name, sourceClass, publishedAt, active, supersedes }
 *
 * On the BASE tree (no pack surface yet) every describe fails fast: the first
 * assertion waits 1.5s for `packs-panel` / the `Knowledge Packs` heading and
 * times out with a TestingLibraryElementError — seconds, not minutes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DocumentsPage } from './DocumentsPage';
import { ToastProvider } from '../components/ToastProvider';
import { DesktopSessionProvider, type DesktopSession } from '../lib/desktop-session';
import type { DesktopApiBridge, FirstRunStatus } from '../types/desktop';
import type { ApiClient } from '../lib/api';

// Browser-local boundary mocks — the EXACT set DocumentsPage.electron.test.tsx
// mocks. No edgevec WASM snippet chain may load in this file.
vi.mock('../lib/storage/document-store', () => ({
  loadDocuments: vi.fn(async () => []),
  saveDocuments: vi.fn(),
  deleteDocument: vi.fn(),
}));
vi.mock('../lib/storage/profile', () => ({
  migrateOrphanedNamespaces: vi.fn(async () => undefined),
  getProfilePrefix: vi.fn(() => 'testprfx'),
}));
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
import { migrateOrphanedNamespaces } from '../lib/storage/profile';

/** Frozen pack-row shape the Documents pack surface must consume. */
export interface PackInfo {
  packId: string;
  version: string;
  name: string;
  sourceClass: string;
  publishedAt: string;
  active: boolean;
  supersedes: string[];
}

/** Fixture rows: two pack ids, versioned-a superseded by its own 2.0.0. */
const PACKS: PackInfo[] = [
  {
    packId: 'bundled-min',
    version: '1.0.0',
    name: 'Bundled Minimum Fixture',
    sourceClass: 'bundled',
    publishedAt: '2026-09-16T00:00:00Z',
    active: true,
    supersedes: [],
  },
  {
    packId: 'versioned-a',
    version: '2.0.0',
    name: 'Versioned A Fixture',
    sourceClass: 'bundled',
    publishedAt: '2026-09-16T00:00:00Z',
    active: true,
    supersedes: ['versioned-a@1.0.0'],
  },
  {
    packId: 'versioned-a',
    version: '1.0.0',
    name: 'Versioned A Fixture',
    sourceClass: 'bundled',
    publishedAt: '2026-09-16T00:00:00Z',
    active: false,
    supersedes: [],
  },
];

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

interface PackStubOverrides {
  listPacks?: ReturnType<typeof vi.fn>;
  installPack?: ReturnType<typeof vi.fn>;
  removePack?: ReturnType<typeof vi.fn>;
  rollbackPack?: ReturnType<typeof vi.fn>;
}

/** Stub session whose apiClient carries BOTH the existing document methods
 *  and the NEW pack methods the implementation must add. */
function makeSession(overrides: PackStubOverrides = {}): DesktopSession {
  const apiClient = {
    listDocuments: vi.fn(async () => ({ documents: [], total: 0 })),
    uploadFile: vi.fn(async () => ({ success: true, documents: [], chunks_added: 0 })),
    clearDocuments: vi.fn(async () => ({ status: 'cleared' })),
    listPacks: overrides.listPacks ?? vi.fn(async () => PACKS),
    installPack:
      overrides.installPack ?? vi.fn(async () => ({ packId: 'user-sample', version: '1.0.0' })),
    removePack: overrides.removePack ?? vi.fn(async () => undefined),
    rollbackPack: overrides.rollbackPack ?? vi.fn(async () => undefined),
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

/**
 * Fast-fail gate: on the base tree (no pack surface) this rejects within
 * ~1.5s with a clear TestingLibraryElementError naming the missing seam.
 */
async function expectPacksPanel(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('packs-panel')).toBeInTheDocument(), {
    timeout: 1_500,
  });
  await waitFor(
    () => expect(screen.getByRole('heading', { name: 'Knowledge Packs' })).toBeInTheDocument(),
    { timeout: 1_500 },
  );
}

beforeEach(() => {
  (window as { desktopApi?: DesktopApiBridge }).desktopApi = {
    getAuthToken: vi.fn(async () => 't'),
    getBackendInfo: vi.fn(async () => ({ mode: 'node', port: 1, url: 'http://127.0.0.1:1' })),
    getFirstRunStatus: vi.fn(async () => stubFirstRunStatus()),
    activateFirstRunPacks: vi.fn(async () => ({ ok: true, results: [] })),
    completeFirstRun: vi.fn(async () => ({ ok: true })),
    resetFirstRun: vi.fn(async () => ({ ok: true })),
    onFirstRunRequired: vi.fn(() => () => {}),
  };
});

afterEach(() => {
  cleanup();
  delete (window as { desktopApi?: DesktopApiBridge }).desktopApi;
  vi.clearAllMocks();
});

describe('AC4 — remove requires confirmation; cancel leaves the pack installed', () => {
  it('canceling the confirmation never calls removePack and keeps the row listed', async () => {
    const removePack = vi.fn(async () => undefined);
    renderWithSession(makeSession({ removePack }));
    await expectPacksPanel();

    const row = screen.getByTestId('pack-row-bundled-min-1.0.0');
    expect(row).toHaveTextContent('Bundled Minimum Fixture');
    expect(row).toHaveTextContent('1.0.0');
    expect(row).toHaveTextContent('bundled');

    // Remove is gated behind an explicit confirmation dialog.
    fireEvent.click(screen.getByTestId('pack-remove-bundled-min-1.0.0'));
    await waitFor(() => expect(screen.getByTestId('pack-remove-confirm')).toBeInTheDocument());

    // Cancel: the dialog closes, the pack stays, the API is untouched.
    fireEvent.click(screen.getByTestId('pack-remove-cancel'));
    await waitFor(() => expect(screen.queryByTestId('pack-remove-confirm')).toBeNull());
    expect(removePack).not.toHaveBeenCalled();
    expect(screen.getByTestId('pack-row-bundled-min-1.0.0')).toBeInTheDocument();
  });

  it('confirming calls removePack with the packId and version and refreshes the list', async () => {
    const removePack = vi.fn(async () => undefined);
    const listPacks = vi.fn(async () => PACKS);
    renderWithSession(makeSession({ removePack, listPacks }));
    await expectPacksPanel();

    fireEvent.click(screen.getByTestId('pack-remove-versioned-a-1.0.0'));
    fireEvent.click(await waitFor(() => screen.getByTestId('pack-remove-confirm')));

    await waitFor(() => expect(removePack).toHaveBeenCalledWith('versioned-a', '1.0.0'));
    // The list is re-fetched after the removal (mount load + post-remove).
    await waitFor(() => expect(listPacks.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('AC5 — rollback reactivates a superseded pack version', () => {
  it('rollback on a superseded version calls rollbackPack and the refreshed list shows it active', async () => {
    const rollbackPack = vi.fn(async () => undefined);
    let listCalls = 0;
    const listPacks = vi.fn(async () => {
      listCalls += 1;
      // Pre-rollback: 2.0.0 active, 1.0.0 superseded. Post-rollback (after the
      // rollback API fired) the target version is the active one.
      const rolledBack = rollbackPack.mock.calls.length > 0;
      return PACKS.map((p) => ({
        ...p,
        active: rolledBack ? p.packId === 'versioned-a' && p.version === '1.0.0' : p.active,
      }));
    });
    renderWithSession(makeSession({ listPacks, rollbackPack }));
    await expectPacksPanel();

    // Pre-state: the superseded row shows its status word.
    expect(screen.getByTestId('pack-status-versioned-a-2.0.0')).toHaveTextContent(/active/);
    expect(screen.getByTestId('pack-status-versioned-a-1.0.0')).toHaveTextContent(/superseded/);

    fireEvent.click(screen.getByTestId('pack-rollback-versioned-a-1.0.0'));

    await waitFor(() => expect(rollbackPack).toHaveBeenCalledWith('versioned-a', '1.0.0'));
    // The refreshed list shows the rolled-back version active and the
    // previously active version superseded.
    await waitFor(() =>
      expect(screen.getByTestId('pack-status-versioned-a-1.0.0')).toHaveTextContent(/active/),
    );
    expect(screen.getByTestId('pack-status-versioned-a-2.0.0')).toHaveTextContent(/superseded/);
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('AC8 — pack operations never touch the browser-local stores in Electron mode', () => {
  it('install + remove + rollback leave profile.ts and document-store untouched', async () => {
    const installPack = vi.fn(async () => ({ packId: 'user-sample', version: '1.0.0' }));
    const removePack = vi.fn(async () => undefined);
    const rollbackPack = vi.fn(async () => undefined);
    renderWithSession(makeSession({ installPack, removePack, rollbackPack }));
    await expectPacksPanel();

    // --- pack install: a .zip on the pack install input ---
    const input = document.querySelector(
      'input[data-testid="pack-install-input"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const zipFile = new File(['zip-bytes-fixture'], 'user-sample-1.0.0.zip', {
      type: 'application/zip',
    });
    fireEvent.change(input as HTMLInputElement, { target: { files: [zipFile] } });
    await waitFor(() => expect(installPack).toHaveBeenCalledTimes(1));
    expect((installPack.mock.calls[0] as unknown as [File])[0].name).toBe('user-sample-1.0.0.zip');

    // --- pack remove behind its confirmation ---
    fireEvent.click(screen.getByTestId('pack-remove-bundled-min-1.0.0'));
    fireEvent.click(await waitFor(() => screen.getByTestId('pack-remove-confirm')));
    await waitFor(() => expect(removePack).toHaveBeenCalledWith('bundled-min', '1.0.0'));

    // --- pack rollback ---
    fireEvent.click(screen.getByTestId('pack-rollback-versioned-a-1.0.0'));
    await waitFor(() => expect(rollbackPack).toHaveBeenCalledWith('versioned-a', '1.0.0'));

    // The browser-local IndexedDB boundary must never be touched by any pack
    // operation (or by the Electron-mode mount itself).
    expect(migrateOrphanedNamespaces).not.toHaveBeenCalled();
    expect(loadDocuments).not.toHaveBeenCalled();
    expect(saveDocuments).not.toHaveBeenCalled();
    expect(deleteDocument).not.toHaveBeenCalled();
  });
});
