/**
 * AC10 (issue #41 D3) — DISCRIMINATING copy check for the Documents header
 * badge.
 *
 * RED at base, GREEN after the fix: at base the badge expression in
 * web_ui/src/pages/DocumentsPage.tsx (~line 888) renders
 * `{supportedCount} supported file{supportedCount !== 1 ? 's' : ''}` — read as
 * "the app supports N file types" — while the acceptance criterion requires it
 * to read "N documents" (e.g. "3 documents") for the document count. The
 * fixing change rewrites that one expression; this spec then turns green.
 *
 * Render-surface choice: the badge expression lives INLINE in DocumentsPage's
 * PageHeader actions — there is no smaller real component that contains it —
 * so this spec renders the real <DocumentsPage /> and mocks only the
 * heavyweight side-effect seams the page wires at module scope (IndexedDB
 * document store, dexie profile migration, pack client, desktop session,
 * embedding/vector/keyword search services, and the pdf/docx/xlsx extractor
 * factory). The header, the Badge, and the `supportedCount` computation run
 * unmocked. (The legacy src/pages/DocumentsPage.test.tsx harness is excluded
 * from runs for unrelated drift; this file is the fresh, minimal harness.)
 *
 * Success anchor (consumed by repro check C10's head leg):
 *   anchor present: documents-copy green
 * Failure signature (matches check C10's base --expect):
 *   documents-count-copy: header badge renders "3 supported files"
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('../../lib/storage/document-store', () => ({
  loadDocuments: vi.fn(),
  saveDocuments: vi.fn().mockResolvedValue(undefined),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/storage/profile', () => ({
  migrateOrphanedNamespaces: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/processing/extractor-factory', () => ({
  extractDocument: vi.fn(),
  // Same dotted-extension format as the real extractor map keys
  // (SUPPORTED_EXTENSIONS = Object.keys(EXTRACTOR_MAP)).
  SUPPORTED_EXTENSIONS: ['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md'],
}));
vi.mock('../../lib/embeddings/embedding-service', () => ({
  getEmbeddingService: vi.fn(),
}));
vi.mock('../../lib/search/vector-index', () => ({
  getVectorIndex: vi.fn(),
}));
vi.mock('../../lib/search/keyword-index', () => ({
  getKeywordIndex: vi.fn(),
}));
vi.mock('../../hooks/useServiceInitialization', () => ({
  ensureEmbeddingServiceReady: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../lib/desktop-session', () => ({
  isElectron: () => false,
  useDesktopSession: () => ({ session: null }),
}));
vi.mock('../../lib/packs/pack-client', () => ({
  usePackClient: () => null,
  desktopPackClient: vi.fn(),
  browserPackClient: vi.fn(),
}));
vi.mock('../../components/ToastProvider', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

import { DocumentsPage } from '../DocumentsPage';
import { loadDocuments } from '../../lib/storage/document-store';
import type { DocumentEntry } from '../../types/document';

/** Three ready, supported documents -> supportedCount must be 3. */
function threeSupportedDocuments(): DocumentEntry[] {
  return [1, 2, 3].map((n) => ({
    id: `doc-${n}`,
    fileName: `report-${n}.pdf`,
    fileSize: 1024,
    fileType: '.pdf',
    status: 'ready' as const,
    progress: 100,
    uploadedAt: 1_700_000_000_000,
  }));
}

/**
 * The header badge text: the <Badge> inside PageHeader's actions area
 * (`.ui-page-header__actions .ui-badge`), whitespace-normalized. Returns
 * undefined while the page is still in its loading branch (no badge yet).
 */
function headerBadgeText(): string | undefined {
  const badges = document.querySelectorAll('.ui-page-header__actions .ui-badge');
  for (const badge of Array.from(badges)) {
    const text = (badge.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text !== '') return text;
  }
  return undefined;
}

describe('Documents header badge copy (AC10, issue #41 D3)', () => {
  it('reads "3 documents" when three supported documents exist', async () => {
    vi.mocked(loadDocuments).mockResolvedValue(threeSupportedDocuments());

    render(<DocumentsPage />);

    await waitFor(
      () => {
        expect(
          headerBadgeText(),
          'documents-count-copy: the Documents header badge never rendered (loading did not finish or the count badge is gone) — AC10 cannot be evaluated'
        ).toBeDefined();
      },
      { timeout: 10_000 }
    );

    const badge = headerBadgeText();
    if (badge !== '3 documents') {
      throw new Error(
        `documents-count-copy: header badge renders "${badge}" but AC10 (issue #41 D3) requires "3 documents" when supportedCount=3`
      );
    }

    // The header itself rendered (non-vacuous proof the page is up).
    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument();

    // Success anchor consumed by repro check C10's head leg.
    console.log('anchor present: documents-copy green');
  });
});
