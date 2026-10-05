/**
 * Toast stylesheet guard (jsdom cannot evaluate media queries): the toast motion must be
 * switched off under prefers-reduced-motion, forced-colors must restore a visible border,
 * and nothing may loop forever.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'toast.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the first top-level @media block whose condition is exactly `query`. */
function block(query: string): string {
  const start = css.indexOf('@media (' + query + ')');
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

describe('toast.css', () => {
  it('turns the enter animation and the exit transition off under prefers-reduced-motion', () => {
    const reduced = block('prefers-reduced-motion: reduce');
    expect(reduced).toMatch(/\.ui-toast\s*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.ui-toast--leaving\s*\{[^}]*transition:\s*none/);
  });

  it('draws a CanvasText border under forced-colors', () => {
    expect(block('forced-colors: active')).toMatch(/\.ui-toast\s*\{[^}]*border:\s*1px solid CanvasText/);
  });

  it('never loops an animation', () => {
    expect(css).not.toMatch(/\binfinite\b/);
  });

  it('makes the viewport click-through but the toasts interactive, and hides empty regions', () => {
    expect(css).toMatch(/\.ui-toast-viewport\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.ui-toast\s*\{[^}]*pointer-events:\s*auto/);
    expect(css).toMatch(/\.ui-toast-region:empty\s*\{\s*display:\s*none/);
  });
});
