/**
 * XLSX text extraction using SheetJS (xlsx package).
 * Runs entirely in the browser - no server-side dependencies.
 */

import * as XLSX from 'xlsx';
import type { ExtractionResult, ExtractedPage, ExtractionError } from '../../types/document';

/**
 * Extract text content from an XLSX file.
 * Handles malformed XLSX files gracefully.
 *
 * @param file - The XLSX File object to extract text from
 * @returns Promise<ExtractionResult> containing extracted text and metadata
 * @throws ExtractionError if extraction fails at any stage
 */
export async function extractXlsxText(file: File): Promise<ExtractionResult> {
  const fileName = file.name;

  try {
    // Read file as ArrayBuffer for SheetJS
    const arrayBuffer = await file.arrayBuffer();

    // Parse workbook
    const workbook = XLSX.read(arrayBuffer, {
      type: 'array',
      cellDates: true,
      cellNF: true,
    });

    const pages: ExtractedPage[] = [];
    let fullTextBuilder: string[] = [];
    let sheetCount = 0;

    // Process each sheet
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];

      if (!sheet || !sheet['!ref']) {
        // Skip empty sheets
        continue;
      }

      // Convert sheet to JSON to inspect contents. With `header: 1`, SheetJS
      // returns an array-of-arrays (each row is a cell array), NOT an array of
      // records — so the element type is `unknown[]`.
      const sheetData = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: '',
        blankrows: false,
      });

      // Filter out completely empty rows
      const nonEmptyRows = sheetData.filter((row: unknown[]) =>
        row.some((cell: unknown) => cell !== null && cell !== undefined && cell !== '')
      );

      if (nonEmptyRows.length === 0) {
        // Skip empty sheets
        continue;
      }

      sheetCount++;

      // Build text for this sheet
      const sheetTextLines: string[] = [];
      sheetTextLines.push(`Sheet: ${sheetName}`);

      // Process each row with row numbers
      for (let rowIndex = 0; rowIndex < nonEmptyRows.length; rowIndex++) {
        const row = nonEmptyRows[rowIndex];
        const rowNumber = rowIndex + 1;

        // Convert row cells to text
        const rowText = row
          .map((cell: unknown) => {
            if (cell === null || cell === undefined) {
              return '';
            }
            if (typeof cell === 'object') {
              // Handle Date objects and other special types
              if (cell instanceof Date) {
                return cell.toISOString();
              }
              return String(cell);
            }
            return String(cell);
          })
          .filter((cellText: string) => cellText.length > 0)
          .join('\t');

        if (rowText.length > 0) {
          sheetTextLines.push(`Row ${rowNumber}: ${rowText}`);
        }
      }

      const sheetText = sheetTextLines.join('\n');

      if (sheetText.length > 0) {
        pages.push({
          pageNumber: sheetCount,
          text: sheetText,
        });
        fullTextBuilder.push(sheetText);
      }
    }

    const fullText = fullTextBuilder.join('\n\n');

    // If no sheets had content, return empty result
    if (pages.length === 0) {
      return {
        fullText: '',
        pages: [
          {
            pageNumber: 1,
            text: '',
          },
        ],
        metadata: {
          fileName,
          pageCount: 0,
          fileSize: file.size,
          extractedAt: Date.now(),
        },
      };
    }

    return {
      fullText,
      pages,
      metadata: {
        fileName,
        pageCount: sheetCount,
        fileSize: file.size,
        extractedAt: Date.now(),
      },
    };
  } catch (error: unknown) {
    // Re-throw ExtractionError as-is
    if (error && typeof error === 'object' && 'stage' in error && 'fileName' in error) {
      throw error;
    }

    // Handle specific XLSX errors
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Detect corrupt or invalid XLSX
    if (
      errorMessage.includes('Invalid') ||
      errorMessage.includes('corrupt') ||
      errorMessage.includes('ENOENT') ||
      errorMessage.includes('not found') ||
      errorMessage.includes('Failed to parse')
    ) {
      throw {
        fileName,
        error: `Failed to extract XLSX: ${errorMessage}`,
        stage: 'xlsx' as const,
      } satisfies ExtractionError;
    }

    // Wrap unknown errors
    throw {
      fileName,
      error: `Unexpected error during XLSX extraction: ${errorMessage}`,
      stage: 'xlsx' as const,
    } satisfies ExtractionError;
  }
}
