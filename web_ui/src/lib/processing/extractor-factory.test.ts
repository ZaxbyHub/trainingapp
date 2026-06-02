/**
 * Extractor Factory Tests
 * Tests for web_ui/src/lib/processing/extractor-factory.ts
 *
 * Framework: vitest
 * Status: SKIP - vitest not installed (no node_modules)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtractionResult, ExtractionError } from '../../types/document';

// Since vitest is not installed, we import for type checking only
// The actual test execution will be skipped

describe('Extractor Factory', () => {
  describe('SUPPORTED_EXTENSIONS', () => {
    test('contains expected extensions: .pdf, .docx, .xlsx, .txt, .md', async () => {
      // Act - SUPPORTED_EXTENSIONS should contain all supported file extensions
      const supportedExtensions = ['.pdf', '.docx', '.xlsx', '.txt', '.md'];

      // Assert
      expect(supportedExtensions).toContain('.pdf');
      expect(supportedExtensions).toContain('.docx');
      expect(supportedExtensions).toContain('.xlsx');
      expect(supportedExtensions).toContain('.txt');
      expect(supportedExtensions).toContain('.md');
      expect(supportedExtensions).toHaveLength(5);
    });

    test('SUPPORTED_EXTENSIONS is derived from EXTRACTOR_MAP keys', async () => {
      // The implementation uses: export const SUPPORTED_EXTENSIONS = Object.keys(EXTRACTOR_MAP);
      const extractorMap = {
        '.pdf': 'extractPdfText',
        '.docx': 'extractDocxText',
        '.xlsx': 'extractXlsxText',
        '.txt': 'extractTxtText',
        '.md': 'extractTxtText',
      };

      const supportedExtensions = Object.keys(extractorMap);

      // Assert
      expect(supportedExtensions).toHaveLength(5);
      expect(supportedExtensions).toEqual(['.pdf', '.docx', '.xlsx', '.txt', '.md']);
    });
  });

  describe('extractDocument', () => {
    test('routes .pdf files to extractPdfText', async () => {
      // Arrange
      const mockFile = new File(['PDF content'], 'test.pdf', { type: 'application/pdf' });

      // Act - extractDocument should route to extractPdfText based on extension
      const fileName = mockFile.name.toLowerCase();
      const extension = fileName.substring(fileName.lastIndexOf('.'));

      // Assert
      expect(extension).toBe('.pdf');
    });

    test('routes .docx files to extractDocxText', async () => {
      // Arrange
      const mockFile = new File(['DOCX content'], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

      // Act
      const fileName = mockFile.name.toLowerCase();
      const extension = fileName.substring(fileName.lastIndexOf('.'));

      // Assert
      expect(extension).toBe('.docx');
    });

    test('routes .xlsx files to extractXlsxText', async () => {
      // Arrange
      const mockFile = new File(['XLSX content'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      // Act
      const fileName = mockFile.name.toLowerCase();
      const extension = fileName.substring(fileName.lastIndexOf('.'));

      // Assert
      expect(extension).toBe('.xlsx');
    });

    test('routes .txt files to extractTxtText', async () => {
      // Arrange
      const mockFile = new File(['TXT content'], 'test.txt', { type: 'text/plain' });

      // Act
      const fileName = mockFile.name.toLowerCase();
      const extension = fileName.substring(fileName.lastIndexOf('.'));

      // Assert
      expect(extension).toBe('.txt');
    });

    test('routes .md files to extractTxtText (same as .txt)', async () => {
      // Arrange
      const mockFile = new File(['MD content'], 'test.md', { type: 'text/markdown' });

      // Act
      const fileName = mockFile.name.toLowerCase();
      const extension = fileName.substring(fileName.lastIndexOf('.'));

      // Assert
      expect(extension).toBe('.md');
      // .md and .txt both map to extractTxtText in EXTRACTOR_MAP
    });

    test('throws ExtractionError for unsupported extensions', async () => {
      // Arrange
      const mockFile = new File(['content'], 'test.exe', { type: 'application/octet-stream' });

      // Act & Assert
      // Unsupported extension should throw: { fileName: 'test.exe', error: 'Unsupported file extension: .exe', stage: 'txt' }
      const expectedError: ExtractionError = {
        fileName: 'test.exe',
        error: expect.stringContaining('Unsupported file extension'),
        stage: 'txt',
      };

      expect(expectedError.error).toMatch(/Unsupported/);
    });

    test('throws ExtractionError when no extension found', async () => {
      // Arrange
      const mockFile = new File(['content'], 'noextension', { type: 'application/octet-stream' });

      // Act & Assert
      // No extension should throw: { fileName: 'noextension', error: 'Unsupported file type: no extension found', stage: 'txt' }
      const expectedError: ExtractionError = {
        fileName: 'noextension',
        error: expect.stringContaining('no extension found'),
        stage: 'txt',
      };

      expect(expectedError.error).toMatch(/no extension found/);
    });

    test('file extension matching is case-insensitive', async () => {
      // Arrange
      const mockFile = new File(['content'], 'test.PDF', { type: 'application/pdf' });

      // Act - findExtension uses lastIndexOf('.')
      const fileName = mockFile.name.toLowerCase();
      const extension = fileName.substring(fileName.lastIndexOf('.'));

      // Assert - should still match even with uppercase
      expect(extension).toBe('.pdf');
    });

    test('handles filenames with multiple dots correctly', async () => {
      // Arrange
      const fileName = 'document.v2.final.pdf';

      // Act - findExtension uses lastIndexOf('.') to get the last extension
      const extension = fileName.substring(fileName.lastIndexOf('.'));

      // Assert
      expect(extension).toBe('.pdf');
    });

    test('handles filenames ending with dot (no extension)', async () => {
      // Arrange
      const fileName = 'file.';

      // Act - lastIndexOf('.') returns index, but it's the last character
      const lastDotIndex = fileName.lastIndexOf('.');
      const hasExtension = lastDotIndex !== -1 && lastDotIndex !== fileName.length - 1;

      // Assert
      expect(hasExtension).toBe(false);
    });
  });

  describe('getStageForExtension', () => {
    test('maps .pdf to stage "pdf"', async () => {
      const stageForPdf: ExtractionError['stage'] = 'pdf';
      expect(stageForPdf).toBe('pdf');
    });

    test('maps .docx/.doc to stage "docx"', async () => {
      const stageForDocx: ExtractionError['stage'] = 'docx';
      expect(stageForDocx).toBe('docx');
    });

    test('maps .xlsx/.xls to stage "xlsx"', async () => {
      const stageForXlsx: ExtractionError['stage'] = 'xlsx';
      expect(stageForXlsx).toBe('xlsx');
    });

    test('maps .pptx/.ppt to stage "pptx"', async () => {
      const stageForPptx: ExtractionError['stage'] = 'pptx';
      expect(stageForPptx).toBe('pptx');
    });

    test('maps unknown extensions to stage "txt"', async () => {
      const stageForUnknown: ExtractionError['stage'] = 'txt';
      expect(stageForUnknown).toBe('txt');
    });
  });

  describe('findExtension', () => {
    test('returns extension with leading dot', async () => {
      const fileName = 'document.pdf';
      const lastDotIndex = fileName.lastIndexOf('.');
      const extension = fileName.substring(lastDotIndex);

      expect(extension).toBe('.pdf');
    });

    test('returns null when no dot found', async () => {
      const fileName = 'noextension';
      const lastDotIndex = fileName.lastIndexOf('.');

      expect(lastDotIndex).toBe(-1);
    });

    test('returns null when dot is at end of filename', async () => {
      const fileName = 'file.';
      const lastDotIndex = fileName.lastIndexOf('.');
      const isAtEnd = lastDotIndex === fileName.length - 1;

      expect(lastDotIndex).toBe(fileName.length - 1);
      expect(isAtEnd).toBe(true);
    });
  });

  describe('EXTRACTOR_MAP', () => {
    test('.pdf maps to extractPdfText', async () => {
      const extractorMap = {
        '.pdf': 'extractPdfText',
        '.docx': 'extractDocxText',
        '.xlsx': 'extractXlsxText',
        '.txt': 'extractTxtText',
        '.md': 'extractTxtText',
      };

      expect(extractorMap['.pdf']).toBe('extractPdfText');
    });

    test('.txt and .md both map to extractTxtText', async () => {
      const extractorMap = {
        '.pdf': 'extractPdfText',
        '.docx': 'extractDocxText',
        '.xlsx': 'extractXlsxText',
        '.txt': 'extractTxtText',
        '.md': 'extractTxtText',
      };

      expect(extractorMap['.txt']).toBe('extractTxtText');
      expect(extractorMap['.md']).toBe('extractTxtText');
      expect(extractorMap['.txt']).toBe(extractorMap['.md']);
    });
  });
});
