/**
 * PPTX text extraction using JSZip + XML parsing.
 * PPTX files are ZIP archives containing XML slides.
 * Runs entirely in the browser - no server-side dependencies.
 */

import JSZip from 'jszip';
import type { ExtractionResult, ExtractedPage, ExtractionError } from '../../types/document';

/**
 * Extract text content from a PPTX file.
 * Handles malformed PPTX files gracefully.
 *
 * @param file - The PPTX File object to extract text from
 * @returns Promise<ExtractionResult> containing extracted text and metadata
 * @throws ExtractionError if extraction fails at any stage
 */
export async function extractPptxText(file: File): Promise<ExtractionResult> {
  const fileName = file.name;

  try {
    // Read file as ArrayBuffer for JSZip
    const arrayBuffer = await file.arrayBuffer();

    // Open PPTX as ZIP archive
    const zip = await JSZip.loadAsync(arrayBuffer);

    // Find all slide files matching ppt/slides/slide{N}.xml
    const slideFiles: { number: number; path: string }[] = [];

    for (const relativePath in zip.files) {
      const entry = zip.files[relativePath];
      if (entry.dir) {
        continue;
      }

      // Match ppt/slides/slide{N}.xml pattern
      const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
      if (match) {
        const slideNumber = parseInt(match[1], 10);
        slideFiles.push({ number: slideNumber, path: relativePath });
      }
    }

    // Sort slides numerically by their number (slide1, slide2, ..., slide10)
    slideFiles.sort((a, b) => a.number - b.number);

    if (slideFiles.length === 0) {
      // No slides found - return empty result
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

    const pages: ExtractedPage[] = [];
    const fullTextParts: string[] = [];

    // Use DOMParser for XML parsing (browser built-in)
    const domParser = new DOMParser();

    for (const slide of slideFiles) {
      const zipEntry = zip.files[slide.path];
      if (!zipEntry) {
        // Skip if entry not found
        continue;
      }

      // Read slide XML content as string
      const slideXml = await zipEntry.async('string');

      // Parse XML
      const doc = domParser.parseFromString(slideXml, 'text/xml');

      // Check for XML parsing errors
      const parseError = doc.querySelector('parsererror');
      if (parseError) {
        // Skip slides with corrupt XML
        continue;
      }

      // Extract all <a:t> text elements
      const textElements = doc.querySelectorAll('a\\:t');
      const slideTextParts: string[] = [];

      for (const element of textElements) {
        const textContent = element.textContent;
        if (textContent && textContent.trim().length > 0) {
          slideTextParts.push(textContent.trim());
        }
      }

      const slideText = slideTextParts.join(' ');

      // Skip slides with no extractable text
      if (slideText.length === 0) {
        continue;
      }

      pages.push({
        pageNumber: slide.number,
        text: slideText,
      });
      fullTextParts.push(slideText);
    }

    const fullText = fullTextParts.join('\n\n');

    // If no slides had content, return empty result
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
        pageCount: pages.length,
        fileSize: file.size,
        extractedAt: Date.now(),
      },
    };
  } catch (error: unknown) {
    // Re-throw ExtractionError as-is
    if (error && typeof error === 'object' && 'stage' in error && 'fileName' in error) {
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    // Detect specific PPTX/ZIP errors
    if (
      errorMessage.includes('Invalid') ||
      errorMessage.includes('corrupt') ||
      errorMessage.includes('ENOENT') ||
      errorMessage.includes('not found') ||
      errorMessage.includes('Failed to parse') ||
      errorMessage.includes('end of central directory') ||
      errorMessage.includes('zip')
    ) {
      throw {
        fileName,
        error: `Failed to extract PPTX: ${errorMessage}`,
        stage: 'pptx' as const,
      } satisfies ExtractionError;
    }

    // Wrap unknown errors
    throw {
      fileName,
      error: `Unexpected error during PPTX extraction: ${errorMessage}`,
      stage: 'pptx' as const,
    } satisfies ExtractionError;
  }
}
