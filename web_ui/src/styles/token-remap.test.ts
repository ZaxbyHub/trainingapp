/**
 * Phase-8: the remap table (token-remap.ts) and the frozen retired list
 * (retired-tokens.ts) must agree, and every Lumen replacement must be a real
 * token. The contrast of every Lumen pair is asserted in
 * lumen-tokens.contrast.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETIRED_TOKENS, RETIRED_TOKEN_RE } from './retired-tokens';
import { PAIR_REMAP, SCALAR_REMAP, remappedLegacyNames } from './token-remap';

const lumenCss = readFileSync(resolve(__dirname, 'lumen-tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const LUMEN = new Set([...lumenCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

describe('retired tokens and the remap table', () => {
  it('the retired list is frozen data: non-empty, unique, and none of it is declared by Lumen', () => {
    expect(RETIRED_TOKENS.length).toBeGreaterThan(50);
    expect(new Set(RETIRED_TOKENS).size).toBe(RETIRED_TOKENS.length);
    expect(RETIRED_TOKENS.filter((n) => LUMEN.has(n))).toEqual([]);
  });

  it('the matcher flags retired names and keeps longer non-retired names legal', () => {
    expect(RETIRED_TOKEN_RE.test('var(--color-primary)')).toBe(true);
    expect(RETIRED_TOKEN_RE.test('font-family: var(--font-family)')).toBe(true);
    expect(RETIRED_TOKEN_RE.test('var(--font-family-mono)')).toBe(false);
    expect(RETIRED_TOKEN_RE.test('var(--font-mono)')).toBe(false);
    expect(RETIRED_TOKEN_RE.test('var(--color-primaryx)')).toBe(false);
    expect(RETIRED_TOKEN_RE.test('var(--shadow-1)')).toBe(false);
  });

  it('every retired token is accounted for by the remap table, and the table names nothing else', () => {
    const remapped = remappedLegacyNames();
    expect(RETIRED_TOKENS.filter((n) => !remapped.has(n))).toEqual([]);
    expect([...remapped].filter((n) => !RETIRED_TOKENS.includes(n))).toEqual([]);
  });

  it('every Lumen replacement named by the table is a declared Lumen token', () => {
    const names = [
      ...PAIR_REMAP.flatMap((p) => [p.lumenFill, p.lumenFg]),
      ...SCALAR_REMAP.map((s) => s.lumen),
    ].filter((n): n is string => n !== null);
    expect(names.length).toBeGreaterThan(30);
    expect(names.filter((n) => !LUMEN.has(n))).toEqual([]);
  });

  it('--color-primary-rgb is recorded as having no consumers and no replacement', () => {
    const row = PAIR_REMAP.find((p) => p.legacyFill === '--color-primary-rgb');
    expect(row?.lumenFill).toBeNull();
    expect(row?.note).toMatch(/no consumers/);
  });
});
