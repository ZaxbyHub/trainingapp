/**
 * Phase-7 ratchet (docs/design/design-language.md sections 4-6): the blocking
 * overlay components (chat-page model gates, ErrorBoundary fallback) use ONLY
 * Lumen tokens and ui primitives. No legacy token (--color-*, --spacing-*, ...),
 * no color literal, no inline `style` prop, and no `var(--token, fallback)`:
 * a fallback masks an undefined token (the desktop gate rendered a white card in
 * dark mode through `var(--color-bg-primary, #fff)`). Local custom properties
 * that are legitimately defaulted (settings.css --settings-nav-h, ui.css
 * --ui-tooltip-shift) are outside these files. Mirrors pages/chat-hygiene.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');
const FILES = [
  'components/ModelBlockedOverlay.tsx',
  'components/DesktopModelBlockedOverlay.tsx',
  'components/ErrorBoundary.tsx',
  'components/blocking.css',
];

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const declared = (css: string): Set<string> =>
  new Set([...stripComments(css).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const LUMEN = declared(readFileSync(resolve(SRC, 'styles/lumen-tokens.css'), 'utf8'));
const LEGACY_NAMES = [...declared(readFileSync(resolve(SRC, 'styles/tokens.css'), 'utf8'))].filter((n) => !LUMEN.has(n));
const LEGACY = new RegExp(`(${LEGACY_NAMES.join('|')})(?![\w-])`);
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const INLINE_STYLE = /\bstyle=\{/;
const VAR_FALLBACK = /var\(\s*--[\w-]+\s*,/;
const USED_VARS = /var\(\s*(--[\w-]+)/g;

describe('blocking overlay hygiene (phase 7)', () => {
  it('the detectors are not vacuous', () => {
    expect(LEGACY_NAMES).toContain('--color-primary');
    expect(LEGACY.test('var(--color-text-muted)')).toBe(true);
    expect(VAR_FALLBACK.test('var(--color-border, #ddd)')).toBe(true);
    expect(VAR_FALLBACK.test('var(--space-3)')).toBe(false);
    expect(INLINE_STYLE.test('<div style={{ a: 1 }} />')).toBe(true);
  });

  for (const rel of FILES) {
    it(`${rel}: Lumen tokens only, no color literals, no inline styles, no var() fallbacks`, () => {
      const text = stripComments(readFileSync(resolve(SRC, rel), 'utf8'));
      expect(LEGACY.exec(text)?.[0], 'legacy token').toBeUndefined();
      expect(COLOR_LITERAL.exec(text)?.[0], 'color literal').toBeUndefined();
      expect(INLINE_STYLE.test(text), 'inline style prop').toBe(false);
      expect(VAR_FALLBACK.exec(text)?.[0], 'var() fallback').toBeUndefined();
    });
  }

  it('every token blocking.css reads is a declared Lumen token', () => {
    const css = stripComments(readFileSync(resolve(SRC, 'components/blocking.css'), 'utf8'));
    const used = [...css.matchAll(USED_VARS)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(5);
    for (const name of used) expect(LUMEN.has(name), name).toBe(true);
  });
});
