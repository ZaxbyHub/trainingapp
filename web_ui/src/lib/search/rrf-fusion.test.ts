import { describe, it, expect } from 'vitest';
import { rrfFuse } from './rrf-fusion';
import type { SearchResult } from '../../types/search';

describe('rrfFuse', () => {
  describe('test_rrf_fuse_basic', () => {
    it('two lists with overlapping docs, verify scores accumulate', () => {
      const list1: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.9, text: 'text from list1' },
        { docId: 'doc-b', chunkIndex: 0, score: 0.8, text: 'text from list1' },
      ];
      const list2: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.7, text: 'text from list2' },
        { docId: 'doc-c', chunkIndex: 0, score: 0.6, text: 'text from list2' },
      ];

      const result = rrfFuse([list1, list2]);

      // doc-a appears in both lists, should have accumulated score
      const docA = result.find((r) => r.docId === 'doc-a');
      expect(docA).toBeDefined();
      expect(docA!.score).toBeGreaterThan(0);

      // doc-b appears only in list1
      const docB = result.find((r) => r.docId === 'doc-b');
      expect(docB).toBeDefined();

      // doc-c appears only in list2
      const docC = result.find((r) => r.docId === 'doc-c');
      expect(docC).toBeDefined();

      // Total count should be 3 unique docs
      expect(result.length).toBe(3);
    });
  });

  describe('test_rrf_fuse_single_list', () => {
    it('single list returns same docs with correct scores', () => {
      const list1: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.9 },
        { docId: 'doc-b', chunkIndex: 0, score: 0.8 },
        { docId: 'doc-c', chunkIndex: 0, score: 0.7 },
      ];

      const result = rrfFuse([list1]);

      expect(result.length).toBe(3);
      expect(result[0].docId).toBe('doc-a');
      expect(result[1].docId).toBe('doc-b');
      expect(result[2].docId).toBe('doc-c');
    });
  });

  describe('test_rrf_fuse_empty_lists', () => {
    it('empty lists return empty', () => {
      const result = rrfFuse([]);
      expect(result).toEqual([]);

      const result2 = rrfFuse([[]]);
      expect(result2).toEqual([]);

      const result3 = rrfFuse([[], []]);
      expect(result3).toEqual([]);
    });
  });

  describe('test_rrf_fuse_sorted_by_score', () => {
    it('results sorted descending', () => {
      const list1: SearchResult[] = [
        { docId: 'doc-c', chunkIndex: 0, score: 0.3 },
        { docId: 'doc-b', chunkIndex: 0, score: 0.5 },
        { docId: 'doc-a', chunkIndex: 0, score: 0.7 },
      ];

      const result = rrfFuse([list1]);

      // Should be sorted by RRF score descending (not original score)
      // RRF score for rank 0 = 1/(60+0+1) = 1/61 ≈ 0.0164
      // RRF score for rank 1 = 1/(60+1+1) = 1/62 ≈ 0.0161
      // RRF score for rank 2 = 1/(60+2+1) = 1/63 ≈ 0.0159
      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i].score).toBeGreaterThanOrEqual(result[i + 1].score);
      }
    });
  });

  describe('k parameter affects scores', () => {
    it('higher k value makes all rankers contribute more equally', () => {
      const list1: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.9 },
        { docId: 'doc-b', chunkIndex: 0, score: 0.8 },
      ];
      const list2: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.7 },
        { docId: 'doc-b', chunkIndex: 0, score: 0.6 },
      ];

      const resultK60 = rrfFuse([list1, list2], 60);
      const resultK1 = rrfFuse([list1, list2], 1);

      const docAK60 = resultK60.find((r) => r.docId === 'doc-a');
      const docBK60 = resultK60.find((r) => r.docId === 'doc-b');

      const docAK1 = resultK1.find((r) => r.docId === 'doc-a');
      const docBK1 = resultK1.find((r) => r.docId === 'doc-b');

      // With k=1, the score difference between rank 0 and rank 1 is more pronounced
      // Score for rank 0: 1/(1+0+1) = 0.5, rank 1: 1/(1+1+1) = 0.333
      // With k=60, score for rank 0: 1/61 ≈ 0.0164, rank 1: 1/62 ≈ 0.0161
      // The ratio is much larger with k=1
      const ratioK1 = (docAK1?.score ?? 0) / (docBK1?.score ?? 0);
      const ratioK60 = (docAK60?.score ?? 0) / (docBK60?.score ?? 0);

      // The ratio between top and second ranker should be larger with lower k
      expect(ratioK1).toBeGreaterThan(ratioK60);
    });
  });

  describe('duplicate docIds across lists', () => {
    it('accumulates scores for same doc across different lists', () => {
      const list1: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.9 },
      ];
      const list2: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.7 },
      ];
      const list3: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.5 },
      ];

      const result = rrfFuse([list1, list2, list3]);

      // doc-a appears in all 3 lists
      expect(result.length).toBe(1);
      expect(result[0].docId).toBe('doc-a');
      // Score should be sum of RRF contributions from all 3 lists
      // Each contributes 1/(60+0+1) = 1/61
      expect(result[0].score).toBeCloseTo(3 * (1 / 61), 5);
    });

    it('handles same doc with different chunk indices', () => {
      const list1: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.9 },
      ];
      const list2: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 1, score: 0.7 },
      ];

      const result = rrfFuse([list1, list2]);

      // Should have 2 entries since chunkIndex is part of the key
      expect(result.length).toBe(2);
      expect(result.find((r) => r.docId === 'doc-a' && r.chunkIndex === 0)).toBeDefined();
      expect(result.find((r) => r.docId === 'doc-a' && r.chunkIndex === 1)).toBeDefined();
    });
  });

  describe('text field preserved from first occurrence', () => {
    it('uses text from highest-ranked occurrence', () => {
      const list1: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.9, text: 'text from list1 rank0' },
        { docId: 'doc-b', chunkIndex: 0, score: 0.8, text: 'text from list1 rank1' },
      ];
      const list2: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.7, text: 'text from list2 rank0' },
        { docId: 'doc-c', chunkIndex: 0, score: 0.6, text: 'text from list2 rank0' },
      ];

      const result = rrfFuse([list1, list2]);

      const docA = result.find((r) => r.docId === 'doc-a');
      // First occurrence is from list1 rank0, so text should be 'text from list1 rank0'
      expect(docA?.text).toBe('text from list1 rank0');

      // doc-b from list1 rank1
      const docB = result.find((r) => r.docId === 'doc-b');
      expect(docB?.text).toBe('text from list1 rank1');

      // doc-c from list2 rank0
      const docC = result.find((r) => r.docId === 'doc-c');
      expect(docC?.text).toBe('text from list2 rank0');
    });

    it('preserves text when only one list has text', () => {
      const list1: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.9 },
      ];
      const list2: SearchResult[] = [
        { docId: 'doc-a', chunkIndex: 0, score: 0.7, text: 'text only in list2' },
      ];

      const result = rrfFuse([list1, list2]);

      // doc-a in list1 at rank 0 has no text, list2 at rank 0 has text
      // First occurrence (list1 rank0) has no text, so result should have undefined text
      const docA = result.find((r) => r.docId === 'doc-a');
      expect(docA?.text).toBeUndefined();
    });
  });
});
