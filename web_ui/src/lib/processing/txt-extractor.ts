/**
 * TXT/MD text extraction with encoding fallback.
 * Runs entirely in the browser - no server-side dependencies.
 */

import type { ExtractionResult, ExtractedPage, ExtractionError } from '../../types/document';

/**
 * Extract text content from a TXT or MD file.
 * Handles encoding detection with UTF-8 primary and windows-1252 fallback.
 *
 * @param file - The TXT/MD File object to extract text from
 * @returns Promise<ExtractionResult> containing extracted text and metadata
 * @throws ExtractionError if extraction fails at any stage
 */
export async function extractTxtText(file: File): Promise<ExtractionResult> {
  const fileName = file.name;

  try {
    // Try UTF-8 first
    let text = await tryReadAsEncoding(file, 'utf-8');

    // Check if UTF-8 produced replacement characters (indicates wrong encoding)
    if (containsReplacementCharacters(text)) {
      // Fallback to windows-1252 / latin-1
      console.warn(`UTF-8 decoding failed for ${fileName}, trying windows-1252`);
      text = await tryReadAsEncoding(file, 'windows-1252');
    }

    // Trim trailing whitespace but preserve internal structure
    const trimmedText = text.trim();

    // TXT/MD doesn't have pages, but we track as a single "page" for consistency
    const pages: ExtractedPage[] = [
      {
        pageNumber: 1,
        text: trimmedText,
      },
    ];

    // Build full text
    const fullText = trimmedText;

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

    // Handle specific encoding errors
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Wrap unknown errors
    throw {
      fileName,
      error: `Unexpected error during TXT extraction: ${errorMessage}`,
      stage: 'txt' as const,
    } satisfies ExtractionError;
  }
}

/**
 * Attempt to read a file with a specific text encoding.
 *
 * @param file - The File object to read
 * @param encoding - The encoding to use (e.g., 'utf-8', 'windows-1252')
 * @returns Promise<string> with decoded text
 */
async function tryReadAsEncoding(file: File, encoding: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        // If result is ArrayBuffer, decode manually
        const decoder = new TextDecoder(encoding);
        const text = decoder.decode(reader.result);
        resolve(text);
      }
    };

    reader.onerror = () => {
      reject(new Error(`Failed to read file as ${encoding}: ${reader.error?.message ?? 'Unknown error'}`));
    };

    // Read as text - modern browsers support encoding parameter
    reader.readAsText(file, encoding);
  });
}

/**
 * Check if text contains Unicode replacement characters.
 * This indicates the wrong encoding was used.
 *
 * @param text - The text to check
 * @returns true if replacement characters are present
 */
function containsReplacementCharacters(text: string): boolean {
  // Unicode replacement character is U+FFFD
  return text.includes('\uFFFD');
}
