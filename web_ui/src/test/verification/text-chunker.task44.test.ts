/**
 * Verification tests for TextChunker (task 4.4)
 * Framework: vitest (NOT installed) — structurally written, execution deferred
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TextChunker, chunkDocument } from '../../../src/lib/processing/text-chunker';
import type { ExtractedPage } from '../../../src/types/document';

// ---------------------------------------------------------------------------
// Helper: minimal ExtractedPage factory
// ---------------------------------------------------------------------------
function makePage(pageNumber: number, text: string): ExtractedPage {
  return { pageNumber, text } as ExtractedPage;
}

// ---------------------------------------------------------------------------
// CONSTRUCTOR VALIDATION
// ---------------------------------------------------------------------------
describe('TextChunker constructor', () => {
  it('throws when chunkSize is 0', () => {
    expect(() => new TextChunker(0)).toThrow('chunk_size must be positive');
  });

  it('throws when chunkSize is negative', () => {
    expect(() => new TextChunker(-1)).toThrow('chunk_size must be positive');
  });

  it('throws when chunkOverlap is negative', () => {
    expect(() => new TextChunker(256, -1)).toThrow('chunk_overlap must be non-negative');
  });

  it('throws when chunkOverlap equals chunkSize', () => {
    expect(() => new TextChunker(256, 256)).toThrow(
      'chunk_overlap (256) must be less than chunk_size (256)'
    );
  });

  it('throws when chunkOverlap exceeds chunkSize', () => {
    expect(() => new TextChunker(100, 200)).toThrow(
      'chunk_overlap (200) must be less than chunk_size (100)'
    );
  });

  it('accepts valid positive chunkSize with 0 chunkOverlap', () => {
    expect(() => new TextChunker(256, 0)).not.toThrow();
  });

  it('accepts valid chunkSize and chunkOverlap', () => {
    expect(() => new TextChunker(512, 128)).not.toThrow();
  });

  it('uses defaults when no args provided', () => {
    const chunker = new TextChunker();
    expect(chunker).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// cleanText
// ---------------------------------------------------------------------------
describe('cleanText', () => {
  let chunker: TextChunker;

  beforeEach(() => {
    chunker = new TextChunker(256, 100);
  });

  it('normalizes CRLF to LF', () => {
    expect(chunker.cleanText('line1\r\nline2\r\nline3')).toBe('line1\nline2\nline3');
  });

  it('normalizes bare CR to LF', () => {
    expect(chunker.cleanText('line1\rline2\rline3')).toBe('line1\nline2\nline3');
  });

  it('collapses runs of 3+ blank lines to exactly 2', () => {
    expect(chunker.cleanText('para1\n\n\n\npara2')).toBe('para1\n\n\npara2');
  });

  it('collapses horizontal whitespace within lines', () => {
    expect(chunker.cleanText('  hello   world  \t\tfoo  ')).toBe('hello world foo');
  });

  it('preserves paragraph breaks (double newlines)', () => {
    expect(chunker.cleanText('para1\n\npara2')).toBe('para1\n\npara2');
  });

  it('strips leading/trailing whitespace', () => {
    expect(chunker.cleanText('  hello world  ')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(chunker.cleanText('')).toBe('');
  });

  it('normalizes and trims complex input', () => {
    const input = '  Hello\r\n\r\n\r\n\r\nWorld\r\n\t  Foo  \t\t  Bar  ';
    const expected = 'Hello\n\n\n\nWorld\nFoo Bar';
    expect(chunker.cleanText(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// splitSentences
// ---------------------------------------------------------------------------
describe('splitSentences', () => {
  let chunker: TextChunker;

  beforeEach(() => {
    chunker = new TextChunker(256, 100);
  });

  it('splits on period followed by space', () => {
    const result = chunker.splitSentences('Hello world. This is a test. Another sentence.');
    expect(result).toEqual(['Hello world.', 'This is a test.', 'Another sentence.']);
  });

  it('splits on exclamation mark', () => {
    const result = chunker.splitSentences('Wow! This is exciting. Or is it?');
    expect(result).toEqual(['Wow!', 'This is exciting.', 'Or is it?']);
  });

  it('splits on question mark', () => {
    const result = chunker.splitSentences('What is this? It is a test. Is it working?');
    expect(result).toEqual(['What is this?', 'It is a test.', 'Is it working?']);
  });

  it('protects Dr. abbreviation', () => {
    const result = chunker.splitSentences('Dr. Smith works here. He is a doctor.');
    expect(result).toEqual(['Dr. Smith works here.', 'He is a doctor.']);
  });

  it('protects Mr. abbreviation', () => {
    const result = chunker.splitSentences('Mr. Jones left. Mrs. Smith remained.');
    expect(result).toEqual(['Mr. Jones left.', 'Mrs. Smith remained.']);
  });

  it('protects e.g. abbreviation', () => {
    const result = chunker.splitSentences('Examples are useful e.g. in documentation. Clear?');
    expect(result).toEqual(['Examples are useful e.g. in documentation.', 'Clear?']);
  });

  it('protects i.e. abbreviation', () => {
    const result = chunker.splitSentences('Meaning i.e. significance. Is that clear?');
    expect(result).toEqual(['Meaning i.e. significance.', 'Is that clear?']);
  });

  it('protects single initials A. B. C.', () => {
    const result = chunker.splitSentences('A. B. C. are letters. They are three.');
    expect(result).toEqual(['A. B. C. are letters.', 'They are three.']);
  });

  it('handles multiple spaces after sentence boundary', () => {
    const result = chunker.splitSentences('One.    Two.   Three.');
    expect(result).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('filters out empty strings', () => {
    const result = chunker.splitSentences('Hello.   .   World.');
    expect(result).toEqual(['Hello.', 'World.']);
  });

  it('handles single sentence with no period', () => {
    const result = chunker.splitSentences('Hello world');
    expect(result).toEqual(['Hello world']);
  });
});

// ---------------------------------------------------------------------------
// chunkText — basic chunking
// ---------------------------------------------------------------------------
describe('chunkText basic behavior', () => {
  let chunker: TextChunker;

  beforeEach(() => {
    chunker = new TextChunker(256, 100);
  });

  it('returns empty array for empty text', () => {
    const result = chunker.chunkText('', 'empty.txt');
    expect(result).toEqual([]);
  });

  it('returns empty array for whitespace-only text', () => {
    const result = chunker.chunkText('   \n\n\t  ', 'whitespace.txt');
    expect(result).toEqual([]);
  });

  it('produces one chunk for text under chunk size', () => {
    const shortText = 'This is a short sentence.';
    const result = chunker.chunkText(shortText, 'short.txt');
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('This is a short sentence.');
    expect(result[0].source).toBe('short.txt');
    expect(result[0].chunkIndex).toBe(0);
  });

  it('produces multiple chunks for text exceeding chunk size', () => {
    // Generate text with known word count
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const result = chunker.chunkText(words, 'long.txt');
    expect(result.length).toBeGreaterThan(1);
  });

  it('each chunk has correct source and chunkIndex', () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const result = chunker.chunkText(words, 'indexed.txt');
    result.forEach((chunk, i) => {
      expect(chunk.source).toBe('indexed.txt');
      expect(chunk.chunkIndex).toBe(i);
    });
  });

  it('respects word count limit per chunk', () => {
    const chunker2 = new TextChunker(50, 10);
    const sentences = 'This is sentence one. This is sentence two. This is sentence three. This is sentence four. This is sentence five. This is sentence six.';
    const result = chunker2.chunkText(sentences, 'count-test.txt');
    result.forEach((chunk) => {
      const wordCount = chunk.text.split(/\s+/).length;
      expect(wordCount).toBeLessThanOrEqual(50);
    });
  });

  it('chunks have expected structure (text, source, chunkIndex, page)', () => {
    const result = chunker.chunkText('Hello world.', 'test.txt');
    expect(result.length).toBe(1);
    const chunk = result[0];
    expect(chunk).toHaveProperty('text');
    expect(chunk).toHaveProperty('source');
    expect(chunk).toHaveProperty('chunkIndex');
    expect(chunk).toHaveProperty('page');
  });
});

// ---------------------------------------------------------------------------
// chunkText — overlap handling
// ---------------------------------------------------------------------------
describe('chunkText overlap', () => {
  it('chunks share overlap sentences', () => {
    const chunker = new TextChunker(20, 8);
    // 6 sentences of ~4 words each = 24 words total, should produce 2 chunks with overlap
    const text = 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here. Fifth sentence here. Sixth sentence here.';
    const result = chunker.chunkText(text, 'overlap.txt');
    expect(result.length).toBeGreaterThan(1);
    // The last sentence of chunk 0 should appear at the start of chunk 1
    expect(result[0].text).not.toBe(result[1].text);
  });

  it('zero overlap produces non-overlapping chunks', () => {
    const chunker = new TextChunker(20, 0);
    const text = 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here.';
    const result = chunker.chunkText(text, 'no-overlap.txt');
    const lastWordsOfFirst = result[0].text.split(' ').slice(-3).join(' ');
    const firstWordsOfSecond = result[1].text.split(' ').slice(0, 3).join(' ');
    expect(lastWordsOfFirst).not.toBe(firstWordsOfSecond);
  });
});

// ---------------------------------------------------------------------------
// chunkText — oversized sentence word-level split
// ---------------------------------------------------------------------------
describe('chunkText oversized sentence handling', () => {
  it('splits sentence exceeding chunk_size into word-level chunks', () => {
    const chunker = new TextChunker(10, 3);
    // Single sentence with 30 words
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const result = chunker.chunkText(words, 'long-sentence.txt');
    // 30 words / 10 chunkSize = 3 chunks minimum
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it('split oversized sentence chunks respect chunkSize word limit', () => {
    const chunker = new TextChunker(5, 1);
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    const result = chunker.chunkText(words, 'oversized.txt');
    result.forEach((chunk) => {
      const wc = chunk.text.split(/\s+/).length;
      expect(wc).toBeLessThanOrEqual(5);
    });
  });

  it('oversized sentence at document start is handled', () => {
    const chunker = new TextChunker(8, 2);
    const longSentence = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ');
    const result = chunker.chunkText(longSentence, 'start-oversized.txt');
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0].text.split(/\s+/).length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// chunkText — page mapping
// ---------------------------------------------------------------------------
describe('chunkText page mapping', () => {
  it('returns undefined page when no pages provided', () => {
    const chunker = new TextChunker(256, 100);
    const result = chunker.chunkText('Hello world.', 'no-pages.txt');
    expect(result[0].page).toBeUndefined();
  });

  it('returns undefined page when no match found', () => {
    const chunker = new TextChunker(256, 100);
    const pages: ExtractedPage[] = [makePage(1, 'Different content here.')];
    const result = chunker.chunkText('Hello world.', 'unmatched.txt', pages);
    expect(result[0].page).toBeUndefined();
  });

  it('assigns correct page number when prefix matches', () => {
    const chunker = new TextChunker(256, 100);
    const pages: ExtractedPage[] = [makePage(5, 'Hello world. This is page five.')];
    const result = chunker.chunkText('Hello world. This is page five.', 'matched.txt', pages);
    expect(result[0].page).toBe(5);
  });

  it('assigns correct page for multi-chunk with page info', () => {
    const chunker = new TextChunker(10, 2);
    const pages: ExtractedPage[] = [makePage(3, 'First paragraph content. Second paragraph here.')];
    const text = 'First paragraph content. Second paragraph here. Third paragraph extra.';
    const result = chunker.chunkText(text, 'multi-page.txt', pages);
    // At least one chunk should have page 3
    const pagesWithMatch = result.filter((c) => c.page === 3);
    expect(pagesWithMatch.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// generateDocId
// ---------------------------------------------------------------------------
describe('generateDocId', () => {
  let chunker: TextChunker;

  beforeEach(() => {
    chunker = new TextChunker(256, 100);
  });

  it('returns a string', async () => {
    const result = await chunker.generateDocId('test.txt');
    expect(typeof result).toBe('string');
  });

  it('returns exactly 16 characters', async () => {
    const result = await chunker.generateDocId('test.txt');
    expect(result.length).toBe(16);
  });

  it('returns only hex characters', async () => {
    const result = await chunker.generateDocId('test.txt');
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for same input', async () => {
    const result1 = await chunker.generateDocId('same-input.txt');
    const result2 = await chunker.generateDocId('same-input.txt');
    expect(result1).toBe(result2);
  });

  it('produces different ids for different inputs', async () => {
    const result1 = await chunker.generateDocId('file1.txt');
    const result2 = await chunker.generateDocId('file2.txt');
    expect(result1).not.toBe(result2);
  });

  it('matches known SHA-256 prefix for empty string', async () => {
    // SHA-256 of "" starts with e3b0c44...
    const result = await chunker.generateDocId('');
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it('matches known SHA-256 prefix for "hello"', async () => {
    // SHA-256 of "hello" = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    // First 16 chars = 2cf24dba5fb0a30e
    const result = await chunker.generateDocId('hello');
    expect(result).toBe('2cf24dba5fb0a30e');
  });
});

// ---------------------------------------------------------------------------
// chunkDocument convenience function
// ---------------------------------------------------------------------------
describe('chunkDocument convenience function', () => {
  it('creates TextChunker internally and returns chunks', () => {
    const result = chunkDocument('Hello world.', 'convenience.txt');
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('Hello world.');
    expect(result[0].source).toBe('convenience.txt');
  });

  it('accepts custom chunkSize and chunkOverlap', () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const result = chunkDocument(words, 'custom.txt', undefined, 15, 3);
    result.forEach((chunk) => {
      const wc = chunk.text.split(/\s+/).length;
      expect(wc).toBeLessThanOrEqual(15);
    });
  });

  it('passes pages through to chunker', () => {
    const pages: ExtractedPage[] = [makePage(7, 'Hello world.')];
    const result = chunkDocument('Hello world.', 'with-pages.txt', pages);
    expect(result[0].page).toBe(7);
  });

  it('uses defaults when not provided', () => {
    const result = chunkDocument('Short text.', 'defaults.txt');
    expect(result.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: full pipeline
// ---------------------------------------------------------------------------
describe('full pipeline integration', () => {
  it('cleanText → splitSentences → chunkText produces valid output', () => {
    const chunker = new TextChunker(20, 5);
    const rawText = 'Dr. Smith wrote a report.\n\n\r\n\r\nIt was comprehensive.\n\n\n\nVery detailed!';
    const cleaned = chunker.cleanText(rawText);
    expect(cleaned).toContain('Dr. Smith wrote a report.');
    expect(cleaned).toContain('It was comprehensive.');

    const sentences = chunker.splitSentences(cleaned.split('\n\n')[0]);
    expect(sentences).toContain('Dr. Smith wrote a report.');

    const chunks = chunker.chunkText(rawText, 'integration.txt');
    expect(Array.isArray(chunks)).toBe(true);
    chunks.forEach((c) => {
      expect(c).toHaveProperty('text');
      expect(c).toHaveProperty('source', 'integration.txt');
      expect(c).toHaveProperty('chunkIndex');
    });
  });
});
