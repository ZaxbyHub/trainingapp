// build/chunk.ts — slide-aware chunking + content-derived identity (issue #79).
//
// The chunker is a faithful port of desktop/main/backend/ingest/text-chunker.ts
// (256-word/100-overlap defaults, F9 abbreviation protection, F6 space-ratio
// CJK fallback with character-based sizing, F7 guaranteed overlap progress) so
// pack chunks are textually identical to runtime-ingested chunks for the same
// input. Offsets/page attribution is deliberately not ported: pack chunks are
// attributed to their slide document, not to PDF pages. Parity with the desktop
// implementation is pinned by storyline/__tests__/build-chunker.test.ts
// goldens derived from the desktop source (derivation command in the test).
//
// Identity is content-derived ONLY (the stale-chunk defect class lives in
// path-derived ids): normalizedText/sha256Hex/docIdFor/chunkIdFor byte-match
// desktop/main/backend/ingest/pipeline.ts so an installed pack's rows are
// indistinguishable from runtime-ingested rows.
import { createHash } from 'node:crypto';

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

/** Byte-matches run_interop.py's normalized(): CRLF->LF, trailing space strip. */
export function normalizedText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 of the raw document bytes (desktop pipeline.ts docId formula). */
export function docIdFor(bytes: Buffer): string {
  return sha256Hex(bytes);
}

/** sha256 of `${docId}:${chunkIndex}:${normalized}` (pipeline.ts chunkId). */
export function chunkIdFor(docId: string, chunkIndex: number, normalized: string): string {
  return sha256Hex(`${docId}:${chunkIndex}:${normalized}`);
}

/** sha256 of the normalized chunk text (pipeline.ts content_hash). */
export function contentHashFor(normalized: string): string {
  return sha256Hex(normalized);
}

export interface ChunkRow {
  text: string;
  chunkIndex: number;
}

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
        (_m, g1: string) => `${g1}\u0000`,
      );
    }
    for (const [a, b] of DOTTED_ABBREVIATIONS) {
      protectedText = protectedText.replace(
        new RegExp(`\\b(${a})\\.(${b})\\.`, 'gi'),
        (_m, g1: string, g2: string) => `${g1}\u0000${g2}\u0000`,
      );
    }
    protectedText = protectedText.replace(/\b([A-Z])\./g, '$1\u0000');
    const sentences = protectedText.split(/(?<=[.!?])\s+|(?<=[。！？])/);
    return sentences
      .map((s) => s.replace(/\u0000/g, '.').trim())
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

  /**
   * Split text into overlapping chunks. F7 guarantees forward progress for
   * every overlap value (the long-sentence split loop cannot spin).
   */
  chunkText(text: string): ChunkRow[] {
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
              // it re-adds.
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

    return chunks;
  }
}

/** Chunk one document's text; chunks never cross documents (slide-aware). */
export function chunkSlideText(text: string, size = 256, overlap = 100): ChunkRow[] {
  return new TextChunker(size, overlap).chunkText(text);
}
