/**
 * Lumen phase 5 review F1 pin, rewritten for phase 7 (the overlay is now ui/Dialog +
 * ui/Banner, with no inline styles): ModelBlockedOverlay's two lists keep passing AA
 * on the overlay card. axe can report these nodes as merely "incomplete" (background
 * undeterminable under the chat page), so a regression could hide there; this pins it
 * directly. The failures list is a danger Banner and the recommendations list an info
 * Banner; both render their text through `.ui-banner__text` (--text-primary) over the
 * banner's own tinted background. Asserted three ways: the structure (Banner tone
 * classes, no inline style, no legacy token), the shipped ui.css binding of those
 * classes to Lumen tokens, and the computed WCAG ratio of those tokens.
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

const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const uiCss = stripCss(readFileSync(resolve(__dirname, '../../ui/ui.css'), 'utf8'));
const ruleBody = (selector: string): string => {
  const escaped = selector.replace(/[.]/g, String.raw`\.`);
  const m = new RegExp(String.raw`(?:^|\n)` + escaped + String.raw`\s*\{([^}]*)\}`).exec(uiCss);
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1];
};

describe('ModelBlockedOverlay lists (F1 pin, phase 7: Banner structure + token binding)', () => {
  it('failures are a danger Banner, recommendations an info Banner; no inline style, no legacy token', () => {
    const { container } = render(
      <ModelBlockedOverlay
        readinessResult={result}
        browserEngine="wllama"
        modelLoadingProgress={0}
        onRetry={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );
    const failureBanner = screen.getByText(result.failures[0]).closest('.ui-banner')!;
    const recommendationBanner = screen.getByText(result.recommendations[0]).closest('.ui-banner')!;
    expect(failureBanner).not.toBe(recommendationBanner);
    expect(failureBanner).toHaveClass('ui-banner--danger');
    expect(recommendationBanner).toHaveClass('ui-banner--info');
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/--color-/);
  });

  it('the shipped CSS binds the banner text to --text-primary and the card to --bg-raised (never legacy tokens)', () => {
    expect(ruleBody('.ui-banner__text')).toMatch(/color:\s*var\(--text-primary\)/);
    expect(ruleBody('.ui-dialog')).toMatch(/background:\s*var\(--bg-raised\)/);
    expect(ruleBody('.ui-banner--danger')).toMatch(/background:\s*var\(--danger-subtle\)/);
    expect(ruleBody('.ui-banner--info')).toMatch(/background:\s*var\(--info-subtle\)/);
    for (const sel of ['.ui-banner__text', '.ui-dialog', '.ui-banner--danger', '.ui-banner--info']) {
      expect(ruleBody(sel)).not.toContain('--color-');
    }
  });
});

/**
 * Computed ratio, not just the token names: resolve the shipped Lumen values (through
 * their var() chain, light and dark), composite the translucent dark banner tints over
 * the card, and apply the WCAG 2.x formula.
 */
const read = (file: string) => stripCss(readFileSync(resolve(__dirname, '../../styles', file), 'utf8'));
function declsOf(css: string, selector: RegExp): Map<string, string> {
  const m = selector.exec(css);
  if (!m) throw new Error(`block not found: ${selector}`);
  return new Map([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]));
}
const lumen = read('lumen-tokens.css');
const lightTokens = declsOf(lumen, /^:root\s*\{([^}]*)\}/m);
const darkTokens = new Map([...lightTokens, ...declsOf(lumen, /^\[data-theme="dark"\]\s*\{([^}]*)\}/m)]);

function resolveToken(tokens: Map<string, string>, name: string): string {
  let v = tokens.get(name);
  for (let i = 0; i < 8 && v !== undefined; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (!ref) return v;
    v = tokens.get(ref[1]);
  }
  throw new Error(`cannot resolve ${name}`);
}
type RGB = [number, number, number];
/** "#rrggbb" or "rgba(r, g, b, a)" composited over `under` (opaque). */
function toRgb(value: string, under?: RGB): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value);
  if (!m || !under) throw new Error(`cannot convert ${value}`);
  const a = Number(m[4]);
  return [0, 1, 2].map((i) => Math.round(Number(m[i + 1]) * a + under[i] * (1 - a))) as RGB;
}
function luminance(rgb: RGB): number {
  const ch = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function ratio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('ModelBlockedOverlay banner text contrast (computed)', () => {
  it.each([
    ['light', lightTokens],
    ['dark', darkTokens],
  ] as const)('%s: --text-primary meets 4.5:1 on the danger and info banner tints over the card, and --text-secondary on the card', (_theme, tokens) => {
    const card = toRgb(resolveToken(tokens, '--bg-raised'));
    const text = toRgb(resolveToken(tokens, '--text-primary'));
    for (const tint of ['--danger-subtle', '--info-subtle']) {
      const bg = toRgb(resolveToken(tokens, tint), card);
      expect(ratio(text, bg), `--text-primary on ${tint}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(toRgb(resolveToken(tokens, '--text-secondary')), card), '--text-secondary on --bg-raised').toBeGreaterThanOrEqual(4.5);
  });
});
