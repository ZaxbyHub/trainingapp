/**
 * Semantic text chunking for RAG pipeline.
 * Ports the Python DocumentProcessor chunking algorithm to TypeScript.
 * Runs entirely in the browser - no server-side dependencies.
 */

import type { DocumentChunk, ExtractedPage } from '../../types/document';

const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'jr', 'sr', 'st', 'ave', 'blvd',
  'dept', 'rev', 'vol', 'fig', 'ed', 'eds', 'repr', 'trans', 'pt',
  'ch', 'sec', 'app', 'ex', 'cf', 'eg', 'ie', 'etc', 'approx',
  'esp', 'viz', 'al', 'vs', 'inc', 'corp', 'ltd', 'govt', 'est',
  'acct', 'tel', 'ref',
]);

/**
 * Text chunker that splits documents into overlapping chunks
 * while respecting sentence and paragraph boundaries.
 */
export class TextChunker {
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;

  /**
   * Create a new TextChunker.
   *
   * @param chunkSize - Target number of words per chunk (default: 256)
   * @param chunkOverlap - Number of words to overlap between chunks (default: 100)
   * @throws Error if chunkSize <= 0, chunkOverlap < 0, or chunkOverlap >= chunkSize
   */
  constructor(chunkSize: number = 256, chunkOverlap: number = 100) {
    if (chunkSize <= 0) {
      throw new Error(`chunk_size must be positive, got ${chunkSize}`);
    }
    if (chunkOverlap < 0) {
      throw new Error(`chunk_overlap must be non-negative, got ${chunkOverlap}`);
    }
    if (chunkOverlap >= chunkSize) {
      throw new Error(
        `chunk_overlap (${chunkOverlap}) must be less than chunk_size (${chunkSize})`
      );
    }
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  /**
   * Clean and normalize text while preserving paragraph and list structure.
   * Ports Python's clean_text method.
   *
   * @param text - Raw text to clean
   * @returns Cleaned text
   */
  cleanText(text: string): string {
    let result = String(text);

    // Step 1: Normalize line endings to \n
    result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Step 2: Collapse runs of 3+ blank lines to exactly 2 (paragraph break)
    result = result.replace(/\n{3,}/g, '\n\n');

    // Step 3: Collapse horizontal whitespace (spaces/tabs) within each line,
    // but DO NOT collapse \n characters
    const lines = result.split('\n');
    result = lines
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n');

    // Step 4: Remove empty lines that are not paragraph breaks
    // (single blank lines between non-empty lines are preserved as \n\n)
    result = result.replace(/\n{2,}/g, '\n\n');

    return result.trim();
  }

  /**
   * Split paragraph into sentences, respecting common abbreviations.
   * Ports Python's _split_sentences method.
   *
   * @param paragraph - Text to split into sentences
   * @returns Array of sentence strings
   */
  splitSentences(paragraph: string): string[] {
    // Protect abbreviations by temporarily replacing '.' with null char
    let protected_ = paragraph;
    for (const abbr of ABBREVIATIONS) {
      protected_ = protected_.replace(
        new RegExp(`\\b${abbr}\\.`, 'gi'),
        `${abbr}\x00`
      );
    }

    // Protect single initials (A., B., etc.)
    protected_ = protected_.replace(/\b([A-Z])\./g, '$1\x00');

    // Split on sentence boundaries (after .!?) followed by whitespace
    const sentences = protected_.split(/(?<=[.!?])\s+/);

    return sentences
      .map((s) => s.replace(/\x00/g, '.').trim())
      .filter((s) => s.trim());
  }

  /**
   * Calculate sentences to keep for overlap from the end of a chunk.
   * Ports Python's _calculate_overlap method.
   *
   * @param sentences - Array of sentences in the current chunk
   * @param overlapSize - Maximum word count for overlap
   * @returns Tuple of [overlap sentences, overlap word count]
   */
  private calculateOverlap(
    sentences: string[],
    overlapSize: number
  ): [string[], number] {
    const overlapSentences: string[] = [];
    let overlapWordCount = 0;

    for (let i = sentences.length - 1; i >= 0; i--) {
      const s = sentences[i];
      const sWordCount = s.split(/\s+/).length;

      if (overlapWordCount + sWordCount <= overlapSize) {
        overlapSentences.unshift(s);
        overlapWordCount += sWordCount;
      } else {
        break;
      }
    }

    return [overlapSentences, overlapWordCount];
  }

  /**
   * Find the page number for a chunk text using prefix matching.
   * Ports Python's internal _find_page helper.
   *
   * @param chunkText - The chunk text to match
   * @param paraPageMap - Map of text prefixes to page numbers
   * @returns Page number or undefined if not found
   */
  private findPage(
    chunkText: string,
    paraPageMap: Map<string, number>
  ): number | undefined {
    if (!paraPageMap.size) {
      return undefined;
    }

    // Try longest prefix match first
    for (let length = chunkText.length; length > 0; length--) {
      const prefix = chunkText.slice(0, length).trim();
      if (prefix && paraPageMap.has(prefix)) {
        return paraPageMap.get(prefix);
      }
    }

    return undefined;
  }

  /**
   * Split text into overlapping chunks respecting paragraph and sentence boundaries.
   * Ports Python's chunk_text method.
   *
   * @param text - Full text to chunk
   * @param source - Source identifier (e.g., filename)
   * @param pages - Optional array of extracted pages for page number mapping
   * @returns Array of document chunks
   */
  chunkText(
    text: string,
    source: string,
    pages?: ExtractedPage[]
  ): DocumentChunk[] {
    text = this.cleanText(text);

    // Build page mapping from PDF pages
    const paraPageMap = new Map<string, number>();
    if (pages) {
      for (const page of pages) {
        const cleaned = page.text.trim().replace(/\s+/g, ' ');
        for (const segment of cleaned.split('\n\n')) {
          const seg = segment.trim();
          if (seg) {
            // Store first 80 chars as key (same as Python)
            paraPageMap.set(seg.slice(0, 80), page.pageNumber);
          }
        }
      }
    }

    const paragraphs = text.split('\n\n').filter((p) => p.trim());

    const chunks: DocumentChunk[] = [];
    let chunkIndex = 0;
    let currentChunkSentences: string[] = [];
    let currentChunkWordCount = 0;

    for (const paragraph of paragraphs) {
      const sentences = this.splitSentences(paragraph);

      for (let sentence of sentences) {
        sentence = sentence.trim();
        if (!sentence) {
          continue;
        }

        const sentenceWordCount = sentence.split(/\s+/).length;

        // If sentence alone exceeds chunk_size and we're starting fresh
        if (
          sentenceWordCount > this.chunkSize &&
          currentChunkSentences.length === 0
        ) {
          // Split sentence into word chunks
          const words = sentence.split(/\s+/);
          while (words.length > 0) {
            const chunkWords = words.slice(0, this.chunkSize);
            const chunkTextStr = chunkWords.join(' ');

            chunks.push({
              text: chunkTextStr,
              source,
              chunkIndex,
              page: this.findPage(chunkTextStr, paraPageMap),
            });
            chunkIndex++;

            words.splice(0, this.chunkSize);

            if (words.length > 0) {
              // Overlap handling for split sentence
              const overlapWords =
                this.chunkOverlap > 0
                  ? chunkWords.slice(-Math.floor(this.chunkOverlap / 2))
                  : [];
              words.unshift(...overlapWords);
            }
          }
          continue; // Move to next sentence
        }

        // If adding this sentence would exceed chunk_size, finalize current chunk
        if (
          currentChunkSentences.length > 0 &&
          currentChunkWordCount + sentenceWordCount > this.chunkSize
        ) {
          const chunkTextStr = currentChunkSentences.join(' ');
          chunks.push({
            text: chunkTextStr,
            source,
            chunkIndex,
            page: this.findPage(chunkTextStr, paraPageMap),
          });
          chunkIndex++;

          // Handle overlap using helper method
          const [overlapSentences, overlapWordCount] = this.calculateOverlap(
            currentChunkSentences,
            this.chunkOverlap
          );
          currentChunkSentences = overlapSentences;
          currentChunkWordCount = overlapWordCount;
        }

        currentChunkSentences.push(sentence);
        currentChunkWordCount += sentenceWordCount;
      }
    }

    // Don't forget the last chunk
    if (currentChunkSentences.length > 0) {
      const chunkTextStr = currentChunkSentences.join(' ');
      chunks.push({
        text: chunkTextStr,
        source,
        chunkIndex,
        page: this.findPage(chunkTextStr, paraPageMap),
      });
    }

    return chunks;
  }

  /**
   * Generate a document ID from a source path using SHA-256.
   * Uses Web Crypto API for browser compatibility.
   *
   * @param sourcePath - The file path to hash
   * @returns Promise resolving to 16-character hex string
   */
  async generateDocId(sourcePath: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(sourcePath);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return hashHex.slice(0, 16);
  }
}

/**
 * Convenience function to chunk a document without instantiating TextChunker.
 *
 * @param text - Full text to chunk
 * @param source - Source identifier (e.g., filename)
 * @param pages - Optional array of extracted pages for page number mapping
 * @param chunkSize - Target number of words per chunk (default: 256)
 * @param chunkOverlap - Number of words to overlap between chunks (default: 100)
 * @returns Array of document chunks
 */
export function chunkDocument(
  text: string,
  source: string,
  pages?: ExtractedPage[],
  chunkSize: number = 256,
  chunkOverlap: number = 100
): DocumentChunk[] {
  const chunker = new TextChunker(chunkSize, chunkOverlap);
  return chunker.chunkText(text, source, pages);
}
