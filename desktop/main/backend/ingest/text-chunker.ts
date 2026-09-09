// ingest/text-chunker.ts — Node-side semantic text chunker (issue #64, B6).
//
// Faithful port of web_ui/src/lib/processing/text-chunker.ts (256-word/100-
// overlap defaults, F9 abbreviation protection, F6 space-ratio CJK fallback
// with character-based sizing, F7 guaranteed overlap progress, F8 offset/page
// attribution) so desktop ingestion chunks byte-identically to the browser
// surface. The browser module's generateDocId(path) is DELIBERATELY NOT
// ported: identity derived from a file path is the stale-chunk defect class
// this pipeline eradicates (see docs/adr + 08a-recurrence-sweep.md) — doc and
// chunk identity live in ingest/pipeline.ts as content hashes.
import type { ExtractionPage } from './extractors.js';

const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'jr', 'sr', 'st', 'ave', 'blvd',
  'dept', 'rev', 'vol', 'fig', 'ed', 'eds', 'repr', 'trans', 'pt',
  'ch', 'sec', 'app', 'ex', 'cf', 'etc', 'approx',
  'esp', 'viz', 'al', 'vs', 'inc', 'corp', 'ltd', 'govt', 'est',
  'acct', 'tel', 'ref',
]);

/** Dotted multi-letter abbreviations ("e.g.", "i.e.") — protected like F9. */
const DOTTED_ABBREVIATIONS: ReadonlyArray<readonly [string, string]> = [
  ['e', 'g'],
  ['i', 'e'],
];

/** One output chunk: text plus its index and (when derivable) page attribution. */
export interface ChunkRow {
  text: string;
  chunkIndex: number;
  page?: number;
  charOffset?: number;
}

interface PageBoundary {
  pageNumber: number;
  startChar: number;
  endChar: number;
}

/**
 * Split documents into overlapping chunks respecting sentence and paragraph
 * boundaries. Behavior contract is the web_ui TextChunker (see module header).
 */
export class TextChunker {
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;

  constructor(chunkWordCount: number = 256, chunkOverlapWords: number = 100) {
    if (chunkWordCount <= 0) {
      throw new Error(`chunk_size must be positive, got ${chunkWordCount}`);
    }
    if (chunkOverlapWords < 0) {
      throw new Error(`chunk_overlap must be non-negative, got ${chunkOverlapWords}`);
    }
    if (chunkOverlapWords >= chunkWordCount) {
      throw new Error(
        `chunk_overlap (${chunkOverlapWords}) must be less than chunk_size (${chunkWordCount})`,
      );
    }
    this.chunkSize = chunkWordCount;
    this.chunkOverlap = chunkOverlapWords;
  }

  /** Clean and normalize text while preserving paragraph structure. */
  cleanText(text: string): string {
    let result = String(text);
    result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    result = result.replace(/\n{3,}/g, '\n\n');
    result = result
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n');
    result = result.replace(/\n{2,}/g, '\n\n');
    return result.trim();
  }

  /** Split a paragraph into sentences, respecting common abbreviations. */
  splitSentences(paragraph: string): string[] {
    let protectedText = paragraph;
    for (const abbr of ABBREVIATIONS) {
      protectedText = protectedText.replace(
        new RegExp(`\\b(${abbr})\\.`, 'gi'),
        (_m, g1: string) => `${g1}\x00`,
      );
    }
    for (const [a, b] of DOTTED_ABBREVIATIONS) {
      protectedText = protectedText.replace(
        new RegExp(`\\b(${a})\\.(${b})\\.`, 'gi'),
        (_m, g1: string, g2: string) => `${g1}\x00${g2}\x00`,
      );
    }
    protectedText = protectedText.replace(/\b([A-Z])\./g, '$1\x00');
    const sentences = protectedText.split(/(?<=[.!?])\s+|(?<=[。！？])/);
    return sentences
      .map((s) => s.replace(/\x00/g, '.').trim())
      .filter((s) => s.trim());
  }

  /** F6: space-ratio CJK detection — fewer than 1 whitespace per 20 chars. */
  private isCjkDense(text: string): boolean {
    if (text.length === 0) return false;
    const spaceCount = (text.match(/\s/g) ?? []).length;
    return spaceCount * 20 < text.length;
  }

  /** F6: words for whitespace-delimited text, characters for CJK-dense text. */
  private countUnits(text: string): number {
    if (this.isCjkDense(text)) return text.length;
    return text.split(/\s+/).filter(Boolean).length;
  }

  private sliceUnits(text: string, count: number): string {
    if (this.isCjkDense(text)) return text.slice(0, count);
    return text.split(/\s+/).slice(0, count).join(' ');
  }

  private trailingUnits(text: string, count: number): string {
    if (this.isCjkDense(text)) return count > 0 ? text.slice(-count) : '';
    return text.split(/\s+/).slice(-count).join(' ');
  }

