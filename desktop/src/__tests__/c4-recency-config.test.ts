// c4-recency-config.test.ts — packs.recency.* env keys on the Node backend
// (issue #71, AC6). Frozen check driver repro/check-c7.sh runs this file.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETRIEVAL_CONFIG,
  PACKS_RECENCY_FLOOR_ENV,
  PACKS_RECENCY_FLOOR_MONTHS_ENV,
  PACKS_RECENCY_HALF_LIFE_MONTHS_ENV,
  resolveRetrievalConfig,
} from '../../main/backend/retrieval/config';
import { recencyMultiplier } from '../../main/backend/retrieval/recency';

describe('c4 packs.recency.* config keys (issue #71)', () => {
  it('defaults to floor 0.85 / floorMonths 18 / halfLifeMonths 9', () => {
    expect(DEFAULT_RETRIEVAL_CONFIG.packsRecencyFloor).toBe(0.85);
    expect(DEFAULT_RETRIEVAL_CONFIG.packsRecencyFloorMonths).toBe(18);
    expect(DEFAULT_RETRIEVAL_CONFIG.packsRecencyHalfLifeMonths).toBe(9);
    const config = resolveRetrievalConfig({});
    expect(config.packsRecencyFloor).toBe(0.85);
    expect(config.packsRecencyFloorMonths).toBe(18);
    expect(config.packsRecencyHalfLifeMonths).toBe(9);
  });

  it('honors TRAININGAPP_PACKS_RECENCY_* overrides', () => {
    const config = resolveRetrievalConfig({
      [PACKS_RECENCY_FLOOR_ENV]: '0.5',
      [PACKS_RECENCY_FLOOR_MONTHS_ENV]: '6',
      [PACKS_RECENCY_HALF_LIFE_MONTHS_ENV]: '12',
    });
    expect(config.packsRecencyFloor).toBe(0.5);
    expect(config.packsRecencyFloorMonths).toBe(6);
    expect(config.packsRecencyHalfLifeMonths).toBe(12);
  });

  it('falls back to defaults on invalid input', () => {
    const config = resolveRetrievalConfig({
      [PACKS_RECENCY_FLOOR_ENV]: 'banana',
      [PACKS_RECENCY_FLOOR_MONTHS_ENV]: 'zero',
      [PACKS_RECENCY_HALF_LIFE_MONTHS_ENV]: '-3',
    });
    expect(config.packsRecencyFloor).toBe(0.85);
    expect(config.packsRecencyFloorMonths).toBe(18);
    expect(config.packsRecencyHalfLifeMonths).toBe(9);
  });

  it('overrides observably change the multiplier', () => {
    const NOW = new Date('2026-09-18T12:00:00.000Z');
    const MONTH = 30.44 * 24 * 60 * 60 * 1000;
    const at = new Date(NOW.getTime() - 6 * MONTH).toISOString();
    const defaultMultiplier = recencyMultiplier(at, { now: NOW });
    const overrideMultiplier = recencyMultiplier(at, {
      now: NOW,
      floor: resolveRetrievalConfig({ [PACKS_RECENCY_FLOOR_ENV]: '0.5' })
        .packsRecencyFloor,
      floorMonths: resolveRetrievalConfig({
        [PACKS_RECENCY_FLOOR_MONTHS_ENV]: '6',
      }).packsRecencyFloorMonths,
    });
    // 6 months at defaults (floor 0.85, horizon 18) is one third of the way
    // down: 1 - 0.15 * (6/18) = 0.95; the override reaches its floor exactly.
    expect(defaultMultiplier).toBeCloseTo(0.95, 9);
    expect(overrideMultiplier).toBeCloseTo(0.5, 9);
  });
});
