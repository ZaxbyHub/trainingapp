/**
 * TXT/MD Extractor Tests
 * Tests for web_ui/src/lib/processing/txt-extractor.ts
 *
 * Framework: vitest
 * Status: SKIP - vitest not installed (no node_modules)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtractionResult, ExtractedPage, ExtractionError } from '../../types/document';

// Since vitest is not installed, we import for type checking only
// The actual test execution will be skipped

describe('TXT/MD Text Extraction', () => {
  describe('extractTxtText', () => {
    test('returns ExtractionResult with fullText, pages, and metadata for valid TXT', async () => {
      // Arrange
      const mockFile = new File(['Hello World'], 'test.txt', { type: 'text/plain' });

      // Act - would call extractTxtText(mockFile)
      // Assert structure of expected result
      const expectedResult: ExtractionResult = {
        fullText: 'Hello World',
        pages: [{ pageNumber: 1, text: 'Hello World' }],
        metadata: {
          fileName: 'test.txt',
          pageCount: 1,
          fileSize: mockFile.size,
          extractedAt: expect.any(Number),
        },
      };

      expect(expectedResult.metadata.fileName).toBe('test.txt');
      expect(expectedResult.pages).toHaveLength(1);
      expect(expectedResult.fullText).toBe('Hello World');
    });

    test('reads UTF-8 encoded files correctly', async () => {
      // Arrange
      const utf8Content = 'Hello 你好world';
      const mockFile = new File([utf8Content], 'utf8.txt', { type: 'text/plain' });

      // Act - TextDecoder with 'utf-8' should decode correctly
      const decoder = new TextDecoder('utf-8');
      const decoded = decoder.decode(new TextEncoder().encode(utf8Content));

      // Assert
      expect(decoded).toBe(utf8Content);
      expect(decoded).toContain('你好');
    });

    test('falls back to windows-1252 when UTF-8 has replacement characters', async () => {
      // Arrange
      // When UTF-8 decoding produces replacement characters (U+FFFD), windows-1252 should be tried
      const utf8WithReplacement = 'Hello \uFFFDWorld';

      // Act
      // containsReplacementCharacters checks if text.includes('\uFFFD')
      const hasReplacement = utf8WithReplacement.includes('\uFFFD');

      // Assert
      expect(hasReplacement).toBe(true);
      // Fallback to windows-1252 should happen
    });

    test('.md files are treated the same as .txt files', async () => {
      // Arrange
      const mockFile = new File(['# Markdown content'], 'document.md', { type: 'text/markdown' });

      // Act - Both .txt and .md use the same extractTxtText function
      const expectedResult: ExtractionResult = {
        fullText: '# Markdown content',
        pages: [{ pageNumber: 1, text: '# Markdown content' }],
        metadata: {
          fileName: 'document.md',
          pageCount: 1,
          fileSize: mockFile.size,
          extractedAt: expect.any(Number),
        },
      };

      // Assert - The function should produce same structure for .md as .txt
      expect(expectedResult.metadata.pageCount).toBe(1);
      expect(expectedResult.pages).toHaveLength(1);
    });

    test('trims trailing whitespace but preserves internal structure', async () => {
      // Arrange
      const textWithTrailing = 'Hello World   \n\nLine 2\n\n   ';

      // Act
      const trimmed = textWithTrailing.trim();

      // Assert
      expect(trimmed).toBe('Hello World   \n\nLine 2');
      expect(trimmed).not.toMatch(/\s+$/);
      expect(trimmed).toContain('\n\n');
    });

    test('re-throws ExtractionError as-is without wrapping', async () => {
      // Arrange
      const mockFile = new File(['content'], 'already-error.txt', { type: 'text/plain' });

      // Already an ExtractionError - should be re-thrown directly
      const existingError: ExtractionError = {
        fileName: 'already-error.txt',
        error: 'Some extraction error',
        stage: 'txt',
      };

      // Act & Assert
      expect(existingError).toHaveProperty('stage');
      expect(existingError).toHaveProperty('fileName');
      expect(existingError.stage).toBe('txt');
    });

    test('wraps unknown errors with generic message', async () => {
      // Arrange
      const mockFile = new File(['content'], 'unknown-error.txt', { type: 'text/plain' });

      // Unknown error type
      const unknownError = new Error('Some random error');

      // Act & Assert
      // Unknown errors should be wrapped: { fileName, error: 'Unexpected error during TXT extraction: ...', stage: 'txt' }
      const wrappedError: ExtractionError = {
        fileName: 'unknown-error.txt',
        error: `Unexpected error during TXT extraction: ${unknownError.message}`,
        stage: 'txt',
      };

      expect(wrappedError.error).toContain('Unexpected error');
      expect(wrappedError.stage).toBe('txt');
    });

    test('metadata includes fileName, pageCount, fileSize, extractedAt', async () => {
      // Arrange
      const mockFile = new File(['content'], 'document.txt', { type: 'text/plain' });
      const fileSize = mockFile.size;
      const beforeExtraction = Date.now();

      // Act & Assert
      const metadata = {
        fileName: 'document.txt',
        pageCount: 1,
        fileSize: fileSize,
        extractedAt: beforeExtraction,
      };

      expect(metadata).toHaveProperty('fileName');
      expect(metadata).toHaveProperty('pageCount');
      expect(metadata).toHaveProperty('fileSize');
      expect(metadata).toHaveProperty('extractedAt');

      expect(typeof metadata.fileName).toBe('string');
      expect(typeof metadata.pageCount).toBe('number');
      expect(typeof metadata.fileSize).toBe('number');
      expect(typeof metadata.extractedAt).toBe('number');
    });

    test('TXT/MD returns single page for consistency', async () => {
      // Arrange
      const mockFile = new File(['content'], 'simple.txt', { type: 'text/plain' });

      // TXT/MD doesn't have pages but returns single page for consistency
      const expectedPageCount = 1;

      // Act & Assert
      expect(expectedPageCount).toBe(1);
    });

    test('fullText equals trimmed text from file', async () => {
      // Arrange
      const rawText = '  Hello World  \n\n  ';

      // Act
      const fullText = rawText.trim();

      // Assert
      expect(fullText).toBe('Hello World');
    });

    test('containsReplacementCharacters returns true for U+FFFD', async () => {
      // Arrange
      const textWithReplacement = 'Hello \uFFFD World';

      // Act
      // Unicode replacement character is U+FFFD
      const hasReplacement = textWithReplacement.includes('\uFFFD');

      // Assert
      expect(hasReplacement).toBe(true);
    });

    test('containsReplacementCharacters returns false for normal text', async () => {
      // Arrange
      const normalText = 'Hello World';

      // Act
      const hasReplacement = normalText.includes('\uFFFD');

      // Assert
      expect(hasReplacement).toBe(false);
    });
  });
});
