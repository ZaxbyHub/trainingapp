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
 * MIME types compatible with each extension. Used by validateFileType()
 * to detect mismatches between the file's declared type and its extension.
 * A file with no MIME type (empty string) or application/octet-stream
 * is treated as "unknown" and accepted based on extension heuristic.
 */
const MIME_COMPATIBILITY: Record<string, readonly string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/zip'],
  '.txt': ['text/plain', 'text/markdown', 'application/octet-stream'],
  '.md':  ['text/plain', 'text/markdown', 'text/x-markdown', 'application/octet-stream'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint', 'application/zip'],
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

  const validationError = validateFileType(file, extension);
  if (validationError) {
    throw {
      fileName: file.name,
      error: validationError,
      stage: getStageForExtension(extension),
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
 * Validate that a file's MIME type is compatible with its extension.
 * Returns null if the file is valid, or a reason string if mismatched.
 *
 * Rules:
 * - Empty file.type or 'application/octet-stream' → accept (unknown type)
 * - MIME type not in compatibility list → reject (mismatch)
 * - Extension not in MIME_COMPATIBILITY → accept (no compatibility data)
 */
function validateFileType(file: File, extension: string): string | null {
  const mime = file.type?.toLowerCase() ?? '';
  if (!mime || mime === 'application/octet-stream') {
    return null; // unknown type, accept based on extension
  }
  const compatible = MIME_COMPATIBILITY[extension];
  if (!compatible) {
    return null; // no compatibility data, accept
  }
  if (!compatible.includes(mime)) {
    return `File type mismatch: extension "${extension}" is not compatible with MIME type "${mime}"`;
  }
  return null;
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
