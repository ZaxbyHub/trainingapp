/**
 * Phase-2 guardrail: src/ui/ components use ONLY the Lumen tokens. Any
 * reference to a legacy token family, any hard-coded color literal, or any
 * CSS-in-JS escape hatch (design-language.md section 4) fails this test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

const LEGACY = /--(color|radius|spacing|font-size|line-height|shadow-(sm|md|lg))\b/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const ESCAPE_HATCH = /\bcssText\b|\binsertRule\b|dangerouslySetInnerHTML|\.innerHTML\b/;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

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

  it('every var(--x) used in any src/ui css file is defined in lumen-tokens.css', () => {
    const tokens = readFileSync(resolve(UI_DIR, '../styles/lumen-tokens.css'), 'utf8');
    const defined = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const cssFiles = sources.filter((f) => f.endsWith('.css'));
    expect(cssFiles.length).toBeGreaterThanOrEqual(2); // ui.css + gallery/gallery.css
    const missing: string[] = [];
    for (const f of cssFiles) {
      const css = stripComments(readFileSync(f, 'utf8'));
      for (const m of css.matchAll(/var\((--[\w-]+)/g)) {
        if (!defined.has(m[1])) missing.push(`${f}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
