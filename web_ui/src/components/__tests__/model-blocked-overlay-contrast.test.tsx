/**
 * Lumen phase 5 review F1 pin: ModelBlockedOverlay's two lists use Lumen text
 * tokens that pass AA on the overlay card (recommendations --text-secondary,
 * failures --danger). The legacy tokens (--color-text-muted 4.18:1,
 * --color-danger) failed, and axe in the full page can report these nodes as
 * merely "incomplete" (background undeterminable under the chat page), so a
 * regression could hide there. This pins the tokens directly. (Separate file so
 * phase 3's ModelBlockedOverlay.test.tsx edits stay conflict-free.)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ModelBlockedOverlay } from '../ModelBlockedOverlay';
import type { ReadinessResult } from '../../lib/llm/model-readiness';

const result: ReadinessResult = {
  ready: false,
  checks: {
    webgpu: false,
    memory: { availableBytes: 8e9, requiredBytes: 4e9, sufficient: true, tier: 'HIGH' as const },
    modelCached: false,
  },
  failures: ['This build is missing the packaged browser model.'],
  recommendations: ['WebGPU is unavailable, but the wllama engine runs on the CPU.'],
};

afterEach(() => cleanup());

describe('ModelBlockedOverlay list colours (F1 pin)', () => {
  it('recommendations use --text-secondary and failures use --danger (never the legacy tokens)', () => {
    render(
      <ModelBlockedOverlay
        readinessResult={result}
        browserEngine="wllama"
        modelLoadingProgress={0}
        onRetry={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );
    const failureList = screen.getByText(result.failures[0]).closest('ul')!;
    const recommendationList = screen.getByText(result.recommendations[0]).closest('ul')!;
    expect(failureList).not.toBe(recommendationList);

    expect(recommendationList.style.color).toBe('var(--text-secondary)');
    expect(failureList.style.color).toBe('var(--danger)');
    for (const list of [failureList, recommendationList]) {
      expect(list.style.color).not.toContain('--color-text-muted');
      expect(list.style.color).not.toContain('--color-danger');
    }
  });
});

/**
 * Computed ratio, not just the token names: resolve the shipped CSS values (the Lumen
 * text tokens through their var() chain; the overlay card's legacy --color-surface from
 * tokens.css for light and theme.css for dark) and apply the WCAG 2.x formula.
 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (file: string) => stripComments(readFileSync(resolve(__dirname, '../../styles', file), 'utf8'));
function declsOf(css: string, selector: RegExp): Map<string, string> {
  const m = selector.exec(css);
  if (!m) throw new Error(`block not found: ${selector}`);
  return new Map([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]));
}
const lumen = read('lumen-tokens.css');
const lightTokens = declsOf(lumen, /^:root\s*\{([^}]*)\}/m);
const darkTokens = new Map([...lightTokens, ...declsOf(lumen, /^\[data-theme="dark"\]\s*\{([^}]*)\}/m)]);
const surfaceLight = declsOf(read('tokens.css'), /^:root\s*\{([^}]*)\}/m).get('--color-surface');
const surfaceDark = declsOf(read('theme.css'), /^\[data-theme="dark"\]\s*\{([^}]*)\}/m).get('--color-surface');

function resolveToken(tokens: Map<string, string>, name: string): string {
  let v = tokens.get(name);
  for (let i = 0; i < 8 && v !== undefined; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (!ref) return v;
    v = tokens.get(ref[1]);
  }
  throw new Error(`cannot resolve ${name}`);
}
function luminance(hex: string): number {
  const n = parseInt(/^#([0-9a-f]{6})$/i.exec(hex)![1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('ModelBlockedOverlay list contrast (computed)', () => {
  it.each([
    ['light', lightTokens, surfaceLight],
    ['dark', darkTokens, surfaceDark],
  ] as const)('%s: both lists meet 4.5:1 against the overlay card surface', (_theme, tokens, surface) => {
    expect(surface).toMatch(/^#[0-9a-f]{6}$/i);
    for (const name of ['--text-secondary', '--danger']) {
      const fg = resolveToken(tokens, name);
      expect(fg, name).toMatch(/^#[0-9a-f]{6}$/i);
      expect(ratio(fg, surface as string), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
