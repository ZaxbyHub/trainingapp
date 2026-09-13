// links-ac5-threshold.test.ts — D4 AC5 acceptance check (issue #80).
//
// Threshold respected: a synthetic embedding pair BELOW the threshold
// produces no link row. One doc chunk has cosine ~0.9 to slide A and ~0.05
// to slide B. Under the default threshold (0.5 per the issue's proposed
// default) and under an explicit threshold option of 0.5, slide B must never
// be referenced, and slide A yields exactly one row.
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

const CHUNK_ID = 'd4-ac5-chunk';
const PACK_ID = 'd4-ac5-doc-pack';

// 4-dim fixtures: doc chunk along x; slide A at cosine 0.9, slide B at 0.05.
const docVector = [1, 0, 0, 0];
const slideA: LinkSlideInput = {
  slideId: 'slide-a',
  vector: [0.9, Math.sqrt(1 - 0.9 * 0.9), 0, 0],
};
const slideB: LinkSlideInput = {
  slideId: 'slide-b',
  vector: [0.05, Math.sqrt(1 - 0.05 * 0.05), 0, 0],
};
const chunkInputs: LinkChunkInput[] = [{ chunkId: CHUNK_ID, packId: PACK_ID, vector: docVector }];

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

function assertThresholdBehavior(rows: LinkRow[], label: string): void {
  const forChunk = rows.filter((row) => row.chunk_id === CHUNK_ID);
  // No row references the below-threshold slide in any configuration.
  expect(forChunk.filter((row) => row.slide_id === 'slide-b'), `${label}: slide-b must not be linked`).toHaveLength(0);
  // Exactly one row, and it is the above-threshold slide A at rank 1.
  expect(forChunk, `${label}: exactly one row for the chunk`).toHaveLength(1);
  const row = forChunk[0];
  if (row === undefined) throw new Error('unreachable');
  expect(row.slide_id).toBe('slide-a');
  expect(row.rank).toBe(1);
  expect(Math.abs(row.score - cosine(docVector, slideA.vector))).toBeLessThan(1e-9);
}

describe('links-ac5: similarity threshold respected (D4, issue #80)', () => {
  it('fixture self-check: cosine ~0.9 to slide A and ~0.05 to slide B', () => {
    expect(Math.abs(cosine(docVector, slideA.vector) - 0.9)).toBeLessThan(1e-12);
    expect(Math.abs(cosine(docVector, slideB.vector) - 0.05)).toBeLessThan(1e-12);
  });

  it('default threshold links only the above-threshold slide', () => {
    assertThresholdBehavior(compute(chunkInputs, [slideA, slideB]), 'default options');
  });

  it('explicit threshold 0.5 links only the above-threshold slide', () => {
    assertThresholdBehavior(compute(chunkInputs, [slideA, slideB], { threshold: 0.5 }), 'explicit threshold 0.5');
  });

  it('explicit threshold 0.1 still excludes the ~0.05 pair', () => {
    // 0.1 > 0.05: even a lowered explicit threshold must keep slide B out.
    assertThresholdBehavior(compute(chunkInputs, [slideA, slideB], { threshold: 0.1 }), 'explicit threshold 0.1');
  });
});