  /** Sentences kept from the end of a chunk for the next chunk's overlap. */
  private calculateOverlap(sentences: string[], overlapSize: number): [string[], number] {
    const overlapSentences: string[] = [];
    let overlapUnitCount = 0;
    for (let i = sentences.length - 1; i >= 0; i -= 1) {
      const s = sentences[i];
      if (s === undefined) break;
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

  /** F8: locate the page whose [startChar, endChar) contains the offset. */
  private findPageByOffset(offset: number, pageBoundaries: PageBoundary[]): number | undefined {
    if (pageBoundaries.length === 0) return undefined;
    for (const b of pageBoundaries) {
      if (offset >= b.startChar && offset < b.endChar) return b.pageNumber;
    }
    const last = pageBoundaries[pageBoundaries.length - 1];
    if (last !== undefined && offset >= last.startChar) return last.pageNumber;
    return undefined;
  }

  /**
   * Split text into overlapping chunks. F7 guarantees forward progress for
   * every overlap value (the long-sentence split loop cannot spin); F8
   * assigns char offsets and page numbers in a whitespace-normalized space.
   */
  chunkText(text: string, source: string, pages?: ExtractionPage[]): ChunkRow[] {
    const cleanedText = this.cleanText(text);
    const paragraphs = cleanedText.split('\n\n').filter((p) => p.trim());

    const chunks: ChunkRow[] = [];
    let chunkIndex = 0;
    let currentChunkSentences: string[] = [];
    let currentChunkUnitCount = 0;

    for (const paragraph of paragraphs) {
      const sentences = this.splitSentences(paragraph);

      for (let sentence of sentences) {
        sentence = sentence.trim();
        if (!sentence) continue;

        const sentenceUnitCount = this.countUnits(sentence);

        // A single sentence longer than a whole chunk: split it into unit
        // pieces (words for ASCII, characters for CJK-dense).
        if (sentenceUnitCount > this.chunkSize && currentChunkSentences.length === 0) {
          const cjk = this.isCjkDense(sentence);
          let remaining = sentence;
          // F7 defense-in-depth: hard cap on split iterations.
          let guard = 0;
          const guardMax = Math.ceil(sentence.length / Math.max(1, this.chunkSize)) * 4 + 16;
          while (remaining.trim().length > 0 && guard++ < guardMax) {
            const remainingUnits = cjk ? remaining.length : remaining.split(/\s+/).length;
            if (remainingUnits === 0) break;
            const piece = this.sliceUnits(remaining, this.chunkSize);
            chunks.push({ text: piece, chunkIndex });
            chunkIndex += 1;
            if (cjk) {
              remaining = remaining.slice(this.chunkSize);
            } else {
              remaining = remaining.split(/\s+/).slice(this.chunkSize).join(' ');
            }
            if (remaining.trim().length > 0) {
              // F7: overlapCount is >= 1 when overlap > 0 and strictly less
              // than the piece's unit count, so each pass consumes more than
              // it re-adds (slice(-0) once returned the ENTIRE chunk here).
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
          continue;
        }

        if (
          currentChunkSentences.length > 0 &&
          currentChunkUnitCount + sentenceUnitCount > this.chunkSize
        ) {
          chunks.push({ text: currentChunkSentences.join(' '), chunkIndex });
          chunkIndex += 1;
          const [overlapSentences, overlapUnitCount] = this.calculateOverlap(
            currentChunkSentences,
            this.chunkOverlap,
          );
          currentChunkSentences = overlapSentences;
          currentChunkUnitCount = overlapUnitCount;
        }

        currentChunkSentences.push(sentence);
        currentChunkUnitCount += sentenceUnitCount;
      }
    }

    if (currentChunkSentences.length > 0) {
      chunks.push({ text: currentChunkSentences.join(' '), chunkIndex });
    }

    this.assignOffsetsAndPages(chunks, cleanedText, pages);
    return chunks;
  }

  /**
   * F8: attribute each chunk a char offset + page by locating its text in a
   * whitespace-normalized view of the cleaned full text (forward-only cursor
   * so overlapping chunks stay monotonic).
   */
  private assignOffsetsAndPages(
    chunks: ChunkRow[],
    cleanedFullText: string,
    pages?: ExtractionPage[],
  ): void {
    const normalizedFull = cleanedFullText.replace(/\s+/g, ' ').trim();
    const pageBoundaries: PageBoundary[] = [];
    if (pages && pages.length > 0) {
      let offset = 0;
      for (const page of pages) {
        const normalizedPage = this.cleanText(page.text).replace(/\s+/g, ' ').trim();
        if (normalizedPage.length === 0) continue;
        const start = offset;
        pageBoundaries.push({ pageNumber: page.pageNumber, startChar: start, endChar: start + normalizedPage.length });
        offset = start + normalizedPage.length + 1;
      }
    }

    let cursor = 0;
    for (const chunk of chunks) {
      const needle = chunk.text.replace(/\s+/g, ' ').trim();
      if (needle.length === 0) continue;
      let idx = normalizedFull.indexOf(needle, cursor);
      if (idx === -1) {
        idx = normalizedFull.indexOf(needle);
        if (idx === -1) continue;
      }
      chunk.charOffset = idx;
      chunk.page = this.findPageByOffset(idx, pageBoundaries);
      cursor = idx + 1;
    }
  }
}

/** Convenience wrapper: chunk a document without instantiating TextChunker. */
export function chunkDocument(
  text: string,
  source: string,
  pages?: ExtractionPage[],
  chunkSize: number = 256,
  chunkOverlap: number = 100,
): ChunkRow[] {
  return new TextChunker(chunkSize, chunkOverlap).chunkText(text, source, pages);
}
