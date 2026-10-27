/**
 * documents-count-boundaries.test.tsx — AC10 (issue #41 D3) boundary cases
 * beyond the frozen discriminating check (which pins the 3-documents plural):
 * the singular "1 document", zero documents (no badge), and the exclusion of
 * unsupported file types from the count. Same render harness as the frozen
 * documents-count-copy spec (real <DocumentsPage />, heavyweight seams
 * mocked); the badge expression and supportedCount computation run unmocked.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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

function doc(n: number, fileType = '.pdf'): DocumentEntry {
  return {
    id: `doc-${n}`,
    fileName: `report-${n}${fileType}`,
    fileSize: 1024,
    fileType,
    status: 'ready' as const,
    progress: 100,
    uploadedAt: 1_700_000_000_000,
  };
}

/** The header badge text (whitespace-normalized), undefined while loading. */
function headerBadgeText(): string | undefined {
  const badges = document.querySelectorAll('.ui-page-header__actions .ui-badge');
  for (const badge of Array.from(badges)) {
    const text = (badge.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text !== '') return text;
  }
  return undefined;
}

async function renderWith(docs: DocumentEntry[]): Promise<void> {
  vi.mocked(loadDocuments).mockResolvedValue(docs);
  render(<DocumentsPage />);
  await waitFor(
    () => {
      expect(
        screen.getByRole('heading', { name: 'Documents' }),
        'the page never finished loading — the badge cannot be evaluated'
      ).toBeInTheDocument();
    },
    { timeout: 10_000 }
  );
}

describe('Documents header badge count boundaries (AC10, issue #41 D3)', () => {
  it('one supported document reads the singular "1 document"', async () => {
    await renderWith([doc(1)]);
    await waitFor(() => {
      expect(headerBadgeText()).toBe('1 document');
    });
  });

  it('three supported documents read the plural "3 documents"', async () => {
    await renderWith([doc(1), doc(2), doc(3)]);
    await waitFor(() => {
      expect(headerBadgeText()).toBe('3 documents');
    });
  });

  it('zero supported documents render no badge at all', async () => {
    await renderWith([]);
    // Let any late render settle before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(headerBadgeText()).toBeUndefined();
  });

  it('unsupported file types are excluded: only the supported document counts', async () => {
    await renderWith([doc(1, '.exe'), doc(2)]);
    await waitFor(() => {
      expect(headerBadgeText()).toBe('1 document');
    });
  });

  it('only unsupported documents render no badge (exclusion is not a crash)', async () => {
    await renderWith([doc(1, '.exe')]);
    await new Promise((r) => setTimeout(r, 50));
    expect(headerBadgeText()).toBeUndefined();
  });
});
