/**
 * Extractor Factory Tests
 * Tests for web_ui/src/lib/processing/extractor-factory.ts
 *
 * Framework: vitest
 * Status: SKIP - vitest not installed (no node_modules)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtractionResult, ExtractionError } from '../../types/document';

// Mock leaf extractors BEFORE importing extractor-factory (so validation tests can call extractDocument
// without triggering real PDF/DOCX parsing which requires browser-compatible binaries in jsdom).
vi.mock('./pdf-extractor', () => ({
  extractPdfText: vi.fn().mockResolvedValue({
    fullText: 'mocked pdf text',
    pages: [],
    metadata: { fileName: 'test.pdf', pageCount: 1, fileSize: 0, extractedAt: 0 },
  }),
}));
vi.mock('./docx-extractor', () => ({
  extractDocxText: vi.fn().mockResolvedValue({
    fullText: 'mocked docx text',
    pages: [],
    metadata: { fileName: 'test.docx', pageCount: 1, fileSize: 0, extractedAt: 0 },
  }),
}));
vi.mock('./xlsx-extractor', () => ({
  extractXlsxText: vi.fn().mockResolvedValue({
    fullText: 'mocked xlsx text',
    pages: [],
    metadata: { fileName: 'test.xlsx', pageCount: 1, fileSize: 0, extractedAt: 0 },
  }),
}));
vi.mock('./txt-extractor', () => ({
  extractTxtText: vi.fn().mockResolvedValue({
    fullText: 'mocked txt text',
    pages: [],
    metadata: { fileName: 'test.txt', pageCount: 1, fileSize: 0, extractedAt: 0 },
  }),
}));
vi.mock('./pptx-extractor', () => ({
  extractPptxText: vi.fn().mockResolvedValue({
    fullText: 'mocked pptx text',
    pages: [],
    metadata: { fileName: 'test.pptx', pageCount: 1, fileSize: 0, extractedAt: 0 },
  }),
}));

// Import the function under test AFTER mocks
import { extractDocument, SUPPORTED_EXTENSIONS } from './extractor-factory';

// Since vitest is not installed, we import for type checking only
// The actual test execution will be skipped

describe('Extractor Factory', () => {
  describe('SUPPORTED_EXTENSIONS', () => {
    test('contains expected extensions: .pdf, .docx, .xlsx, .txt, .md, .pptx', async () => {
      expect(SUPPORTED_EXTENSIONS).toContain('.pdf');
      expect(SUPPORTED_EXTENSIONS).toContain('.docx');
      expect(SUPPORTED_EXTENSIONS).toContain('.xlsx');
      expect(SUPPORTED_EXTENSIONS).toContain('.txt');
      expect(SUPPORTED_EXTENSIONS).toContain('.md');
      expect(SUPPORTED_EXTENSIONS).toContain('.pptx');
      expect(SUPPORTED_EXTENSIONS).toHaveLength(6);
    });

    test('SUPPORTED_EXTENSIONS has exactly 6 entries matching the extractor map', async () => {
      expect(SUPPORTED_EXTENSIONS).toHaveLength(6);
      expect(SUPPORTED_EXTENSIONS).toEqual(['.pdf', '.docx', '.xlsx', '.txt', '.md', '.pptx']);
    });
  });

  describe('extractDocument', () => {
    test('routes .pdf files to extractPdfText', async () => {
      const mockFile = new File(['PDF content'], 'test.pdf', { type: 'application/pdf' });
      const result = await extractDocument(mockFile);
      expect(result.fullText).toBe('mocked pdf text');
    });

    test('routes .docx files to extractDocxText', async () => {
      const mockFile = new File([], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const result = await extractDocument(mockFile);
      expect(result.fullText).toBe('mocked docx text');
    });

    test('routes .xlsx files to extractXlsxText', async () => {
      const mockFile = new File([], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const result = await extractDocument(mockFile);
      expect(result.fullText).toBe('mocked xlsx text');
    });

    test('routes .txt files to extractTxtText', async () => {
      const mockFile = new File([], 'test.txt', { type: 'text/plain' });
      const result = await extractDocument(mockFile);
      expect(result.fullText).toBe('mocked txt text');
    });

    test('routes .md files to extractTxtText (same as .txt)', async () => {
      const mockFile = new File([], 'test.md', { type: 'text/markdown' });
      const result = await extractDocument(mockFile);
      expect(result.fullText).toBe('mocked txt text');
    });

    test('throws ExtractionError for unsupported extensions', async () => {
      const mockFile = new File(['content'], 'test.exe', { type: 'application/octet-stream' });
      await expect(extractDocument(mockFile)).rejects.toMatchObject({
        fileName: 'test.exe',
        error: expect.stringContaining('Unsupported'),
        stage: 'txt',
      });
    });

    test('throws ExtractionError when no extension found', async () => {
      const mockFile = new File(['content'], 'noextension', { type: 'application/octet-stream' });
      await expect(extractDocument(mockFile)).rejects.toMatchObject({
        fileName: 'noextension',
        error: expect.stringContaining('no extension found'),
        stage: 'txt',
      });
    });

    test('file extension matching is case-insensitive', async () => {
      const mockFile = new File([], 'test.PDF', { type: 'application/pdf' });
      const result = await extractDocument(mockFile);
      expect(result.fullText).toBe('mocked pdf text');
    });

    test('handles filenames with multiple dots correctly', async () => {
      const mockFile = new File([], 'document.v2.final.pdf', { type: 'application/pdf' });
      const result = await extractDocument(mockFile);
      expect(result.fullText).toBe('mocked pdf text');
    });

    test('handles filenames ending with dot (no extension)', async () => {
      const mockFile = new File(['content'], 'file.', { type: 'application/octet-stream' });
      await expect(extractDocument(mockFile)).rejects.toMatchObject({
        fileName: 'file.',
        error: expect.stringContaining('no extension found'),
        stage: 'txt',
      });
    });
  });

  // -------------------------------------------------------------------------
  // MIME type validation (FR-005)
  // These exercise the validateFileType logic inside extractDocument.
  // -------------------------------------------------------------------------

  describe('MIME validation', () => {
    test('rejects .pdf file with image/png MIME', async () => {
      const mockFile = new File(['PDF content'], 'test.pdf', { type: 'image/png' });
      await expect(extractDocument(mockFile)).rejects.toMatchObject({
        fileName: 'test.pdf',
        error: expect.stringContaining('File type mismatch'),
        stage: 'pdf',
      });
    });

    test('accepts .docx with correct Office MIME', async () => {
      const mockFile = new File(['DOCX content'], 'test.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      // Should not throw; returns result from mocked extractor
      const result = await extractDocument(mockFile);
      expect(result.fullText).toBe('mocked docx text');
    });

    test('accepts .txt with empty file.type', async () => {
      const mockFile = new File(['TXT content'], 'test.txt', { type: '' });
      const result = await extractDocument(mockFile);
      expect(result.fullText).toBe('mocked txt text');
    });

    test('accepts .docx with application/zip MIME (DOCX is a zip container)', async () => {
      const mockFile = new File(['DOCX content'], 'test.docx', { type: 'application/zip' });
      const result = await extractDocument(mockFile);
      expect(result.fullText).toBe('mocked docx text');
    });

    test('rejects .xlsx with image/png MIME', async () => {
      const mockFile = new File(['XLSX content'], 'test.xlsx', { type: 'image/png' });
      await expect(extractDocument(mockFile)).rejects.toMatchObject({
        fileName: 'test.xlsx',
        error: expect.stringContaining('File type mismatch'),
        stage: 'xlsx',
      });
    });
  });
});
