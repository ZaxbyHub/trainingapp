/**
 * Document extraction factory.
 * Routes files to the appropriate extractor based on file extension.
 * Runs entirely in the browser - no server-side dependencies.
 */

import type { ExtractionResult, ExtractionError } from '../../types/document';
import { extractPdfText } from './pdf-extractor';
import { extractDocxText } from './docx-extractor';
import { extractXlsxText } from './xlsx-extractor';
import { extractTxtText } from './txt-extractor';
import { extractPptxText } from './pptx-extractor';

// Re-export all extractors for convenience
export { extractPdfText } from './pdf-extractor';
export { extractDocxText } from './docx-extractor';
export { extractXlsxText } from './xlsx-extractor';
export { extractTxtText } from './txt-extractor';
export { extractPptxText } from './pptx-extractor';

/**
 * Supported file extensions mapped to their extractor functions.
 */
const EXTRACTOR_MAP: Record<string, (file: File) => Promise<ExtractionResult>> = {
  '.pdf': extractPdfText,
  '.docx': extractDocxText,
  '.xlsx': extractXlsxText,
  '.txt': extractTxtText,
  '.md': extractTxtText,
  '.pptx': extractPptxText,
};

/**
 * Supported extensions for documentation.
 */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTRACTOR_MAP);

/**
 * Extract text from a document file.
 * Routes to the appropriate extractor based on file extension.
 *
 * @param file - The File object to extract text from
 * @returns Promise<ExtractionResult> containing extracted text and metadata
 * @throws ExtractionError if the file extension is not supported or extraction fails
 */
export async function extractDocument(file: File): Promise<ExtractionResult> {
  const fileName = file.name.toLowerCase();

  // Find matching extension
  const extension = findExtension(fileName);

  if (!extension) {
    throw {
      fileName: file.name,
      error: `Unsupported file type: no extension found`,
      stage: 'txt' as const,
    } satisfies ExtractionError;
  }

  const extractor = EXTRACTOR_MAP[extension];

  if (!extractor) {
    throw {
      fileName: file.name,
      error: `Unsupported file extension: ${extension}`,
      stage: getStageForExtension(extension),
    } satisfies ExtractionError;
  }

  return extractor(file);
}

/**
 * Find the file extension from a filename.
 * Handles filenames with multiple dots.
 *
 * @param fileName - The filename to parse
 * @returns The extension (e.g., '.pdf') or null if none found
 */
function findExtension(fileName: string): string | null {
  const lastDotIndex = fileName.lastIndexOf('.');

  if (lastDotIndex === -1 || lastDotIndex === fileName.length - 1) {
    return null;
  }

  return fileName.substring(lastDotIndex);
}

/**
 * Get the appropriate error stage for an unsupported extension.
 * Maps common extensions to their closest category.
 *
 * @param extension - The file extension (e.g., '.doc')
 * @returns The stage to use in ExtractionError
 */
function getStageForExtension(extension: string): ExtractionError['stage'] {
  switch (extension.toLowerCase()) {
    case '.pdf':
      return 'pdf';
    case '.docx':
    case '.doc':
      return 'docx';
    case '.xlsx':
    case '.xls':
      return 'xlsx';
    case '.pptx':
    case '.ppt':
      return 'pptx';
    default:
      return 'txt';
  }
}
