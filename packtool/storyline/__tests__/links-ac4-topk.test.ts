// links-ac4-topk.test.ts — D4 AC4 acceptance check (issue #80).
//
// Top-3 cap: no chunk gets more than 3 links rows even when MORE than 3
// slides exceed the similarity threshold. Five pairwise-distinct slides all
// sit within cosine > 0.9 of the doc chunk; the result must still carry
// exactly 3 rows for that chunk, ranks exactly {1, 2, 3}, scores descending
// with rank, and the 3 kept slides must be the closest ones. The cap must
// also hold when the threshold is explicitly lowered far below all five
// scores.
//
// ---------------------------------------------------------------------------
// COMPUTE-LINKS INTERFACE CONTRACT (frozen)
// ---------------------------------------------------------------------------
// The issue names packtool/links/compute-links.ts as the compute module. Its
// exported surface is frozen as:
//
//   computeDocSlideLinks(
//     chunks: Array<{ chunkId: string; packId: string | null; vector: number[] }>,
//     slides: Array<{ slideId: string; vector: number[] }>,
//     options?: { threshold?: number; topK?: number },
//   ): Array<{
//     chunk_id: string;
//     slide_id: string;
//     pack_id: string | null;
//     score: number;
//     rank: number;
//     computed_at: string;
//   }>
//
// Semantics pinned by issue #80 (D4):
//   - score = cosine similarity between the chunk vector and the slide vector;
//   - a link row exists only when score > (options.threshold ?? 0.5);
//   - at most options.topK (default 3) rows per chunk, ranked 1..n by score
//     descending; rank starts at 1;
//   - computed_at is a non-empty timestamp string (ISO-8601 in practice);
//   - pack_id echoes the input chunk's packId (null stays null);
//   - slide_id is the slide's slideId input (training doc path convention
//     'docs/slide-NNN-<slideId>.json' -> '<slideId>').
//
// RED AT BASE: packtool/links/compute-links.ts does not exist — the file fails
// collection with "Cannot find module '../../links/compute-links.js'". That
// module-not-found failure IS the acceptance evidence for the missing module.
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import { computeDocSlideLinks } from '../../links/compute-links.js';

// --- typed view of the frozen contract -------------------------------------
interface LinkRow {
  chunk_id: string;
  slide_id: string;
  pack_id: string | null;
  score: number;
  rank: number;
  computed_at: string;
}
interface LinkChunkInput {
  chunkId: string;
  packId: string | null;
  vector: number[];
}
interface LinkSlideInput {
  slideId: string;
  vector: number[];
}
type ComputeDocSlideLinks = (
  chunks: LinkChunkInput[],
  slides: LinkSlideInput[],
  options?: { threshold?: number; topK?: number },
) => LinkRow[];
const compute: ComputeDocSlideLinks = computeDocSlideLinks as ComputeDocSlideLinks;

const DIMS = 8;

/** Unit vector at `angleDeg` in the (x, y) plane of an 8-dim space. */
function planeVector(angleDeg: number): number[] {
  const radians = (angleDeg * Math.PI) / 180;
  const vector = new Array<number>(DIMS).fill(0);
  vector[0] = Math.cos(radians);
  vector[1] = Math.sin(radians);
  return vector;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const CHUNK_ID = 'd4-ac4-chunk';
const PACK_ID = 'd4-ac4-doc-pack';

// Five pairwise-distinct slides at 3, 6, 9, 12, 15 degrees from the doc
// chunk's direction: every cosine is > 0.9 (well above the 0.5 default), and
// the cosines are distinct so the ranking is unambiguous.
const SLIDE_ANGLES = [3, 6, 9, 12, 15];
const slides: LinkSlideInput[] = SLIDE_ANGLES.map((angle, i) => ({
  slideId: `sl-${i + 1}`,
  vector: planeVector(angle),
}));
const docVector = planeVector(0);
const chunkInputs: LinkChunkInput[] = [{ chunkId: CHUNK_ID, packId: PACK_ID, vector: docVector }];

function rowsForChunk(rows: LinkRow[]): LinkRow[] {
  return rows.filter((row) => row.chunk_id === CHUNK_ID);
}

describe('links-ac4: top-3 cap on links rows (D4, issue #80)', () => {
  it('caps the chunk at exactly 3 rows with ranks 1..3 and descending scores', () => {
    // Fixture self-check: 5 distinct slides, all cosine > 0.9 with the chunk.
    for (let i = 0; i < slides.length; i += 1) {
      const slide = slides[i];
      if (slide === undefined) throw new Error('fixture slide missing');
      expect(cosine(docVector, slide.vector)).toBeGreaterThan(0.9);
      for (let j = i + 1; j < slides.length; j += 1) {
        const other = slides[j];
        if (other === undefined) throw new Error('fixture slide missing');
        expect(cosine(slide.vector, other.vector)).toBeLessThan(1 - 1e-9);
      }
    }

    const rows = rowsForChunk(compute(chunkInputs, slides));
    // EXACTLY 3 rows even though 5 slides exceed the threshold.
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.chunk_id).toBe(CHUNK_ID);
      expect(row.pack_id).toBe(PACK_ID);
    }
    // Ranks are exactly {1, 2, 3}.
    const ranks = rows.map((row) => row.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3]);
    // Scores descend with rank.
    const byRank = [...rows].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < byRank.length; i += 1) {
      const prev = byRank[i - 1];
      const curr = byRank[i];
      if (prev === undefined || curr === undefined) throw new Error('unreachable');
      expect(prev.score).toBeGreaterThanOrEqual(curr.score);
    }
    // The kept slides are the three CLOSEST (3, 6, 9 degrees).
    const kept = rows.map((row) => row.slide_id).sort();
    expect(kept).toEqual(['sl-1', 'sl-2', 'sl-3']);
    // Rank 1 is the closest slide with its exact cosine.
    const rank1 = byRank[0];
    expect(rank1).toBeDefined();
    expect((rank1 as LinkRow).slide_id).toBe('sl-1');
    expect(Math.abs((rank1 as LinkRow).score - cosine(docVector, slides[0]?.vector ?? []))).toBeLessThan(1e-9);
  });

  it('keeps the cap when the threshold is lowered to include all five slides', () => {
    const rows = rowsForChunk(compute(chunkInputs, slides, { threshold: 0.1 }));
    expect(rows).toHaveLength(3);
    const ranks = rows.map((row) => row.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3]);
    const kept = rows.map((row) => row.slide_id).sort();
    expect(kept).toEqual(['sl-1', 'sl-2', 'sl-3']);
  });
});
