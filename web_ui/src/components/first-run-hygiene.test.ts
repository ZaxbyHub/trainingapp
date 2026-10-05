/**
 * Phase-7 ratchet (docs/design/design-language.md sections 4 and 6): the first-run
 * wizard and the toast provider use ONLY Lumen tokens and classes. No legacy token
 * (--color-*, --spacing-*, ...), no var(--x, fallback) (a fallback hides an UNDEFINED
 * token: the wizard once shipped var(--color-bg-surface, #1e1e1e), a dark panel in the
 * light theme), no token that Lumen does not declare, no color literal, no inline
 * `style` prop, no CSS-in-JS escape hatch. Same rules as settings-hygiene.test.ts;
 * src/ui/ (including Toast.tsx / toast.css) is covered by ui/ui-token-hygiene.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETIRED_TOKENS, RETIRED_TOKEN_RE } from '../styles/retired-tokens';

const SRC = resolve(__dirname, '..');
const FILES = ['components/FirstRunWizard.tsx', 'components/first-run.css', 'components/ToastProvider.tsx'];

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const declared = (css: string): Set<string> =>
  new Set([...stripComments(css).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const LUMEN = declared(readFileSync(resolve(SRC, 'styles/lumen-tokens.css'), 'utf8'));
/** The frozen retired-token list (styles/retired-tokens.ts). */
const LEGACY_NAMES = RETIRED_TOKENS;
const LEGACY = RETIRED_TOKEN_RE;
const FALLBACK = /var\(\s*--[\w-]+\s*,/;
const USED_VAR = /var\(\s*(--[\w-]+)/g;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const ESCAPE_HATCH = /\bcssText\b|\binsertRule\b|dangerouslySetInnerHTML|\.innerHTML\b/;
const INLINE_STYLE = /\bstyle=\{/;
const unknownTokens = (text: string): string[] =>
  [...text.matchAll(USED_VAR)].map((m) => m[1]).filter((n) => !LUMEN.has(n));

describe('first-run + toast token hygiene (phase 7)', () => {
  it('the checks are live (guards against a vacuous pass)', () => {
    expect(LEGACY_NAMES).toContain('--color-primary');
    expect(LEGACY.test('var(--color-primary)')).toBe(true);
    // The lookahead boundary: a longer, non-legacy name must not match its legacy prefix.
    expect(LEGACY.test('var(--color-primaryx)')).toBe(false);
    expect(LEGACY.test('var(--color-primary-zzz)')).toBe(false);
    // The three tokens the wizard used to reference are declared nowhere: only the
    // undeclared-token check (and not the legacy list) can catch them.
    expect(unknownTokens('x: var(--color-border, #444) var(--color-bg-surface) var(--font-size-title)')).toEqual([
      '--color-border',
      '--color-bg-surface',
      '--font-size-title',
    ]);
    expect(FALLBACK.test('var(--bg-raised, #1e1e1e)')).toBe(true);
    expect(FALLBACK.test('var(--bg-raised)')).toBe(false);
    expect(LUMEN.has('--bg-raised')).toBe(true);
    expect(LUMEN.has('--color-border')).toBe(false);
  });

  for (const file of FILES) {
    describe(file, () => {
      const text = stripComments(readFileSync(resolve(SRC, file), 'utf8'));

      it('references no legacy token, color literal, or CSS-in-JS escape hatch', () => {
        expect(text.match(LEGACY)?.[0]).toBeUndefined();
        expect(text.match(COLOR_LITERAL)?.[0]).toBeUndefined();
        expect(text.match(ESCAPE_HATCH)?.[0]).toBeUndefined();
      });

      it('uses no var(--x, fallback)', () => {
        expect(text.match(FALLBACK)?.[0]).toBeUndefined();
      });

      it('uses only tokens that lumen-tokens.css declares', () => {
        expect(unknownTokens(text)).toEqual([]);
      });

      it('carries no inline style prop', () => {
        expect(INLINE_STYLE.test(text)).toBe(false);
      });
    });
  }
});
