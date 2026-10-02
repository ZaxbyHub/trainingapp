/**
 * Reduced-motion guard (docs/design/design-language.md section 3.4). jsdom cannot run
 * animations, so this parses the shipped ui.css: every rule that declares an
 * infinite animation must be switched off inside @media (prefers-reduced-motion:
 * reduce). Collapsing --dur-* tokens to ~0 is NOT enough for infinite animations
 * (they flicker at hundreds of Hz), hence the explicit `animation: none`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level `selector { body }` rules outside any @media block, with @media bodies split out. */
function parse(text: string): { base: Array<[string, string]>; reduced: Array<[string, string]> } {
  const base: Array<[string, string]> = [];
  const reduced: Array<[string, string]> = [];
  const mediaRe = /@media\s*([^{]+)\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g;
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const withoutMedia = text.replace(mediaRe, (_m, query: string, inner: string) => {
    if (/prefers-reduced-motion:\s*reduce/.test(query)) {
      for (const r of inner.matchAll(ruleRe)) reduced.push([r[1].trim(), r[2]]);
    }
    return '';
  });
  for (const r of withoutMedia.matchAll(ruleRe)) {
    if (!r[1].trim().startsWith('@keyframes')) base.push([r[1].trim(), r[2]]);
  }
  return { base, reduced };
}

describe('ui.css reduced motion', () => {
  const { base, reduced } = parse(css);
  const infinite = base.filter(([, body]) => /animation:[^;]*\binfinite\b/.test(body));

  it('finds the infinite animations (spinner, skeleton, indeterminate progress)', () => {
    expect(infinite.map(([sel]) => sel).sort()).toEqual(
      ['.ui-progress--indeterminate .ui-progress__fill', '.ui-skeleton', '.ui-spinner'].sort()
    );
  });

  for (const [selector] of infinite) {
    it(`${selector} is animation: none under prefers-reduced-motion`, () => {
      const hit = reduced.find(
        ([sel, body]) =>
          sel
            .split(',')
            .map((s) => s.trim())
            .includes(selector) && /animation:\s*none\b/.test(body)
      );
      expect(hit, `${selector} keeps its infinite animation under reduced motion`).toBeDefined();
    });
  }
});
