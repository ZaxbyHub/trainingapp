// c4-recency-formula.test.ts — AC3 formula exactness on the Node backend
// (issue #71). Frozen check driver repro/check-c4.sh runs this file.
// Values must match tests/test_c4_recency_formula.py at 1e-9.
import { describe, expect, it } from 'vitest';

import {
  applyRecencyPrior,
  precedenceWinner,
  recencyMultiplier,
} from '../../main/backend/retrieval/recency';

const NOW = new Date('2026-09-18T12:00:00.000Z');

const MONTH = 30.44 * 24 * 60 * 60 * 1000;
function monthsAgo(months: number): string {
  return new Date(NOW.getTime() - months * MONTH).toISOString();
}

describe('c4 recency multiplier (AC3, issue #71)', () => {
  it('matches the pinned linear formula at the four acceptance ages', () => {
    expect(recencyMultiplier(NOW.toISOString(), { now: NOW })).toBeCloseTo(1.0, 12);
    expect(recencyMultiplier(monthsAgo(9), { now: NOW })).toBeCloseTo(0.925, 9);
    expect(recencyMultiplier(monthsAgo(18), { now: NOW })).toBeCloseTo(0.85, 9);
    // The floor holds past the horizon.
    expect(recencyMultiplier(monthsAgo(36), { now: NOW })).toBeCloseTo(0.85, 9);
  });

  it('is neutral for missing/unparseable/future published_at', () => {
    expect(recencyMultiplier(null, { now: NOW })).toBe(1);
    expect(recencyMultiplier(undefined, { now: NOW })).toBe(1);
    expect(recencyMultiplier('', { now: NOW })).toBe(1);
    expect(recencyMultiplier('not-a-date', { now: NOW })).toBe(1);
    expect(recencyMultiplier(new Date(NOW.getTime() + 86_400_000).toISOString(), { now: NOW })).toBe(1);
  });

  it('honors the configurable floor and horizon', () => {
    expect(
      recencyMultiplier(monthsAgo(6), { now: NOW, floor: 0.5, floorMonths: 6 }),
    ).toBeCloseTo(0.5, 9);
    // Halfway to the floor.
    expect(
      recencyMultiplier(monthsAgo(9), { now: NOW, floor: 0.5, floorMonths: 18 }),
    ).toBeCloseTo(0.75, 9);
  });
});

describe('c4 cross-pack dedup + precedence (AC5, issue #71)', () => {
  const NEWER = { packId: 'pack-b', version: '1.0.0', publishedAt: monthsAgo(1), active: true };
  const OLDER = { packId: 'pack-a', version: '3.0.0', publishedAt: monthsAgo(30), active: true };
  const INACTIVE = { packId: 'pack-c', version: '9.0.0', publishedAt: monthsAgo(0), active: false };

  it('keeps exactly one copy attributed to the newest published_at, 10x stable', () => {
    const claims = new Map([['chunkH', [OLDER, NEWER, INACTIVE]]]);
    for (let run = 0; run < 10; run += 1) {
      const ranked = applyRecencyPrior([['chunkH', 0.03]], claims, { now: NOW });
      expect(ranked).toHaveLength(1);
      const [chunkId, adjusted] = ranked[0] as [string, number];
      expect(chunkId).toBe('chunkH');
      expect(adjusted).toBeCloseTo(0.03 * recencyMultiplier(NEWER.publishedAt, { now: NOW }), 12);
    }
  });

  it('breaks publishedAt ties on semver, then lexicographic id', () => {
    const samePub = monthsAgo(4);
    const semverTie = new Map([
      [
        'chunkH',
        [
          { packId: 'pack-b', version: '1.0.0', publishedAt: samePub, active: true },
          { packId: 'pack-a', version: '2.0.0', publishedAt: samePub, active: true },
        ],
      ],
    ]);
    const ranked = applyRecencyPrior([['chunkH', 0.01]], semverTie, { now: NOW });
    expect(ranked).toHaveLength(1); // survives; attribution checked in pipeline tests

    const idTie = new Map([
      [
        'chunkH',
        [
          { packId: 'pack-a', version: '2.0.0', publishedAt: samePub, active: true },
          { packId: 'pack-b', version: '2.0.0', publishedAt: samePub, active: true },
        ],
      ],
    ]);
    const idTieRanked = applyRecencyPrior([['chunkH', 0.01]], idTie, { now: NOW });
    expect(idTieRanked).toHaveLength(1);
    // Lexicographic tie-break parity with Python: pack-b wins.
    expect(precedenceWinner(idTie.get('chunkH') as never)?.packId).toBe('pack-b');
  });

  it('collapses duplicate chunk ids to one copy deterministically', () => {
    const claims = new Map([['chunkH', [NEWER, OLDER]]]);
    const first = applyRecencyPrior(
      [
        ['chunkH', 0.02],
        ['chunkH', 0.03],
      ],
      claims,
      { now: NOW },
    );
    expect(first).toHaveLength(1);
    for (let run = 0; run < 10; run += 1) {
      expect(applyRecencyPrior([['chunkH', 0.02], ['chunkH', 0.03]], claims, { now: NOW })).toEqual(first);
    }
  });
});
