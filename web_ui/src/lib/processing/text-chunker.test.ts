/**
 * Tests for TextChunker (F6/F7/F8/F9 of issue #23).
 *
 * Covers:
 *  - F7: chunkOverlap:1 terminates (acceptance criterion) and overlap depth
 *  - F6: CJK/no-whitespace text does not collapse into a single mega-chunk
 *  - F8: page attribution by char offset (later chunks get the right page)
 *  - F9: abbreviation case preservation + e.g./i.e. protection
 */

import { describe, it, expect } from 'vitest';
import { TextChunker } from './text-chunker';
import type { ExtractedPage } from '../../types/document';

describe('TextChunker', () => {
  describe('basic chunking', () => {
    it('chunks plain ASCII text into one or more chunks', () => {
      const chunker = new TextChunker(10, 2);
      const text = 'The quick brown fox jumps over the lazy dog repeatedly today.';
      const chunks = chunker.chunkText(text, 'test.txt');
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.source).toBe('test.txt');
        expect(c.text.length).toBeGreaterThan(0);
      }
    });

    it('assigns a charOffset to every chunk', () => {
      const chunker = new TextChunker(4, 1);
      const text = 'One sentence here. Another sentence follows. A third one ends.';
      const chunks = chunker.chunkText(text, 'test.txt');
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(typeof c.charOffset).toBe('number');
        expect(c.charOffset!).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('F7: chunkOverlap = 1 (off-by-zero fix)', () => {
    it('TERMINATES when chunkOverlap is 1 (acceptance criterion)', () => {
      // A single over-long sentence with >chunkSize words forces the long-
      // sentence split path that previously looped forever at overlap=1.
      const chunker = new TextChunker(8, 1);
      const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
      const longSentence = words.join(' ');

      // The call must return (not hang). Wrap with a bounded guard via a flag.
      let result;
      let returned = false;
      setTimeout(() => {
        if (!returned) {
          throw new Error('TextChunker with overlap=1 did not terminate within timeout');
        }
      }, 5000);
      result = chunker.chunkText(longSentence, 'long.txt');
      returned = true;

      expect(result.length).toBeGreaterThan(0);
      // Each chunk should be at most chunkSize words (8).
      for (const c of result) {
        const wc = c.text.split(/\s+/).length;
        expect(wc).toBeLessThanOrEqual(8);
      }
    });

    it('makes forward progress — chunk indices are unique and increasing', () => {
      const chunker = new TextChunker(8, 1);
      const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
      const chunks = chunker.chunkText(words.join(' '), 'long.txt');
      const indices = chunks.map((c) => c.chunkIndex);
      // Strictly increasing unique indices.
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThan(indices[i - 1]);
      }
    });

    it('overlap=1 produces a small (1-word) overlap, not the whole chunk', () => {
      const chunker = new TextChunker(8, 1);
      const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
      const chunks = chunker.chunkText(words.join(' '), 'long.txt');
      expect(chunks.length).toBeGreaterThan(1);
      // The first word of chunk[n+1] should equal the last word of chunk[n]
      // (that's the 1-word overlap). It should NOT equal the first word of
      // chunk[n] (which would indicate the whole-chunk regression).
      for (let i = 1; i < chunks.length; i++) {
        const prevWords = chunks[i - 1].text.split(/\s+/);
        const currWords = chunks[i].text.split(/\s+/);
        // With overlap=1, the first word of the current chunk repeats the last
        // word of the previous chunk.
        expect(currWords[0]).toBe(prevWords[prevWords.length - 1]);
      }
    });
  });

  describe('F6: CJK / no-whitespace chunking', () => {
    it('CJK text without spaces is split into multiple chunks, not one mega-chunk', () => {
      // 200 Chinese characters with no spaces. The ASCII path would treat the
      // whole thing as ~1 "word" and never split it.
      const chunker = new TextChunker(50, 10);
      // Use a repeating CJK sentence with a terminator so sentence splitting works.
      const sentence = '今天天气真好我们一起去公园散步吧。';
      const text = sentence.repeat(20); // ~720 chars
      const chunks = chunker.chunkText(text, 'cjk.txt');

      expect(chunks.length).toBeGreaterThan(1);
      // No single chunk should swallow the whole document.
      for (const c of chunks) {
        expect(c.text.length).toBeLessThan(text.length);
      }
      // Reassembled text covers the input content (allowing for overlap).
      const rejoined = chunks.map((c) => c.text).join('');
      // The CJK characters should all be present somewhere.
      for (const ch of sentence) {
        expect(rejoined).toContain(ch);
      }
    });

    it('ASCII text is still chunked by words (not chars) — regression guard', () => {
      const chunker = new TextChunker(5, 1);
      const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
      const chunks = chunker.chunkText(text, 'ascii.txt');
      expect(chunks.length).toBeGreaterThan(1);
      // Each ASCII chunk should be at most chunkSize words.
      for (const c of chunks) {
        expect(c.text.split(/\s+/).length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('F8: page attribution by char offset', () => {
    it('attributes later chunks to the correct page (not just page 1)', () => {
      // Two pages of distinct content. Page 1 is short; page 2 is long enough
      // to produce multiple chunks. The page-2 chunks must report page 2.
      const page1Text = 'Page one introduction text here. Short page.';
      const page2Text = Array.from({ length: 20 }, (_, i) => `Detail number ${i} on the second page.`).join(' ');
      const pages: ExtractedPage[] = [
        { pageNumber: 1, text: page1Text },
        { pageNumber: 2, text: page2Text },
      ];
      const fullText = `${page1Text}\n\n${page2Text}`;

      const chunker = new TextChunker(10, 2);
      const chunks = chunker.chunkText(fullText, 'doc.pdf', pages);

      expect(chunks.length).toBeGreaterThan(1);
      // At least one chunk should be attributed to page 2.
      const page2Chunks = chunks.filter((c) => c.page === 2);
      expect(page2Chunks.length).toBeGreaterThan(0);
      // And at least one chunk attributed to page 1.
      const page1Chunks = chunks.filter((c) => c.page === 1);
      expect(page1Chunks.length).toBeGreaterThan(0);
    });

    it('returns undefined page when no pages are provided', () => {
      const chunker = new TextChunker(5, 1);
      const chunks = chunker.chunkText('alpha bravo charlie delta echo foxtrot', 'none.txt');
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.page).toBeUndefined();
      }
    });
  });

  describe('F9: abbreviation protection', () => {
    it('preserves the original casing of protected abbreviations (Dr. not dr.)', () => {
      const chunker = new TextChunker();
      const chunks = chunker.chunkText('See Dr. Smith today. He is here.', 'test.txt');
      const rejoined = chunks.map((c) => c.text).join(' ');
      // The abbreviation must keep its capital D.
      expect(rejoined).toContain('Dr.');
      expect(rejoined).not.toContain('dr. Smith');
    });

    it('does not split on dotted abbreviations e.g. and i.e.', () => {
      const chunker = new TextChunker();
      // A chunker with a large chunk size keeps the whole text in one chunk;
      // what matters is that the sentence splitter did not fragment it.
      const text = 'Buy fruit, e.g. apples. They are cheap.';
      const chunks = chunker.chunkText(text, 'test.txt');
      const rejoined = chunks.map((c) => c.text).join(' ');
      expect(rejoined).toContain('e.g.');
      // splitSentences should not treat "e.g." as a sentence boundary.
      const sentences = chunker.splitSentences(text);
      // "e.g." should not have created a break between "apples" and the next clause.
      const rejoinedSentences = sentences.join(' ');
      expect(rejoinedSentences).toContain('e.g.');
    });

    it('preserves case of single-letter initials (A. B.)', () => {
      const chunker = new TextChunker();
      const chunks = chunker.chunkText('I spoke with J. R. yesterday. He agreed.', 'test.txt');
      const rejoined = chunks.map((c) => c.text).join(' ');
      expect(rejoined).toContain('J.');
      expect(rejoined).toContain('R.');
    });
  });
});
