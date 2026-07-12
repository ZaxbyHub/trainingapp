/**
 * PDF Extractor Tests
 * Tests for web_ui/src/lib/processing/pdf-extractor.ts
 *
 * Framework: vitest
 * Status: SKIP - vitest not installed (no node_modules)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtractionResult, ExtractedPage, ExtractionError } from '../../types/document';

// Mock pdfjs-dist BEFORE importing pdf-extractor so that configure/terminate tests
// and any future real calls don't require full PDF.js worker in jsdom.
vi.mock('pdfjs-dist', () => {
  (globalThis as any).__pdfWorkerSetCount = 0;
  (globalThis as any).__pdfWorkerSrc = '';
  return {
    GlobalWorkerOptions: {
      get workerSrc() {
        return (globalThis as any).__pdfWorkerSrc || '';
      },
      set workerSrc(v: string) {
        (globalThis as any).__pdfWorkerSrc = v;
        (globalThis as any).__pdfWorkerSetCount = ((globalThis as any).__pdfWorkerSetCount || 0) + 1;
      },
    },
    getDocument: vi.fn().mockImplementation(() => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn().mockResolvedValue({
          getTextContent: vi.fn().mockResolvedValue({
            items: [{ str: 'mock page text' }],
          }),
          cleanup: vi.fn(),
        }),
        destroy: vi.fn(),
      }),
    })),
  };
});

// Import functions under test AFTER the mock
import { extractPdfText, terminatePdfWorker } from './pdf-extractor';

// Since vitest is not installed, we import for type checking only
// The actual test execution will be skipped

/**
 * Mock pdfjs-dist module
 */
const mockPdfJs = {
  GlobalWorkerOptions: {
    workerSrc: '',
  },
  getDocument: vi.fn(),
};

// We would use: import * as pdfjsLib from 'pdfjs-dist';
// But since vitest isn't available, we structure tests for future execution

