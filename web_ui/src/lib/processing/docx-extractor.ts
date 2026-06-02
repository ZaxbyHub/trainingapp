/**
 * DOCX text extraction using mammoth.js.
 * Runs entirely in the browser - no server-side dependencies.
 */

import mammoth from 'mammoth';
import type { ExtractionResult, ExtractedPage, ExtractionError } from '../../types/document';

/**
 * Extract text content from a DOCX file.
 * Handles malformed DOCX files gracefully (corrupt ZIP, missing content types).
 *
 * @param file - The DOCX File object to extract text from
 * @returns Promise<ExtractionResult> containing extracted text and metadata
 * @throws ExtractionError if extraction fails at any stage
 */
export async function extractDocxText(file: File): Promise<ExtractionResult> {
  const fileName = file.name;

  try {
    // Read file as ArrayBuffer for mammoth
    const arrayBuffer = await file.arrayBuffer();

    // Extract raw text from DOCX using mammoth
    const result = await mammoth.extractRawText({ arrayBuffer });

    const text = result.value;

    // DOCX doesn't have pages, but we track as a single "page" for consistency
    const pages: ExtractedPage[] = [
      {
        pageNumber: 1,
        text: text,
      },
    ];

    // Build full text
    const fullText = text;

    // Check for extraction warnings but don't fail on them
    if (result.messages && result.messages.length > 0) {
      console.warn('DOCX extraction warnings:', result.messages);
    }

    return {
      fullText,
      pages,
      metadata: {
        fileName,
        pageCount: 1,
        fileSize: file.size,
        extractedAt: Date.now(),
      },
    };
  } catch (error: unknown) {
    // Re-throw ExtractionError as-is
    if (error && typeof error === 'object' && 'stage' in error && 'fileName' in error) {
      throw error;
    }

    // Handle specific mammoth errors
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Detect corrupt ZIP / invalid DOCX
    if (
      errorMessage.includes('ZIP') ||
      errorMessage.includes('Invalid') ||
      errorMessage.includes('corrupt') ||
      errorMessage.includes('ENOENT') ||
      errorMessage.includes('not found')
    ) {
      throw {
        fileName,
        error: `Failed to extract DOCX: ${errorMessage}`,
        stage: 'docx' as const,
      } satisfies ExtractionError;
    }

    // Wrap unknown errors
    throw {
      fileName,
      error: `Unexpected error during DOCX extraction: ${errorMessage}`,
      stage: 'docx' as const,
    } satisfies ExtractionError;
  }
}
