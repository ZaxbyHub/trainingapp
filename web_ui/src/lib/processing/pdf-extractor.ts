/**
 * PDF text extraction using pdfjs-dist.
 * Runs entirely in the browser using web workers.
 */

import * as pdfjsLib from 'pdfjs-dist';
import type { ExtractionResult, ExtractedPage, ExtractionError } from '../../types/document';

// Configure pdfjs-dist worker using Vite-compatible local import
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Lazy-initialized worker configuration.
// The pdf.js worker is shared across all getDocument() calls via
// GlobalWorkerOptions.workerSrc. We set this once and idempotently.
let _workerConfigured = false;
function configurePdfWorker(): void {
  if (_workerConfigured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
  _workerConfigured = true;
}

/**
 * Extract text content from a PDF file.
 * Handles encrypted and malformed PDFs gracefully.
 *
 * @param file - The PDF File object to extract text from
 * @returns Promise<ExtractionResult> containing extracted text and metadata
 * @throws ExtractionError if extraction fails at any stage
 */
export async function extractPdfText(file: File): Promise<ExtractionResult> {
  const fileName = file.name;
  configurePdfWorker(); // idempotent — safe to call on every extraction

  try {
    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();

    // Load PDF document
    const loadingTask = pdfjsLib.getDocument({
      data: arrayBuffer,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    });

    let pdf: pdfjsLib.PDFDocumentProxy;

    try {
      pdf = await loadingTask.promise;
    } catch (parseError: unknown) {
      const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
      if (errorMessage.includes('password') || errorMessage.includes('Password')) {
        throw {
          fileName,
          error: 'PDF is encrypted and requires a password to extract text',
          stage: 'pdf' as const,
        } satisfies ExtractionError;
      }
      throw {
        fileName,
        error: `Failed to parse PDF: ${errorMessage}`,
        stage: 'pdf' as const,
      } satisfies ExtractionError;
    }

    const pages: ExtractedPage[] = [];
    const pageCount = pdf.numPages;

    // Extract text from each page
    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      let page: pdfjsLib.PDFPageProxy | null = null;
      try {
        page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

        // Join text items with spaces, preserving structure
        const pageText = textContent.items
          .map((item) => {
            if ('str' in item) {
              return item.str;
            }
            return '';
          })
          .join(' ')
          .trim();

        // Skip pages with no extractable text
        if (pageText.length > 0) {
          pages.push({
            pageNumber: pageNum,
            text: pageText,
          });
        }
      } catch (pageError: unknown) {
        // Log page extraction error but continue with other pages
        const errorMessage = pageError instanceof Error ? pageError.message : String(pageError);
        console.warn(`Failed to extract text from page ${pageNum}:`, errorMessage);
      } finally {
        // Clean up per-page resources to prevent memory pressure for large PDFs
        if (page !== null) {
          page.cleanup();
        }
      }
    }

    // Build full text from extracted pages
    const fullText = pages.map((p) => p.text).join('\n\n');

    return {
      fullText,
      pages,
      metadata: {
        fileName,
        pageCount,
        fileSize: file.size,
        extractedAt: Date.now(),
      },
    };
  } catch (error: unknown) {
    // Re-throw ExtractionError as-is
    if (error && typeof error === 'object' && 'stage' in error && 'fileName' in error) {
      throw error;
    }

    // Wrap unknown errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw {
      fileName,
      error: `Unexpected error during PDF extraction: ${errorMessage}`,
      stage: 'pdf' as const,
    } satisfies ExtractionError;
  } finally {
    try { pdf.destroy(); } catch {}
  }
}

/**
 * Terminate the shared PDF.js worker. Call this on app shutdown or
 * when the processing service is disposed. The next extractPdfText()
 * call will lazily re-initialize the worker.
 *
 * Note: PDF.js does not expose a public API to terminate the worker
 * created by GlobalWorkerOptions. This function logs a warning to
 * document the expected behavior — workers are reclaimed by the
 * browser when the page unloads.
 */
export function terminatePdfWorker(): void {
  _workerConfigured = false;
  // PDF.js workers created via GlobalWorkerOptions cannot be explicitly
  // terminated; they are reclaimed by the browser on page unload.
  console.info('[pdf-extractor] Worker configuration reset. Next extraction will re-initialize.');
}
