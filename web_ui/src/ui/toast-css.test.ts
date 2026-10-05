/**
 * Toast stylesheet guard (jsdom cannot evaluate media queries): the toast motion must be
 * switched off under prefers-reduced-motion, forced-colors must restore a visible border,
 * and nothing may loop forever.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOAST_EXIT_MS } from './Toast';

const css = readFileSync(resolve(__dirname, 'toast.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const tokens = readFileSync(resolve(__dirname, '../styles/lumen-tokens.css'), 'utf8');

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

  it('makes the viewport click-through but the toasts interactive', () => {
    expect(css).toMatch(/\.ui-toast-viewport\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.ui-toast\s*\{[^}]*pointer-events:\s*auto/);
  });

  it('pins the JS exit timer to the --dur-base token the leaving transition uses', () => {
    const base = /--dur-base:\s*(\d+)ms/.exec(tokens);
    expect(base).not.toBeNull();
    expect(TOAST_EXIT_MS).toBe(Number(base![1]));
    expect(css).toMatch(/\.ui-toast--leaving\s*\{[^}]*transition:\s*opacity var\(--dur-base\)[^}]*transform var\(--dur-base\)/);
  });

  it('bounds the viewport height and scrolls, so a burst keeps every dismiss reachable', () => {
    expect(css).toMatch(/\.ui-toast-viewport\s*\{[^}]*max-block-size:[^;]+;[^}]*overflow-y:\s*auto/);
  });

  it('positions the viewport with logical properties (RTL-safe), never physical right/bottom', () => {
    const rule = /\.ui-toast-viewport\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/inset-inline-end:/);
    expect(rule).toMatch(/inset-block-end:/);
    expect(rule).not.toMatch(/(^|[;\s])(right|bottom|left|top):/);
  });

  it('never hides the live regions, so they stay in the accessibility tree while empty', () => {
    expect(css).not.toMatch(/\.ui-toast-region[^{]*\{[^}]*(display:\s*none|visibility:\s*hidden|hidden)/);
    expect(css).not.toMatch(/:empty/);
  });
});
