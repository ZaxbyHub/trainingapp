import { describe, expect, it } from 'vitest';
import { computeTooltipShift } from './tooltip-position';

describe('computeTooltipShift', () => {
  it('is 0 when the tooltip fits', () => expect(computeTooltipShift({ left: 100, right: 200 }, 500)).toBe(0));
  it('pulls a right-overflowing tooltip back by the overflow plus margin', () =>
    expect(computeTooltipShift({ left: 398, right: 514 }, 500)).toBe(-22));
  it('pushes a left-overflowing tooltip right', () =>
    expect(computeTooltipShift({ left: -20, right: 80 }, 500)).toBe(28));
  it('pins to the left margin when wider than the viewport', () =>
    expect(computeTooltipShift({ left: 10, right: 510 }, 400)).toBe(-2));
});
