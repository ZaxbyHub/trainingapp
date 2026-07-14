/**
 * Semantic text chunking for RAG pipeline.
 * Ports the Python DocumentProcessor chunking algorithm to TypeScript.
 * Runs entirely in the browser - no server-side dependencies.
 */

import type { DocumentChunk, ExtractedPage } from '../../types/document';

const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'jr', 'sr', 'st', 'ave', 'blvd',
  'dept', 'rev', 'vol', 'fig', 'ed', 'eds', 'repr', 'trans', 'pt',
  'ch', 'sec', 'app', 'ex', 'cf', 'etc', 'approx',
  'esp', 'viz', 'al', 'vs', 'inc', 'corp', 'ltd', 'govt', 'est',
  'acct', 'tel', 'ref',
  // F9: 'eg'/'ie' removed from the contiguous set — they never matched real
  // dotted text (e.g./i.e.). Dotted forms are handled separately below.
]);

/**
 * Dotted multi-letter abbreviations (F9) written with internal periods, e.g.
 * "e.g." and "i.e.". Each entry is [firstLetter, secondLetter]; the protector
 * replaces the periods with the null marker so they don't trigger a sentence
 * split, preserving the original casing of both letters.
 */
const DOTTED_ABBREVIATIONS: ReadonlyArray<readonly [string, string]> = [
  ['e', 'g'],
  ['i', 'e'],
];

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
   * F9: abbreviation protection now PRESERVES the original casing (previously
   * it lowercased protected abbreviations, e.g. "Dr." -> "dr."). Dotted forms
   * (e.g./i.e.) are also protected.
   *
   * F6: CJK sentence terminators (。！？) are recognized as boundaries so CJK
   * text without ASCII whitespace/punctuation is still segmented.
   *
   * @param paragraph - Text to split into sentences
   * @returns Array of sentence strings
   */
  splitSentences(paragraph: string): string[] {
    // Protect abbreviations by temporarily replacing '.' with null char.
    // F9: capture the matched token so the original casing is restored (the
    // previous code substituted a lowercase literal, corrupting "Dr." -> "dr.").
    let protected_ = paragraph;
    for (const abbr of ABBREVIATIONS) {
      protected_ = protected_.replace(
        new RegExp(`\\b(${abbr})\\.`, 'gi'),
        (_m, g1) => `${g1}\x00`
      );
    }

    // F9: protect dotted abbreviations (e.g., i.e.) preserving case of both letters.
    for (const [a, b] of DOTTED_ABBREVIATIONS) {
      protected_ = protected_.replace(
        new RegExp(`\\b(${a})\\.(${b})\\.`, 'gi'),
        (_m, g1, g2) => `${g1}\x00${g2}\x00`
      );
    }

    // Protect single initials (A., B., etc.)
    protected_ = protected_.replace(/\b([A-Z])\./g, '$1\x00');

    // Split on sentence boundaries: ASCII (.!?) followed by whitespace, OR CJK
    // terminators (。！？) which need no trailing whitespace (F6).
    const sentences = protected_.split(/(?<=[.!?])\s+|(?<=[。！？])/);

    return sentences
      .map((s) => s.replace(/\x00/g, '.').trim())
      .filter((s) => s.trim());
  }

  /**
   * Calculate sentences to keep for overlap from the end of a chunk.
   * Ports Python's _calculate_overlap method.
   *
   * F6: unit-aware — counts characters for CJK-dense sentences, words
   * otherwise, matching the chunk-sizing decision.
   *
   * @param sentences - Array of sentences in the current chunk
   * @param overlapSize - Maximum unit count for overlap
   * @returns Tuple of [overlap sentences, overlap unit count]
   */
  private calculateOverlap(
    sentences: string[],
    overlapSize: number
  ): [string[], number] {
    const overlapSentences: string[] = [];
    let overlapUnitCount = 0;

    for (let i = sentences.length - 1; i >= 0; i--) {
      const s = sentences[i];
      const sUnitCount = this.countUnits(s);

      if (overlapUnitCount + sUnitCount <= overlapSize) {
        overlapSentences.unshift(s);
        overlapUnitCount += sUnitCount;
      } else {
        break;
      }
    }

    return [overlapSentences, overlapUnitCount];
  }

  /**
   * F8: find the page whose [startChar, endChar) range contains the chunk's
   * start offset into the cleaned full text. Replaces the unreliable prefix
   * matching (which only attributed chunk 0 correctly). Falls back to
   * undefined when no page boundaries were provided or none contain the offset.
   */
  private findPageByOffset(
    offset: number,
    pageBoundaries: Array<{ pageNumber: number; startChar: number; endChar: number }>
  ): number | undefined {
    if (pageBoundaries.length === 0) {
      return undefined;
    }
    for (const b of pageBoundaries) {
      if (offset >= b.startChar && offset < b.endChar) {
        return b.pageNumber;
      }
    }
    // Offset at/after the last page boundary (e.g. trailing whitespace) → last page.
    const last = pageBoundaries[pageBoundaries.length - 1];
    if (offset >= last.startChar) {
      return last.pageNumber;
    }
    return undefined;
  }

  /**
   * F6: detect whether text is CJK-dense (or otherwise lacks whitespace word
   * boundaries). When true, the chunker switches from word-count to
   * character-count sizing so such documents don't collapse into one giant
   * chunk.
   *
   * Heuristic: count whitespace characters. Real CJK / no-space text has
   * essentially ZERO spaces, so the space-to-character ratio is the most
   * reliable signal. A threshold of "< 1 space per 20 characters" catches CJK
   * paragraphs (which have no inter-word spaces) while leaving normal English
   * (≈1 space per 5-6 chars) on the word-based path. The earlier avg-token-
   * length > 6 heuristic was too aggressive: English with 6+ char words
   * (e.g. "word0 word1 ...") falsely tripped it.
   */
  private isCjkDense(text: string): boolean {
    if (text.length === 0) {
      return false;
    }
    const spaceCount = (text.match(/\s/g) ?? []).length;
    // Fewer than 1 whitespace char per 20 characters → treat as space-less.
    return spaceCount * 20 < text.length;
  }

  /**
   * F6: count "units" in text — words for whitespace-delimited text, characters
   * for CJK-dense text. Returns the count to use for chunk-size decisions.
   */
  private countUnits(text: string): number {
    if (this.isCjkDense(text)) {
      return text.length;
    }
    return text.split(/\s+/).filter(Boolean).length;
  }

  /**
   * F6: split a unit string into N pieces for CJK-dense (character-based) or
   * ASCII (word-based) text. Returns the joined piece and the consumed units.
   */
  private sliceUnits(text: string, count: number): string {
    if (this.isCjkDense(text)) {
      return text.slice(0, count);
    }
    return text.split(/\s+/).slice(0, count).join(' ');
  }

  /**
   * F6: take the trailing `count` units from text (for overlap).
   */
  private trailingUnits(text: string, count: number): string {
    if (this.isCjkDense(text)) {
      return count > 0 ? text.slice(-count) : '';
    }
    const words = text.split(/\s+/);
    return words.slice(-count).join(' ');
  }

  /**
   * Split text into overlapping chunks respecting paragraph and sentence boundaries.
   *
   * F6: CJK/no-whitespace text is chunked by character count instead of word
   * count, so it doesn't collapse into a single mega-chunk.
   * F7: the long-sentence split loop now guarantees forward progress for every
   * overlap value (overlap=1 no longer loops forever).
   * F8: page attribution uses each chunk's char offset into the cleaned full
   * text, cross-referenced against per-page boundaries, instead of prefix
   * matching. Offsets are assigned in a post-processing pass (forward substring
   * search in whitespace-normalized space) so the chunking state machine stays
   * simple and the attribution is robust against paragraph-boundary joins.
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
    const cleanedText = this.cleanText(text);

    const paragraphs = cleanedText.split('\n\n').filter((p) => p.trim());

    const chunks: DocumentChunk[] = [];
    let chunkIndex = 0;
    let currentChunkSentences: string[] = [];
    let currentChunkUnitCount = 0;

    for (const paragraph of paragraphs) {
      const sentences = this.splitSentences(paragraph);

      for (let sentence of sentences) {
        sentence = sentence.trim();
        if (!sentence) {
          continue;
        }

        const sentenceUnitCount = this.countUnits(sentence);

        // If sentence alone exceeds chunk_size and we're starting fresh
        if (
          sentenceUnitCount > this.chunkSize &&
          currentChunkSentences.length === 0
        ) {
          // Split the (over-long) sentence into unit chunks.
          // F6: ASCII → word-based; CJK-dense → character-based.
          const cjk = this.isCjkDense(sentence);
          let remaining = sentence;
          // Safety cap to guarantee termination even if a future edit breaks the
          // overlap invariant (defense in depth for F7).
          let guard = 0;
          const guardMax = Math.ceil(sentence.length / Math.max(1, this.chunkSize)) * 4 + 16;
          while (remaining.trim().length > 0 && guard++ < guardMax) {
            const remainingUnits = cjk ? remaining.length : remaining.split(/\s+/).length;
            if (remainingUnits === 0) {
              break;
            }
            const piece = this.sliceUnits(remaining, this.chunkSize);

            chunks.push({
              text: piece,
              source,
              chunkIndex,
            });
            chunkIndex++;

            // Remove the consumed units from `remaining`.
            if (cjk) {
              remaining = remaining.slice(this.chunkSize);
            } else {
              remaining = remaining.split(/\s+/).slice(this.chunkSize).join(' ');
            }

            if (remaining.trim().length > 0) {
              // F7: overlap handling for the split sentence. Guarantee forward
              // progress: overlapCount is at least 1 when overlap>0, and is
              // strictly less than the piece's unit count (min with chunkSize-1),
              // so each iteration consumes more than it re-adds. Previously
              // `slice(-Math.floor(overlap/2))` made overlap=1 take the ENTIRE
              // chunk (slice(-0)===slice(0)) and the loop never terminated.
              const overlapCount =
                this.chunkOverlap > 0
                  ? Math.min(Math.max(1, Math.floor(this.chunkOverlap / 2)), this.chunkSize - 1)
                  : 0;
              if (overlapCount > 0) {
                const overlapPiece = this.trailingUnits(piece, overlapCount);
                remaining = cjk
                  ? overlapPiece + remaining
                  : [overlapPiece, remaining].filter(Boolean).join(' ');
              }
            }
          }
          continue; // Move to next sentence
        }

        // If adding this sentence would exceed chunk_size, finalize current chunk
        if (
          currentChunkSentences.length > 0 &&
          currentChunkUnitCount + sentenceUnitCount > this.chunkSize
        ) {
          const chunkTextStr = currentChunkSentences.join(' ');
          chunks.push({
            text: chunkTextStr,
            source,
            chunkIndex,
          });
          chunkIndex++;

          // Handle overlap using helper method
          const [overlapSentences, overlapUnitCount] = this.calculateOverlap(
            currentChunkSentences,
            this.chunkOverlap
          );
          currentChunkSentences = overlapSentences;
          currentChunkUnitCount = overlapUnitCount;
        }

        currentChunkSentences.push(sentence);
        currentChunkUnitCount += sentenceUnitCount;
      }
    }

    // Don't forget the last chunk
    if (currentChunkSentences.length > 0) {
      const chunkTextStr = currentChunkSentences.join(' ');
      chunks.push({
        text: chunkTextStr,
        source,
        chunkIndex,
      });
    }

    // F8: assign charOffset + page attribution in a post-processing pass. Build
    // a whitespace-normalized view of the full text and locate each chunk's
    // (similarly normalized) text with a forward-only cursor, so attribution is
    // robust against paragraph-boundary joins. Page boundaries are computed in
    // the SAME normalized space from the cleaned page texts.
    this.assignOffsetsAndPages(chunks, cleanedText, pages);

    return chunks;
  }

  /**
   * F8: assign `charOffset` and `page` to each chunk by locating its text in a
   * whitespace-normalized view of the cleaned full text. Page boundaries are
   * derived from cleaned+normalized page texts (cumulative offsets + single-
   * space separators), matching the normalized full text. A forward-only cursor
   * keeps each chunk's offset monotonically increasing even with overlap.
   */
  private assignOffsetsAndPages(
    chunks: DocumentChunk[],
    cleanedFullText: string,
    pages?: ExtractedPage[]
  ): void {
    // Whitespace-normalize the full text: collapse all runs (\n\n paragraph
    // breaks and intra-sentence spaces) to single spaces. Chunk texts are built
    // by joining sentences with single spaces, so they match this view.
    const normalizedFull = cleanedFullText.replace(/\s+/g, ' ').trim();

    // Build page boundaries in the same normalized space.
    const pageBoundaries: Array<{ pageNumber: number; startChar: number; endChar: number }> = [];
    if (pages && pages.length > 0) {
      let offset = 0;
      for (const page of pages) {
        const normalizedPage = this.cleanText(page.text).replace(/\s+/g, ' ').trim();
        if (normalizedPage.length === 0) {
          continue;
        }
        const start = offset;
        const end = start + normalizedPage.length;
        pageBoundaries.push({ pageNumber: page.pageNumber, startChar: start, endChar: end });
        offset = end + 1; // +1 for the single-space separator in normalized space
      }
    }

    let cursor = 0;
    for (const chunk of chunks) {
      const needle = chunk.text.replace(/\s+/g, ' ').trim();
      if (needle.length === 0) {
        continue;
      }
      // Forward-only search: find the chunk's text at or after the cursor.
      let idx = normalizedFull.indexOf(needle, cursor);
      if (idx === -1) {
        // Fall back to a search from the start (overlap may have rewound past
        // the cursor in edge cases). If still not found, leave the offset/page
        // unset rather than attributing incorrectly.
        idx = normalizedFull.indexOf(needle);
        if (idx === -1) {
          continue;
        }
      }
      chunk.charOffset = idx;
      chunk.page = this.findPageByOffset(idx, pageBoundaries);
      // Advance the cursor past this chunk's start so the next chunk (which
      // begins later in the document) is located after it. Use idx + 1 rather
      // than idx + needle.length so overlapping chunks (which share a suffix
      // with the previous chunk) are still found at their correct position.
      cursor = idx + 1;
    }
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
