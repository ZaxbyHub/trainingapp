/**
 * Issue #37 P5: duplicate-upload guard tests.
 *
 * Covers the three logical paths of isDuplicateUpload:
 * 1. fileName + fileSize match → duplicate
 * 2. fileName + fileSize match with chunkCount === 0 → NOT duplicate (re-index bypass)
 * 3. No match → NOT duplicate
 * Plus edge cases: undefined chunkCount, accepted-list hits, empty lists.
 */

import { describe, it, expect } from 'vitest';
import { isDuplicateUpload, type DuplicateGuardEntry } from './duplicate-guard';

const docA: DuplicateGuardEntry = { fileName: 'report.pdf', fileSize: 1024, chunkCount: 5 };
const docB: DuplicateGuardEntry = { fileName: 'invoice.xlsx', fileSize: 2048, chunkCount: 3 };
const docZero: DuplicateGuardEntry = { fileName: 'report.pdf', fileSize: 1024, chunkCount: 0 };
const docNoChunk: DuplicateGuardEntry = { fileName: 'notes.txt', fileSize: 512 };

describe('isDuplicateUpload', () => {
  describe('match by fileName + fileSize', () => {
    it('returns true when fileName and fileSize match', () => {
      expect(isDuplicateUpload('report.pdf', 1024, [docA])).toBe(true);
    });

    it('returns false when fileName differs', () => {
      expect(isDuplicateUpload('other.pdf', 1024, [docA])).toBe(false);
    });

    it('returns false when fileSize differs', () => {
      expect(isDuplicateUpload('report.pdf', 9999, [docA])).toBe(false);
    });

    it('returns false when both differ', () => {
      expect(isDuplicateUpload('other.pdf', 9999, [docA])).toBe(false);
    });
  });

  describe('chunkCount === 0 bypass (re-index)', () => {
    it('returns false when existing entry has chunkCount === 0', () => {
      // Same fileName + fileSize as docA but chunkCount=0 — re-index bypass
      expect(isDuplicateUpload('report.pdf', 1024, [docZero])).toBe(false);
    });

    it('returns true when other entries still have positive chunkCount', () => {
      // docZero is in the list but a positive-chunk entry also matches
      expect(isDuplicateUpload('report.pdf', 1024, [docZero, docA])).toBe(true);
    });
  });

  describe('undefined chunkCount (legacy records)', () => {
    it('returns true when matching entry has no chunkCount field', () => {
      expect(isDuplicateUpload('notes.txt', 512, [docNoChunk])).toBe(true);
    });
  });

  describe('accepted list', () => {
    it('returns true when match is in the accepted list', () => {
      expect(isDuplicateUpload('report.pdf', 1024, [], [docA])).toBe(true);
    });

    it('returns false when neither list has a match', () => {
      expect(isDuplicateUpload('report.pdf', 1024, [docB], [])).toBe(false);
    });

    it('bypasses accepted entry with chunkCount === 0', () => {
      expect(isDuplicateUpload('report.pdf', 1024, [], [docZero])).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for empty existing and accepted lists', () => {
      expect(isDuplicateUpload('report.pdf', 1024, [])).toBe(false);
      expect(isDuplicateUpload('report.pdf', 1024, [], [])).toBe(false);
    });

    it('returns false when existing list has items but no match', () => {
      expect(isDuplicateUpload('new.doc', 4096, [docA, docB])).toBe(false);
    });
  });
});
