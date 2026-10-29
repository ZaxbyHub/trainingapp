/**
 * Semantic text chunking for RAG pipeline.
 * Ports the Python DocumentProcessor chunking algorithm to TypeScript.
 * Runs entirely in the browser - no server-side dependencies.
 */

import type { DocumentChunk, ExtractedPage } from '../../types/document';

// ---------------------------------------------------------------------------
// Embedder-window token guard (#35-B3, batch-153-35-rag-quality)
// ---------------------------------------------------------------------------

/**
 * Tokens reserved inside `maxChunkTokens` for the encoder's [CLS]/[SEP]
 * specials: the embedding format wraps every chunk, so content is budgeted
 * at maxChunkTokens - 2.
 */
const ENCODER_SPECIAL_TOKENS = 2;

/**
 * Splitter safety margin: the word-shape estimator is a calibrated
 * heuristic, not a tokenizer, so piece sizing leaves room for residual
 * cross-class drift (observed <= 3 tokens on mixed-class pieces). The
 * frozen spec's offline WordPiece oracle battery — not this constant — is
 * the actual <=512 guarantee.
 */
const SPLIT_SLACK = 8;

/**
 * Common English words treated as embedding-vocabulary hits: they cost the
 * ceil(len/4) class bound (vocabulary hits cost ~1 real token, well under
 * the bound). Anything else — technical tokens, identifiers, codes,
 * non-English romanizations, text a WordPiece vocab usually misses — costs
 * 1 token per letter at ANY length: a TRUE per-character upper bound
 * (WordPiece emits at most one piece per character, so the estimate can
 * never under-count the class). Measured calibration of the failure this
 * bound prevents: rare-letter long words tokenize at up to 1.0 pieces per
 * character while the previous ceil(len/2) average under-counted them up
 * to 2x, letting chunks exceed the embedder window. The trade is
 * over-splitting uncommon-word prose, which is the safe failure mode. The
 * list covers general function words plus this domain's frequent content
 * words; a miss only makes the estimate MORE conservative.
 */
const COMMON_ENGLISH_WORDS: ReadonlySet<string> = new Set([
  // function words
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it',
  'its', 'this', 'that', 'these', 'those', 'he', 'she', 'they', 'them', 'his',
  'her', 'their', 'we', 'our', 'us', 'you', 'your', 'i', 'not', 'no', 'but',
  'if', 'then', 'than', 'so', 'such', 'into', 'over', 'under', 'before',
  'after', 'next', 'each', 'every', 'all', 'any', 'some', 'one', 'two',
  'three', 'first', 'last', 'new', 'old', 'more', 'most', 'other', 'same',
  'only', 'own', 'about', 'between', 'through', 'during', 'without',
  'within', 'up', 'down', 'out', 'off', 'again', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'what', 'which', 'who', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'must', 'shall', 'do', 'does',
  'did', 'done', 'have', 'has', 'had', 'get', 'gets', 'got', 'make', 'makes',
  'made', 'use', 'used', 'uses', 'also', 'both', 'few', 'many', 'much',
  'very', 'just', 'now', 'per', 'via', 'due',
  // domain content words (document/chat vocabulary of this app)
  'training', 'system', 'processes', 'process', 'record', 'records', 'and',
  'writes', 'write', 'audit', 'audits', 'result', 'results', 'local',
  'storage', 'before', 'batch', 'begins', 'begin', 'review', 'reviews',
  'quarterly', 'compliance', 'protocol', 'report', 'reports', 'document',
  'documents', 'search', 'answer', 'answers', 'question', 'questions',
  'policy', 'policies', 'procedure', 'procedures', 'archive', 'archived',
  'retention', 'governance', 'facility', 'supervisor', 'deadline',
]);

/**
 * Conservative per-word token cost for one whitespace-delimited word.
 * WordPiece splits each character class independently, and every class
 * bound here is a TRUE per-character upper bound: letters cost
 * ceil(len/4) when the word is in COMMON_ENGLISH_WORDS (vocabulary hits,
 * ~1 real token) and 1.0 per letter otherwise; digit, non-ASCII and
 * punctuation runs cost up to 1 token per char (punctuation measured at
 * exactly 1.0). The word cost is the SUM of the per-class bounds (a max()
 * would let one class's over-count absorb another class's real tokens —
 * measured +3 drift on numeric-table pieces). Over-counting is the safe
 * direction: marginal over-splitting, never silent truncation. Calibrated
 * against the shipped embedder's WordPiece vocabulary and validated by
 * the acceptance spec's offline tokenizer oracle battery.
 */
function wordTokenCost(word: string): number {
  let letters = 0;
  let digits = 0;
  let other = 0;
  let punct = 0;
  for (const ch of word) {
    const code = ch.codePointAt(0)!;
    if (code >= 48 && code <= 57) digits++;
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) letters++;
    else if (code < 128) punct++;
    else other++;
  }
  const letterBound = COMMON_ENGLISH_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, ''))
    ? Math.ceil(letters / 4)
    : letters; // true per-character upper bound for non-vocabulary words
  return Math.ceil(letterBound + digits + other + punct);
}

