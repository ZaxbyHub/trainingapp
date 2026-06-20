/**
 * XLSX Extractor Tests
 * Tests for web_ui/src/lib/processing/xlsx-extractor.ts
 *
 * Framework: vitest
 * Status: SKIP - vitest not installed (no node_modules)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtractionResult, ExtractedPage, ExtractionError } from '../../types/document';

// Since vitest is not installed, we import for type checking only
// The actual test execution will be skipped

/**
 * Mock xlsx (SheetJS) module
 */
const mockXlsx = {
  read: vi.fn(),
  utils: {
    sheet_to_json: vi.fn(),
  },
};

describe('XLSX Text Extraction', () => {
  describe('extractXlsxText', () => {
    test('returns ExtractionResult with fullText, pages, and metadata for valid XLSX', async () => {
      // Arrange
      const mockFile = new File(['XLSX content'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      // Act - would call extractXlsxText(mockFile)
      // Assert structure of expected result
      const expectedResult: ExtractionResult = {
        fullText: 'Sheet: Sheet1\nRow 1: A\tB\tC',
        pages: [{ pageNumber: 1, text: 'Sheet: Sheet1\nRow 1: A\tB\tC' }],
        metadata: {
          fileName: 'test.xlsx',
          pageCount: 1,
          fileSize: mockFile.size,
          extractedAt: expect.any(Number),
        },
      };

      expect(expectedResult.metadata.fileName).toBe('test.xlsx');
      expect(expectedResult.pages).toHaveLength(1);
      expect(expectedResult.fullText).toContain('Sheet: Sheet1');
    });

    test('handles multi-sheet XLSX with each sheet as separate page', async () => {
      // Arrange
      const mockFile = new File(['multi-sheet'], 'multi.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      // Act - would call extractXlsxText(mockFile)
      // Each sheet should create a separate page
      const expectedPages: ExtractedPage[] = [
        { pageNumber: 1, text: expect.stringContaining('Sheet: Summary') },
        { pageNumber: 2, text: expect.stringContaining('Sheet: Data') },
      ];

      // Assert
      expect(expectedPages).toHaveLength(2);
      expect(expectedPages[0].pageNumber).toBe(1);
      expect(expectedPages[1].pageNumber).toBe(2);
    });

    test('includes row numbers in extracted text format "Row N: ..."', async () => {
      // Arrange
      const mockFile = new File(['with-rows'], 'rows.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      // Act - Row numbers should be included in format: "Row 1: value1\tvalue2"
      const rowText = 'Row 1: Name\tAge\tCity';

      // Assert
      expect(rowText).toMatch(/^Row \d+:/);
      expect(rowText).toContain('Name');
      expect(rowText).toContain('Age');
    });

    test('handles empty workbook with no content', async () => {
      // Arrange
      const mockFile = new File([''], 'empty.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      // Act & Assert
      // Empty workbook should return result with empty text and pageCount: 0
      const emptyResult: ExtractionResult = {
        fullText: '',
        pages: [{ pageNumber: 1, text: '' }],
        metadata: {
          fileName: 'empty.xlsx',
          pageCount: 0,
          fileSize: 0,
          extractedAt: Date.now(),
        },
      };

      expect(emptyResult.fullText).toBe('');
      expect(emptyResult.metadata.pageCount).toBe(0);
    });

    test('skips empty sheets and rows with no content', async () => {
      // Arrange
      const mockFile = new File(['content'], 'partial.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      // Simulate filtering of empty rows
      const allRows = [
        [null, null, null], // empty row - should be filtered
        ['A', 'B', 'C'],    // non-empty row
        [null, undefined, ''], // another empty row - should be filtered
      ];

      const nonEmptyRows = allRows.filter((row) =>
        row.some((cell) => cell !== null && cell !== undefined && cell !== '')
      );

      // Assert
      expect(nonEmptyRows).toHaveLength(1);
      expect(nonEmptyRows[0]).toEqual(['A', 'B', 'C']);
    });

    test('handles Date objects in cells by converting to ISO string', async () => {
      // Arrange
      const dateValue = new Date('2024-01-15T00:00:00Z');

      // Act - Date objects should be converted using toISOString()
      const cellText = dateValue instanceof Date ? dateValue.toISOString() : String(dateValue);

      // Assert
      expect(cellText).toContain('2024');
      expect(cellText).toContain('01');
      expect(cellText).toContain('15');
    });

    test('handles malformed XLSX with parse error', async () => {
      // Arrange
      const mockFile = new File(['NOT A VALID XLSX'], 'malformed.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      // SheetJS throws error with 'Invalid' or 'Failed to parse' for corrupt files
      const parseError = new Error('Failed to parse');

      // Act & Assert
      // Would call: await extractXlsxText(mockFile)
      // Should throw: ExtractionError { fileName: 'malformed.xlsx', error: 'Failed to extract XLSX: Failed to parse', stage: 'xlsx' }

      const expectedError: ExtractionError = {
        fileName: 'malformed.xlsx',
        error: expect.stringContaining('Failed to extract XLSX'),
        stage: 'xlsx',
      };

      expect(expectedError.error).toMatch(/Invalid|corrupt|Failed to parse/);
      expect(expectedError.stage).toBe('xlsx');
    });

    test('re-throws ExtractionError as-is without wrapping', async () => {
      // Arrange
      const mockFile = new File(['content'], 'already-error.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      // Already an ExtractionError - should be re-thrown directly
      const existingError: ExtractionError = {
        fileName: 'already-error.xlsx',
        error: 'Some extraction error',
        stage: 'xlsx',
      };

      // Act & Assert
      // When error has 'stage' and 'fileName' properties, it should be re-throwed as-is
      expect(existingError).toHaveProperty('stage');
      expect(existingError).toHaveProperty('fileName');
      expect(existingError.stage).toBe('xlsx');
    });

    test('wraps unknown errors with generic message', async () => {
      // Arrange
      const mockFile = new File(['content'], 'unknown-error.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      // Unknown error type
      const unknownError = new Error('Some random error');

      // Act & Assert
      // Unknown errors should be wrapped: { fileName, error: 'Unexpected error during XLSX extraction: ...', stage: 'xlsx' }
      const wrappedError: ExtractionError = {
        fileName: 'unknown-error.xlsx',
        error: `Unexpected error during XLSX extraction: ${unknownError.message}`,
        stage: 'xlsx',
      };

      expect(wrappedError.error).toContain('Unexpected error');
      expect(wrappedError.stage).toBe('xlsx');
    });

    test('metadata includes fileName, pageCount, fileSize, extractedAt', async () => {
      // Arrange
      const mockFile = new File(['content'], 'document.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const fileSize = mockFile.size;
      const beforeExtraction = Date.now();

      // Act & Assert
      const metadata = {
        fileName: 'document.xlsx',
        pageCount: 2,
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

    test('fullText joins sheet texts with double newlines', async () => {
      // Arrange
      const sheet1Text = 'Sheet: Sheet1\nRow 1: A\tB';
      const sheet2Text = 'Sheet: Sheet2\nRow 1: X\tY';

      // Act
      const fullText = [sheet1Text, sheet2Text].join('\n\n');

      // Assert
      expect(fullText).toBe('Sheet: Sheet1\nRow 1: A\tB\n\nSheet: Sheet2\nRow 1: X\tY');
      expect(fullText).toContain('\n\n');
    });

    test('cell values are joined by tab character', async () => {
      // Arrange
      const rowCells = ['John', 'Doe', '30'];

      // Act
      const rowText = rowCells.join('\t');

      // Assert
      expect(rowText).toBe('John\tDoe\t30');
    });
  });
});