describe('PDF Text Extraction', () => {
  describe('extractPdfText', () => {
    test('returns ExtractionResult with fullText, pages, and metadata', async () => {
      const mockFile = {
        name: 'test.pdf',
        type: 'application/pdf',
        size: 12,
        arrayBuffer: async () => new ArrayBuffer(12),
      } as unknown as File;

      const result = await extractPdfText(mockFile);
      expect(result.fullText).toBe('mock page text');
      expect(result.pages).toHaveLength(1);
      expect(result.metadata.fileName).toBe('test.pdf');
    });

    test('handles encrypted PDFs with password error', async () => {
      const { getDocument } = await import('pdfjs-dist');
      const passwordError = new Error('Password supplied for encrypted PDF');
      vi.mocked(getDocument).mockImplementationOnce(() => ({
        promise: Promise.reject(passwordError),
      }) as any);

      const mockFile = {
        name: 'encrypted.pdf',
        type: 'application/pdf',
        size: 0,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as File;

      await expect(extractPdfText(mockFile)).rejects.toMatchObject({
        fileName: 'encrypted.pdf',
        error: expect.stringContaining('encrypted'),
        stage: 'pdf',
      });
    });

    test('handles malformed PDFs with parse error', async () => {
      const parseError = new Error('Invalid PDF structure');

      const { getDocument } = await import('pdfjs-dist');
      vi.mocked(getDocument).mockImplementationOnce(() => ({
        promise: Promise.reject(parseError),
      }) as any);

      const mockFile = {
        name: 'malformed.pdf',
        type: 'application/pdf',
        size: 10,
        arrayBuffer: async () => new ArrayBuffer(10),
      } as unknown as File;

      await expect(extractPdfText(mockFile)).rejects.toMatchObject({
        fileName: 'malformed.pdf',
        error: expect.stringContaining('Failed to parse PDF'),
        stage: 'pdf',
      });
    });

    test('skips pages with no extractable text', async () => {
      const { getDocument } = await import('pdfjs-dist');

      let pageNum = 0;
      vi.mocked(getDocument).mockImplementationOnce(() => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: vi.fn().mockImplementation(() => {
            pageNum++;
            if (pageNum === 1) {
              return Promise.resolve({
                getTextContent: vi.fn().mockResolvedValue({
                  items: [{ str: 'Page 1 content' }],
                }),
                cleanup: vi.fn(),
              });
            } else {
              return Promise.resolve({
                getTextContent: vi.fn().mockResolvedValue({
                  items: [],
                }),
                cleanup: vi.fn(),
              });
            }
          }),
          destroy: vi.fn(),
        }),
      }) as any);

      const mockFile = {
        name: 'mixed.pdf',
        type: 'application/pdf',
        size: 10,
        arrayBuffer: async () => new ArrayBuffer(10),
      } as unknown as File;

      const result = await extractPdfText(mockFile);
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].pageNumber).toBe(1);
      expect(result.fullText).toBe('Page 1 content');
    });

    test('metadata includes fileName, pageCount, fileSize, extractedAt', async () => {
      const beforeExtraction = Date.now();

      const mockFile = {
        name: 'document.pdf',
        type: 'application/pdf',
        size: 7,
        arrayBuffer: async () => new ArrayBuffer(7),
      } as unknown as File;

      const result = await extractPdfText(mockFile);

      expect(result.metadata).toHaveProperty('fileName');
      expect(result.metadata).toHaveProperty('pageCount');
      expect(result.metadata).toHaveProperty('fileSize');
      expect(result.metadata).toHaveProperty('extractedAt');

      expect(typeof result.metadata.fileName).toBe('string');
      expect(typeof result.metadata.pageCount).toBe('number');
      expect(typeof result.metadata.fileSize).toBe('number');
      expect(typeof result.metadata.extractedAt).toBe('number');

      expect(result.metadata.extractedAt).toBeGreaterThanOrEqual(beforeExtraction);
    });

    test('pdfjs-dist worker is configured', async () => {
      const mockFile = {
        name: 'test.pdf',
        type: 'application/pdf',
        size: 7,
        arrayBuffer: async () => new ArrayBuffer(7),
      } as unknown as File;

      // Call extractPdfText first (which configures the worker)
      await extractPdfText(mockFile);

      // Then verify workerSrc was set
      const { GlobalWorkerOptions } = await import('pdfjs-dist');
      expect(GlobalWorkerOptions.workerSrc).toContain('pdf.worker');
      expect(GlobalWorkerOptions.workerSrc).toContain('pdf.worker.min.mjs');
    });

    test('fullText is constructed from pages joined by double newlines', async () => {
      const { getDocument } = await import('pdfjs-dist');

      let pageNum = 0;
      vi.mocked(getDocument).mockImplementationOnce(() => ({
        promise: Promise.resolve({
          numPages: 3,
          getPage: vi.fn().mockImplementation(() => {
            pageNum++;
            return Promise.resolve({
              getTextContent: vi.fn().mockResolvedValue({
                items: [{ str: `Page ${pageNum} content` }],
              }),
              cleanup: vi.fn(),
            });
          }),
          destroy: vi.fn(),
        }),
      }) as any);

      const mockFile = {
        name: 'multi.pdf',
        type: 'application/pdf',
        size: 15,
        arrayBuffer: async () => new ArrayBuffer(15),
      } as unknown as File;

      const result = await extractPdfText(mockFile);
      expect(result.fullText).toBe('Page 1 content\n\nPage 2 content\n\nPage 3 content');
    });

    test('handles empty PDF with no text content across all pages', async () => {
      const { getDocument } = await import('pdfjs-dist');

      vi.mocked(getDocument).mockImplementationOnce(() => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: vi.fn().mockResolvedValue({
            getTextContent: vi.fn().mockResolvedValue({ items: [] }),
            cleanup: vi.fn(),
          }),
          destroy: vi.fn(),
        }),
      }) as any);

      const mockFile = {
        name: 'empty.pdf',
        type: 'application/pdf',
        size: 0,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as File;

      const result = await extractPdfText(mockFile);
      expect(result.pages).toHaveLength(0);
      expect(result.fullText).toBe('');
    });

    test('throws ExtractionError with correct structure for unknown errors', async () => {
      // Mock file whose arrayBuffer() throws — triggers outer catch (line 119)
      // which wraps the error as "Unexpected error during PDF extraction: ..."
      const mockFile = {
        name: 'unknown.pdf',
        type: 'application/pdf',
        size: 0,
        arrayBuffer: async () => { throw new Error('Network error'); },
      } as unknown as File;

      // Act & Assert
      await expect(extractPdfText(mockFile)).rejects.toMatchObject({
        fileName: 'unknown.pdf',
        error: expect.stringContaining('Unexpected error'),
        stage: 'pdf',
      });
    });

    test('calls pdf.destroy() on the happy path (resource cleanup)', async () => {
      const destroySpy = vi.fn();
      const { getDocument } = await import('pdfjs-dist');
      vi.mocked(getDocument).mockImplementationOnce(() => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: vi.fn().mockResolvedValue({
            getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'cleanup me' }] }),
            cleanup: vi.fn(),
          }),
          destroy: destroySpy,
        }),
      }) as any);

      const mockFile = {
        name: 'cleanup.pdf',
        type: 'application/pdf',
        size: 4,
        arrayBuffer: async () => new ArrayBuffer(4),
      } as unknown as File;

      await extractPdfText(mockFile);
      // Regression guard: the outer finally must destroy the loaded document.
      // Guards against the `if (pdf)` guard being silently inverted to `if (!pdf)`.
      expect(destroySpy).toHaveBeenCalledTimes(1);
    });

    test('does NOT throw in finally when parsing fails before pdf is assigned', async () => {
      // Regression for issue #20 finding #1: the outer finally referenced a
      // block-scoped `pdf` that was undefined when getDocument() rejected. The
      // fix guards with `if (pdf)`; this test proves no secondary
      // "Cannot read properties of undefined (reading 'destroy')" leaks out.
      const { getDocument } = await import('pdfjs-dist');
      vi.mocked(getDocument).mockImplementationOnce(() => ({
        promise: Promise.reject(new Error('Invalid PDF structure')),
      }) as any);

      const mockFile = {
        name: 'preassign-fail.pdf',
        type: 'application/pdf',
        size: 4,
        arrayBuffer: async () => new ArrayBuffer(4),
      } as unknown as File;

      // Should reject with the parse ExtractionError, NOT a TypeError from finally.
      await expect(extractPdfText(mockFile)).rejects.toMatchObject({
        fileName: 'preassign-fail.pdf',
        stage: 'pdf',
      });
    });

    test('extracts text from multiple pages correctly', async () => {
      const { getDocument } = await import('pdfjs-dist');

      vi.mocked(getDocument).mockImplementationOnce(() => ({
        promise: Promise.resolve({
          numPages: 3,
          getPage: vi.fn()
            .mockResolvedValueOnce({
              getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'Chapter 1 Introduction' }] }),
              cleanup: vi.fn(),
            })
            .mockResolvedValueOnce({
              getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'Chapter 2 Background' }] }),
              cleanup: vi.fn(),
            })
            .mockResolvedValueOnce({
              getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'Chapter 3 Methods' }] }),
              cleanup: vi.fn(),
            }),
          destroy: vi.fn(),
        }),
      }) as any);

      const mockFile = {
        name: 'multi.pdf',
        type: 'application/pdf',
        size: 15,
        arrayBuffer: async () => new ArrayBuffer(15),
      } as unknown as File;

      const result = await extractPdfText(mockFile);
      expect(result.pages).toHaveLength(3);
      expect(result.pages[0].pageNumber).toBe(1);
      expect(result.pages[1].pageNumber).toBe(2);
      expect(result.pages[2].pageNumber).toBe(3);
      expect(result.fullText).toContain('Chapter 1');
      expect(result.fullText).toContain('Chapter 2');
      expect(result.fullText).toContain('Chapter 3');
    });
  });

  // -------------------------------------------------------------------------
  // PDF.js worker singleton (FR-006)
  // Tests for configurePdfWorker (internal) idempotence and terminatePdfWorker reset.
  // -------------------------------------------------------------------------

  describe('PDF worker singleton', () => {
    beforeEach(() => {
      // Reset counters for each test
      (globalThis as any).__pdfWorkerSetCount = 0;
      (globalThis as any).__pdfWorkerSrc = '';
      vi.clearAllMocks();
      // Force reset of private _workerConfigured flag in pdf-extractor module
      // so each test starts with unconfigured worker (idempotence + terminate tests require it)
      terminatePdfWorker();
    });

    test('configurePdfWorker is idempotent — calling twice does not duplicate', async () => {
      const mockFile = {
        name: 'test.pdf',
        type: 'application/pdf',
        size: 10,
        arrayBuffer: async () => new ArrayBuffer(10),
      } as unknown as File;

      // First extract configures
      await extractPdfText(mockFile);
      const firstCount = (globalThis as any).__pdfWorkerSetCount;

      // Second extract should be no-op for configure
      await extractPdfText(mockFile);
      const secondCount = (globalThis as any).__pdfWorkerSetCount;

      expect(firstCount).toBe(1);
      expect(secondCount).toBe(1); // no additional set
    });

    test('terminatePdfWorker resets configuration so next extract re-initializes', async () => {
      const mockFile = {
        name: 'test.pdf',
        type: 'application/pdf',
        size: 10,
        arrayBuffer: async () => new ArrayBuffer(10),
      } as unknown as File;

      await extractPdfText(mockFile);
      const afterFirst = (globalThis as any).__pdfWorkerSetCount;

      terminatePdfWorker();

      await extractPdfText(mockFile);
      const afterReset = (globalThis as any).__pdfWorkerSetCount;

      expect(afterFirst).toBe(1);
      expect(afterReset).toBe(2); // re-set after terminate
    });
  });
});
