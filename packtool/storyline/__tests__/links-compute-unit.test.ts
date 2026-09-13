// links-compute-unit.test.ts — compute-links kernel edge cases (D4/#80).
// Complements the frozen ac4/ac5 checks with boundary + adversarial cases.
// The GOLDEN PARITY CASE at the bottom is duplicated (same vectors, same
// expected rows) in desktop/src/__tests__/d4-links-store.test.ts — the
// desktop cannot import this package, so identical vectors + identical
// expected output are the kernel-parity pin. Keep both in sync.
import { describe, expect, it } from 'vitest';
import {
  computeDocSlideLinks,
  cosineSimilarity,
  slideIdFromDocPath,
  DEFAULT_LINKS_COSINE_THRESHOLD,
  LINKS_TOP_K,
} from '../../links/compute-links.js';

describe('links compute-links kernel edges (D4, issue #80)', () => {
  it('excludes a pair at exactly the threshold and includes just above', () => {
    // chunk [3,4] vs slide [0,5]: cosine = 20/25 = 0.8 (an exactly
    // representable division result, so the boundary is deterministic).
    const chunk = { chunkId: 'c1', packId: null, vector: [3, 4] };
    const slides = [{ slideId: 'at', vector: [0, 5] }];
    expect(computeDocSlideLinks([chunk], slides, { threshold: 0.8 })).toHaveLength(0);
    const included = computeDocSlideLinks([chunk], slides, { threshold: 0.79 });
    expect(included).toHaveLength(1);
    expect(included[0]?.score).toBeCloseTo(0.8, 12);
  });

  it('zero-norm vectors never link (cosine undefined)', () => {
    const rows = computeDocSlideLinks(
      [
        { chunkId: 'zero-chunk', packId: null, vector: [0, 0, 0] },
        { chunkId: 'ok-chunk', packId: null, vector: [1, 0, 0] },
      ],
      [{ slideId: 'zero-slide', vector: [0, 0, 0] }],
    );
    expect(rows).toHaveLength(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBeNull();
    expect(cosineSimilarity([1, 0], [0, 0])).toBeNull();
  });

  it('length-mismatched vectors never link', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBeNull();
    const rows = computeDocSlideLinks(
      [{ chunkId: 'c1', packId: null, vector: [1, 0, 0] }],
      [{ slideId: 'short', vector: [1, 0] }],
    );
    expect(rows).toHaveLength(0);
  });

  it('throws on invalid options (topK, threshold)', () => {
    const chunk = { chunkId: 'c1', packId: null, vector: [1, 0] };
    const slide = { slideId: 's1', vector: [1, 0] };
    expect(() => computeDocSlideLinks([chunk], [slide], { topK: 0 })).toThrowError(/topK/);
    expect(() => computeDocSlideLinks([chunk], [slide], { topK: 1.5 })).toThrowError(/topK/);
    expect(() => computeDocSlideLinks([chunk], [slide], { threshold: Number.NaN })).toThrowError(/threshold/);
    expect(() => computeDocSlideLinks([chunk], [slide], { threshold: 1.2 })).toThrowError(/threshold/);
    expect(() => computeDocSlideLinks([chunk], [slide], { threshold: -1.2 })).toThrowError(/threshold/);
  });

  it('breaks score ties deterministically by slide_id', () => {
    const rows = computeDocSlideLinks(
      [{ chunkId: 'c1', packId: null, vector: [1, 0] }],
      [
        { slideId: 'zz', vector: [1, 0] },
        { slideId: 'aa', vector: [1, 0] },
        { slideId: 'mm', vector: [1, 0] },
      ],
      { topK: 2 },
    );
    expect(rows.map((r) => r.slide_id)).toEqual(['aa', 'mm']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('handles empty inputs and echoes packId, honoring injected time', () => {
    expect(computeDocSlideLinks([], [{ slideId: 's', vector: [1] }])).toHaveLength(0);
    expect(computeDocSlideLinks([{ chunkId: 'c', packId: 'p', vector: [1] }], [])).toHaveLength(0);
    const rows = computeDocSlideLinks(
      [{ chunkId: 'c1', packId: 'pack-7', vector: [1, 0] }],
      [{ slideId: 's1', vector: [0.6, 0.8] }],
      { now: () => '2026-09-13T00:00:00.000Z' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pack_id).toBe('pack-7');
    expect(rows[0]?.computed_at).toBe('2026-09-13T00:00:00.000Z');
    expect(DEFAULT_LINKS_COSINE_THRESHOLD).toBe(0.5);
    expect(LINKS_TOP_K).toBe(3);
  });

  it('slideIdFromDocPath parses the writer convention (3-digit pad and beyond)', () => {
    expect(slideIdFromDocPath('docs/slide-001-S1.json')).toBe('S1');
    expect(slideIdFromDocPath('docs/slide-042-5b8obQzpBWu.json')).toBe('5b8obQzpBWu');
    expect(slideIdFromDocPath('docs/slide-1000-big.json')).toBe('big');
    expect(slideIdFromDocPath('docs/outline.json')).toBeNull();
    expect(slideIdFromDocPath('docs/slide-x-S1.json')).toBeNull();
    expect(slideIdFromDocPath('slide-001-S1.json')).toBeNull();
  });

  it('GOLDEN PARITY: exact rows for a hand-computed case (mirror of d4-links-store.test.ts)', () => {
    // chunk v = [3,4,0] (|v| = 5); slides: A=[6,8,0] cos 1.0, B=[4,3,0] cos
    // 0.96, C=[0,5,0] cos 0.8, D=[5,0,0] cos 0.6, E=[0,0,7] cos 0.
    const rows = computeDocSlideLinks(
      [{ chunkId: 'c1', packId: 'golden', vector: [3, 4, 0] }],
      [
        { slideId: 'A', vector: [6, 8, 0] },
        { slideId: 'B', vector: [4, 3, 0] },
        { slideId: 'C', vector: [0, 5, 0] },
        { slideId: 'D', vector: [5, 0, 0] },
        { slideId: 'E', vector: [0, 0, 7] },
      ],
      { now: () => '2026-09-13T00:00:00.000Z' },
    );
    expect(rows.map((r) => [r.slide_id, r.rank])).toEqual([
      ['A', 1],
      ['B', 2],
      ['C', 3],
    ]);
    expect(rows[0]?.score).toBeCloseTo(1.0, 12);
    expect(rows[1]?.score).toBeCloseTo(0.96, 12);
    expect(rows[2]?.score).toBeCloseTo(0.8, 12);
    // D (0.6 > 0.5) is above threshold but beyond the top-3 cap; E (0) is
    // below the threshold. Both absent.
    expect(rows.some((r) => r.slide_id === 'D')).toBe(false);
    expect(rows.some((r) => r.slide_id === 'E')).toBe(false);
  });
});
