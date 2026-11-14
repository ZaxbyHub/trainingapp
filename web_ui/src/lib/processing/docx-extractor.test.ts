/**
 * DOCX Extractor Tests
 * Tests for web_ui/src/lib/processing/docx-extractor.ts
 *
 * Framework: vitest. The `mammoth` dependency is mocked at the module
 * boundary (the extractor calls `mammoth.extractRawText({ arrayBuffer })`);
 * the REAL `extractDocxText` is imported and invoked (issue #271 AC1).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn(),
  },
}));

import { extractDocxText } from './docx-extractor';
import mammoth from 'mammoth';
import type { ExtractionError } from '../../types/document';

const extractRawTextMock = vi.mocked(mammoth.extractRawText);

function docxFile(name = 'test.docx'): File {
  // The extractor reads file.arrayBuffer(); jsdom's File lacks it in this
  // version, so provision it duck-typed (same pattern as pdf-extractor.test).
  const file = new File(['DOCX content'], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const bytes = new TextEncoder().encode('DOCX content');
  const withBuffer = file as File & { arrayBuffer: () => Promise<ArrayBuffer> };
  withBuffer.arrayBuffer = async () => bytes.buffer.slice(0) as ArrayBuffer;
  return file;
}

describe('DOCX Text Extraction', () => {
  describe('extractDocxText (real extractor, mammoth mocked at the boundary)', () => {
    beforeEach(() => {
      extractRawTextMock.mockReset();
    });

    test('invokes the real extractDocxText, which calls mammoth and returns ExtractionResult for valid input', async () => {
      extractRawTextMock.mockResolvedValue({ value: 'Hello from DOCX', messages: [] });

      const result = await extractDocxText(docxFile());

      expect(extractRawTextMock).toHaveBeenCalledTimes(1);
      const arg = extractRawTextMock.mock.calls[0][0] as { arrayBuffer: ArrayBuffer };
      // jsdom's ArrayBuffer is realm-distinct from the Node test realm, so an
      // instanceof check against the test-realm constructor fails; assert the
      // byte length of the provisioned buffer instead.
      expect(new Uint8Array(arg.arrayBuffer).length).toBeGreaterThan(0);
      expect(result.fullText).toBe('Hello from DOCX');
      expect(result.pages).toEqual([{ pageNumber: 1, text: 'Hello from DOCX' }]);
      expect(result.metadata.fileName).toBe('test.docx');
      expect(result.metadata.pageCount).toBe(1);
      expect(typeof result.metadata.fileSize).toBe('number');
      expect(typeof result.metadata.extractedAt).toBe('number');
    });

    test('returns a single-page ExtractionResult for a different valid file name', async () => {
      extractRawTextMock.mockResolvedValue({ value: 'Other text', messages: [] });

      const result = await extractDocxText(docxFile('other-name.docx'));

      expect(extractRawTextMock).toHaveBeenCalledTimes(1);
      expect(result.metadata.fileName).toBe('other-name.docx');
      expect(result.fullText).toBe('Other text');
      expect(result.pages).toHaveLength(1);
    });

    test('treats DOCX as a single page and surfaces mammoth warnings without failing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      extractRawTextMock.mockResolvedValue({
        value: 'Warned text',
        messages: [{ type: 'warning', message: 'Some formatting not supported' }],
      });

      const result = await extractDocxText(docxFile('with-warnings.docx'));

      expect(result.metadata.pageCount).toBe(1);
      expect(result.fullText).toBe('Warned text');
      expect(warnSpy).toHaveBeenCalledWith(
        'DOCX extraction warnings:',
        expect.objectContaining({ length: 1 }),
      );
      warnSpy.mockRestore();
    });

    test('throws ExtractionError with stage docx when mammoth rejects with a corrupt-zip message', async () => {
      extractRawTextMock.mockRejectedValue(new Error('Invalid ZIP archive'));

      const error = (await extractDocxText(docxFile('malformed.docx')).catch(
        (e: unknown) => e,
      )) as ExtractionError;

      expect(error.error).toBe('Failed to extract DOCX: Invalid ZIP archive');
      expect(error.stage).toBe('docx');
      expect(error.fileName).toBe('malformed.docx');
    });

    test('throws ExtractionError with stage docx when arrayBuffer read rejects with a not-found message', async () => {
      const file = docxFile('missing-content.docx');
      (file as File & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () => {
        throw new Error('File not found in archive');
      };

      const error = (await extractDocxText(file).catch((e: unknown) => e)) as ExtractionError;

      expect(error.error).toMatch(/not found/);
      expect(error.stage).toBe('docx');
    });

    test('re-throws an ExtractionError-shaped object as-is without wrapping', async () => {
      const existingError = {
        fileName: 'already-error.docx',
        error: 'Some extraction error',
        stage: 'docx' as const,
      };
      extractRawTextMock.mockRejectedValue(existingError);

      const error = (await extractDocxText(docxFile('already-error.docx')).catch(
        (e: unknown) => e,
      )) as ExtractionError;

      expect(error).toBe(existingError);
    });

    test('wraps unknown errors with the Unexpected-error prefix and stage docx', async () => {
      extractRawTextMock.mockRejectedValue(new Error('Some random error'));

      const error = (await extractDocxText(docxFile('unknown-error.docx')).catch(
        (e: unknown) => e,
      )) as ExtractionError;

      expect(error.error).toBe('Unexpected error during DOCX extraction: Some random error');
      expect(error.stage).toBe('docx');
      expect(error.fileName).toBe('unknown-error.docx');
    });
  });
});