/**
 * Estimate the embedding-model token count of `text` (upper-bound-biased,
 * word-shape-aware; the shipped embedder is a 512-token BERT WordPiece
 * model). Empty text estimates to 0.
 */
export function estimateChunkTokens(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    total += wordTokenCost(word);
  }
  return total;
}

/**
 * Per-character cost used when a single word alone exceeds the budget:
 * uniform 1.0 — the same per-character upper bound wordTokenCost charges
 * every class, so char-sliced pieces never re-estimate above the budget
 * (a 0.5/char letter/digit assumption here under-priced the 1.0/char
 * digit and punctuation classes and let char-sliced pieces ship ~2x over
 * the window).
 */
function charTokenCost(): number {
  return 1;
}

/**
 * Split a single word that alone exceeds the content budget into
 * character-cost-delimited pieces (CJK/no-space text has no word
 * boundaries to walk).
 */
function charSlice(word: string, contentBudget: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < word.length) {
    let cost = 0;
    let end = start;
    while (end < word.length && (cost === 0 || cost + charTokenCost() <= contentBudget)) {
      cost += charTokenCost();
      end++;
    }
    pieces.push(word.slice(start, end));
    start = end;
  }
  return pieces;
}

/**
 * Split `text` into pieces whose estimateChunkTokens cost fits
 * `maxChunkTokens - ENCODER_SPECIAL_TOKENS - SPLIT_SLACK` (encoder specials
 * reserved, calibrated slack for residual estimator drift). Pieces are
 * SUBSTRINGS of the original text cut at word boundaries, so all internal
 * line/paragraph structure is preserved — pack slide markers depend on the
 * first line being exactly the `[training-slide] …` header. Word-walking
 * with an optional carried overlap tail (F7 discipline: at least 1 word
 * when overlap is requested, strictly consumption-progressing, never >= the
 * piece length); a single word over the budget is char-sliced (progress
 * guarantee). Exported for callers that emit chunk-like text without the
 * TextChunker state machine (pack slide documents, #35-B3 scope
 * completion).
 */
