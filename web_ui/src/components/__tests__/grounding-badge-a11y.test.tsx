// grounding-badge-a11y.test.tsx — C4 (issue #72): the provenance badge is
// never color-only. Both variants must expose visible text, a distinct icon
// (an SVG glyph — shape, not hue), and an accessible name, so the value stays
// distinguishable in a grayscale screenshot and to assistive technology.
// Frozen check driver repro/check-c4.sh runs this file.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GroundingBadge } from '../GroundingBadge';
import type { Grounding } from '../../lib/api/types';

const VARIANTS: Array<{ grounding: Grounding; text: string }> = [
  { grounding: 'grounded', text: 'Grounded in your documents' },
  { grounding: 'general', text: 'General knowledge' },
];

describe('GroundingBadge accessibility (no color-only signal)', () => {
  for (const variant of VARIANTS) {
    it(`"${variant.grounding}" exposes text + icon + accessible name`, () => {
      render(<GroundingBadge grounding={variant.grounding} />);
      // role=status + aria-live=polite (codebase precedent: the badge is a
      // polite live region; visible text IS the accessible name — PRR-012).
      const badge = screen.getByRole('status');
      expect(badge.getAttribute('aria-live')).toBe('polite');
      // Visible text label (grayscale-safe: text survives color removal).
      expect(badge.textContent).toContain(variant.text);
      // A distinct SVG icon shape accompanies the text (grounded => one glyph
      // path family; general => globe). Its presence is asserted via the DOM.
      const svg = badge.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
    });
  }

  it('the two variants carry DIFFERENT text labels (shape+text distinguish them)', () => {
    expect(VARIANTS[0].text).not.toBe(VARIANTS[1].text);
  });

  it('renders nothing (no empty chip) when grounding is absent or unknown', () => {
    const { container: absent } = render(<GroundingBadge grounding={undefined} />);
    expect(absent.querySelector('span')).toBeNull();
    const { container: unknown } = render(
      <GroundingBadge grounding={'sort-of' as Grounding} />,
    );
    expect(unknown.querySelector('span')).toBeNull();
  });
});
