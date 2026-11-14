/**
 * XLSX Extractor Tests
 * Tests for web_ui/src/lib/processing/xlsx-extractor.ts
 *
 * Framework: vitest. The `xlsx` (SheetJS) dependency is mocked at the module
 * boundary (the extractor uses `import * as XLSX` then XLSX.read +
 * XLSX.utils.sheet_to_json); the REAL `extractXlsxText` is imported and
 * invoked (issue #271 AC2). Mocked nonempty worksheets MUST carry a `!ref`
 * (the extractor skips sheets without one).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('xlsx', () => ({
  read: vi.fn(),
  utils: {
    sheet_to_json: vi.fn(),
  },
}));

import { extractXlsxText } from './xlsx-extractor';
import * as XLSX from 'xlsx';
import type { ExtractionError } from '../../types/document';

const readMock = vi.mocked(XLSX.read);
const sheetToJsonMock = vi.mocked(XLSX.utils.sheet_to_json);

function xlsxFile(name = 'test.xlsx'): File {
  // The extractor reads file.arrayBuffer(); jsdom's File lacks it in this
  // version, so provision it duck-typed (same pattern as pdf-extractor.test).
  const file = new File(['binary'], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const bytes = new TextEncoder().encode('binary');
  const withBuffer = file as File & { arrayBuffer: () => Promise<ArrayBuffer> };
  withBuffer.arrayBuffer = async () => bytes.buffer.slice(0) as ArrayBuffer;
  return file;
}

function sheet(rows: unknown[][]): Record<string, unknown> {
  return { '!ref': 'A1:C2' } as Record<string, unknown>;
}

describe('XLSX Text Extraction', () => {
  describe('extractXlsxText (real extractor, xlsx mocked at the boundary)', () => {
    beforeEach(() => {
      readMock.mockReset();
      sheetToJsonMock.mockReset();
    });

    test('invokes the real extractXlsxText, which calls XLSX.read and returns one page per sheet', async () => {
      readMock.mockReturnValue({
        SheetNames: ['Alpha', 'Beta'],
        Sheets: { Alpha: sheet([]), Beta: { '!ref': 'A1:C2' } },
      } as never);
      sheetToJsonMock
        .mockReturnValueOnce([
          ['name', 'qty'],
          ['Widget', '2'],
        ] as never)
        .mockReturnValueOnce([
          ['greeting'],
          ['hello'],
        ] as never);

      const result = await extractXlsxText(xlsxFile());

      expect(readMock).toHaveBeenCalledTimes(1);
      expect(sheetToJsonMock).toHaveBeenCalledTimes(2);
      expect(result.metadata.pageCount).toBe(2);
      expect(result.pages[0].pageNumber).toBe(1);
      expect(result.pages[0].text).toContain('Sheet: Alpha');
      expect(result.pages[0].text).toContain('Row 2: Widget\t2');
      expect(result.pages[1].pageNumber).toBe(2);
      expect(result.pages[1].text).toContain('Sheet: Beta');
      expect(result.pages[1].text).toContain('Row 2: hello');
      expect(result.fullText).toContain('Sheet: Alpha');
      expect(result.fullText).toContain('Sheet: Beta');
    });

    test('preserves original row numbers across blank rows (no renumbering)', async () => {
      readMock.mockReturnValue({
        SheetNames: ['One'],
        Sheets: { One: sheet([]) },
      } as never);
      sheetToJsonMock.mockReturnValueOnce([
        ['a'],
        [''],
        ['c'],
      ] as never);

      const result = await extractXlsxText(xlsxFile());

      expect(result.pages[0].text).toContain('Row 1: a');
      expect(result.pages[0].text).not.toContain('Row 2');
      expect(result.pages[0].text).toContain('Row 3: c');
    });

    test('returns an empty-page result when no sheet has content', async () => {
      readMock.mockReturnValue({
        SheetNames: ['Empty'],
        Sheets: { Empty: {} }, // no !ref -> skipped
      } as never);

      const result = await extractXlsxText(xlsxFile());

      expect(result.metadata.pageCount).toBe(0);
      expect(result.fullText).toBe('');
    });

    test('throws ExtractionError with stage xlsx when XLSX.read rejects', async () => {
      readMock.mockImplementation(() => {
        throw new Error('Corrupt xlsx archive');
      });

      const error = (await extractXlsxText(xlsxFile('bad.xlsx')).catch(
        (e: unknown) => e,
      )) as ExtractionError;

      expect(error.stage).toBe('xlsx');
      expect(error.fileName).toBe('bad.xlsx');
      expect(String(error.error)).toContain('Corrupt');
    });

    test('classifies a corrupt-workbook message through the corrupt-classifier branch (lowercase match)', async () => {
      // Issue #349 review F-002: the capital-C fixture above falls through
      // the case-sensitive includes('corrupt') classifier to the generic
      // path; this fixture carries a lowercase 'corrupt' so the classified
      // 'Failed to extract XLSX' classified branch (xlsx-extractor.ts:161-170) executes.
      readMock.mockImplementation(() => {
        throw new Error('file is corrupt and unreadable');
      });

      const error = (await extractXlsxText(xlsxFile('corrupt.xlsx')).catch(
        (e: unknown) => e,
      )) as ExtractionError;

      expect(error.stage).toBe('xlsx');
      expect(error.fileName).toBe('corrupt.xlsx');
      expect(String(error.error)).toContain('Failed to extract XLSX');
    });

    test('throws ExtractionError with stage xlsx when arrayBuffer read rejects', async () => {
      const file = xlsxFile('unreadable.xlsx');
      (file as File & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () => {
        throw new Error('stream closed');
      };

      const error = (await extractXlsxText(file).catch((e: unknown) => e)) as ExtractionError;

      expect(error.stage).toBe('xlsx');
      expect(String(error.error)).toContain('stream closed');
    });
  });
});
