/**
 * Phase-2 guardrail: src/ui/ components use ONLY the Lumen tokens. Any
 * reference to a legacy token family, any hard-coded color literal, or any
 * CSS-in-JS escape hatch (docs/design/design-language.md section 4) fails this test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETIRED_TOKENS, RETIRED_TOKEN_RE } from '../styles/retired-tokens';

const UI_DIR = __dirname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const sources = walk(UI_DIR).filter(
  (f) => /\.(css|tsx?)$/.test(f) && !/\.test\.(tsx?)$/.test(f)
);

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const LUMEN_TOKENS = readFileSync(resolve(UI_DIR, '../styles/lumen-tokens.css'), 'utf8');
const declared = (css: string): Set<string> =>
  new Set([...stripComments(css).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const LUMEN_DECLARED = declared(LUMEN_TOKENS);
/** The frozen retired-token list (styles/retired-tokens.ts). */
const LEGACY_NAMES = RETIRED_TOKENS;
// Trailing (?![\w-]) keeps --font-family from matching --font-family-mono style names.
const LEGACY = RETIRED_TOKEN_RE;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const ESCAPE_HATCH = /\bcssText\b|\binsertRule\b|dangerouslySetInnerHTML|\.innerHTML\b/;

describe('src/ui token hygiene', () => {
  it('finds the component sources to scan', () => {
    expect(sources.some((f) => f.endsWith('ui.css'))).toBe(true);
    expect(sources.some((f) => f.endsWith('Button.tsx'))).toBe(true);
  });

  for (const file of sources) {
    const rel = file.slice(resolve(UI_DIR, '..').length + 1);
    it(`${rel} references no legacy tokens, color literals, or CSS-in-JS`, () => {
      const text = stripComments(readFileSync(file, 'utf8'));
      expect(text.match(LEGACY)?.[0]).toBeUndefined();
      expect(text.match(COLOR_LITERAL)?.[0]).toBeUndefined();
      expect(text.match(ESCAPE_HATCH)?.[0]).toBeUndefined();
    });
  }

  it('uses the frozen retired token list (includes --font-family, excludes Lumen names)', () => {
    expect(LEGACY_NAMES).toContain('--font-family');
    expect(LEGACY_NAMES).toContain('--color-primary');
    expect(LEGACY_NAMES.filter((n) => LUMEN_DECLARED.has(n))).toEqual([]);
    expect(LEGACY.test('font-family: var(--font-family)')).toBe(true);
    expect(LEGACY.test('var(--font-family-mono)')).toBe(false);
  });

  it('every var(--x) used in any src/ui css or tsx file (incl. inline styles) is defined in lumen-tokens.css', () => {
    const scanned = sources.filter((f) => /\.(css|tsx)$/.test(f));
    expect(scanned.filter((f) => f.endsWith('.css')).length).toBeGreaterThanOrEqual(2); // ui.css + gallery/gallery.css
    expect(scanned.some((f) => f.endsWith('.tsx'))).toBe(true);
    // Component-private runtime properties (--ui-*) are allowed when the component itself
    // sets them (e.g. Tooltip's --ui-tooltip-shift via style.setProperty); they are not tokens.
    const privateSet = new Set<string>();
    for (const f of scanned) {
      for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(/setProperty\(\s*['"`](--ui-[\w-]+)/g)) {
        privateSet.add(m[1]);
      }
    }
    const missing: string[] = [];
    for (const f of scanned) {
      const text = stripComments(readFileSync(f, 'utf8'));
      for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!LUMEN_DECLARED.has(m[1]) && !privateSet.has(m[1])) missing.push(`${f}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