export function splitTextToTokenBudget(
  text: string,
  maxChunkTokens: number = 512,
  overlapWords: number = 0
): string[] {
  const contentBudget = Math.floor(maxChunkTokens) - ENCODER_SPECIAL_TOKENS - SPLIT_SLACK;
  if (!text) return [];
  // Word tokens with their [start, end) offsets in the ORIGINAL text, so
  // pieces are raw slices and newlines inside a piece survive.
  interface WordToken {
    start: number;
    end: number;
    cost: number;
  }
  const tokens: WordToken[] = [];
  const wordRe = /\S+/g;
  for (let m = wordRe.exec(text); m !== null; m = wordRe.exec(text)) {
    tokens.push({ start: m.index, end: m.index + m[0].length, cost: wordTokenCost(m[0]) });
  }
  if (tokens.length === 0) return [text];

  const pieces: string[] = [];
  let pieceStartWord = 0;
  let pieceEndWord = 0;
  let freshStartWord = 0; // first word of the piece that is NOT carried overlap tail
  let pieceCost = 0;
  const pushPiece = (incomingCost: number = 0): void => {
    if (pieceEndWord <= pieceStartWord) return;
    pieces.push(text.slice(tokens[pieceStartWord]!.start, tokens[pieceEndWord - 1]!.end).trim());
    // Carry an overlap tail that (a) fits the content budget TOGETHER with
    // the incoming trigger token, and (b) takes at most HALF of the piece's
    // fresh (non-carried) words, so every emitted piece makes geometric
    // progress — a fixed word-count tail starved the fresh budget when
    // per-word costs approached the budget (35x text duplication measured
    // on dense fixtures). overlapWords = 0 carries no tail at all.
    const freshCount = pieceEndWord - freshStartWord;
    const maxTailWords = Math.min(overlapWords, Math.floor(freshCount / 2));
    let tailStart = maxTailWords > 0 ? pieceEndWord - 1 : pieceEndWord;
    let tailCost = tailStart < pieceEndWord ? tokens[tailStart]!.cost : 0;
    while (
      tailStart - 1 >= freshStartWord &&
      pieceEndWord - 1 - (tailStart - 1) < maxTailWords &&
      tailCost + tokens[tailStart - 1]!.cost <= contentBudget - incomingCost
    ) {
      tailStart--;
      tailCost += tokens[tailStart]!.cost;
    }
    while (tailCost + incomingCost > contentBudget && tailStart < pieceEndWord - 1) {
      tailStart++;
      tailCost -= tokens[tailStart - 1]!.cost;
    }
    if (tailCost + incomingCost > contentBudget) {
      tailStart = pieceEndWord;
      tailCost = 0;
    }
    pieceStartWord = tailStart;
    freshStartWord = Math.max(freshStartWord, tailStart);
    pieceCost = tailCost;
  };
  for (let ti = 0; ti < tokens.length; ti++) {
    const token = tokens[ti]!;
    if (token.cost > contentBudget) {
      pushPiece();
      // Batch the char-slice pieces (a single spread of a >125k-element
      // array throws RangeError in V8).
      for (const piece of charSlice(text.slice(token.start, token.end), contentBudget)) {
        pieces.push(piece);
      }
      pieceStartWord = ti + 1;
      pieceEndWord = pieceStartWord;
      freshStartWord = pieceStartWord;
      pieceCost = 0;
      continue;
    }
    if (pieceCost + token.cost > contentBudget && pieceEndWord > pieceStartWord) {
      pushPiece(token.cost);
    }
    pieceEndWord++;
    pieceCost += token.cost;
  }
  pushPiece();
  return pieces;
}

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
  private readonly maxChunkTokens: number;

  /**
   * Create a new TextChunker.
   *
   * @param chunkSize - Target number of words per chunk (default: 256)
   * @param chunkOverlap - Number of words to overlap between chunks (default: 100)
   * @param maxChunkTokens - Embedder window per chunk, in tokens (default: 512).
   *   Two tokens are reserved for the encoder's [CLS]/[SEP] specials and
   *   eight more for split slack, so values below 11 are rejected.
   * @throws Error if chunkSize <= 0, chunkOverlap < 0, or chunkOverlap >= chunkSize
   * @throws Error if maxChunkTokens is not a finite number >= 11
   */
  constructor(chunkSize: number = 256, chunkOverlap: number = 100, maxChunkTokens: number = 512) {
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
    if (
      !Number.isFinite(maxChunkTokens) ||
      maxChunkTokens < ENCODER_SPECIAL_TOKENS + SPLIT_SLACK + 1
    ) {
      throw new Error(
        `max_chunk_tokens must be a finite number >= ${
          ENCODER_SPECIAL_TOKENS + SPLIT_SLACK + 1
        } (encoder specials + split slack are reserved, or the content budget goes non-positive), got ${maxChunkTokens}`
      );
    }
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
    this.maxChunkTokens = maxChunkTokens;
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

    // Embedder-window guard (#35-B3): the state machine bounds chunks in
    // WORD units, but the embedding model truncates silently at a TOKEN
    // window (512 for the shipped BERT embedder). Re-split any chunk whose
    // estimate exceeds the content budget, then re-index. In-budget chunks
    // (all normal prose at production defaults) are untouched.
    const guarded = this.enforceTokenBudget(chunks);

    // F8: assign charOffset + page attribution in a post-processing pass. Build
    // a whitespace-normalized view of the full text and locate each chunk's
    // (similarly normalized) text with a forward-only cursor, so attribution is
    // robust against paragraph-boundary joins. Page boundaries are computed in
    // the SAME normalized space from the cleaned page texts.
    this.assignOffsetsAndPages(guarded, cleanedText, pages);

    return guarded;
  }

  /**
   * Embedder-window guard (#35-B3): re-split emitted chunks that exceed the
   * content token budget (maxChunkTokens minus the two encoder specials) and
   * re-number chunkIndex sequentially over the final array. Pieces carry an
   * F7-discipline overlap tail (floor(chunkOverlap/2) words).
   */
  private enforceTokenBudget(chunks: DocumentChunk[]): DocumentChunk[] {
    const contentBudget = this.maxChunkTokens - ENCODER_SPECIAL_TOKENS;
    let overflow = false;
    for (const chunk of chunks) {
      if (estimateChunkTokens(chunk.text) > contentBudget) {
        overflow = true;
        break;
      }
    }
    if (!overflow) return chunks;

    const overlapTail = Math.floor(this.chunkOverlap / 2);
    const out: DocumentChunk[] = [];
    for (const chunk of chunks) {
      if (estimateChunkTokens(chunk.text) <= contentBudget) {
        out.push(chunk);
        continue;
      }
      for (const piece of splitTextToTokenBudget(chunk.text, this.maxChunkTokens, overlapTail)) {
        out.push({ ...chunk, text: piece });
      }
    }
    return out.map((chunk, i) => ({ ...chunk, chunkIndex: i }));
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
        // unset rather than attributing incorrectly — but surface it so silent
        // page-attribution loss is observable (PRR-006). The line carries the
        // chunk's identity by id + length only, never its text (issue #248
        // AC5: document content never reaches a log surface).
        idx = normalizedFull.indexOf(needle);
        if (idx === -1) {
          console.warn(
            '[TextChunker] Could not locate a chunk in the normalized full text; ' +
              'leaving its charOffset/page unset. Chunk: ' +
              `docId=${chunk.docId ?? 'unknown'} chunkIndex=${chunk.chunkIndex} length=${needle.length}`
          );
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
   * @deprecated MUST NOT be used for store identity: path-derived identity
   * caused the stale-chunk defect; content-hash ids are the contract
   * (desktop/main/backend/ingest/pipeline.ts).
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
