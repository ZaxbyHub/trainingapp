/**
 * Pins pages/documents.css to the constants DocumentList virtualizes with
 * (documentRowLayout.ts): the stacked-layout `@container` breakpoint and both row
 * heights. If the CSS and the constants drift, rows overlap or leave gaps.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ITEM_HEIGHT, STACKED_ITEM_HEIGHT, STACKED_MAX_WIDTH } from './documentRowLayout';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** CSS without comments, so a class name or rule mentioned in prose never matches. */
const css = read('../pages/documents.css').replace(/\/\*[\s\S]*?\*\//g, '');
const source = read('./DocumentList.tsx');

/** Body of the first `@container (max-width: Npx) { ... }` rule (one nesting level). */
function containerRules(): { width: number; body: string }[] {
  const rules: { width: number; body: string }[] = [];
  const re = /@container\s*\(\s*max-width:\s*(\d+)px\s*\)\s*\{([\s\S]*?)\n\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) rules.push({ width: Number(m[1]), body: m[2] });
  return rules;
}

describe('documents.css <-> documentRowLayout.ts', () => {
  it('has exactly one @container rule, at STACKED_MAX_WIDTH', () => {
    const rules = containerRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].width).toBe(STACKED_MAX_WIDTH);
  });

  it('the stacked row height inside that rule is STACKED_ITEM_HEIGHT; the base row is ITEM_HEIGHT', () => {
    const [{ body }] = containerRules();
    expect(/\.app-doc\s*\{[^}]*\bheight:\s*(\d+)px/.exec(body)?.[1]).toBe(String(STACKED_ITEM_HEIGHT));
    const base = css.replace(/@container[\s\S]*?\n\}/g, '');
    expect(/\.app-doc\s*\{[^}]*\bheight:\s*(\d+)px/.exec(base)?.[1]).toBe(String(ITEM_HEIGHT));
  });

  it('the table is the size container, and no viewport media query reflows rows', () => {
    expect(/\.app-doc-table\s*\{[^}]*container-type:\s*inline-size/.test(css)).toBe(true);
    for (const m of css.matchAll(/@media\s*\(\s*max-width:[^)]*\)\s*\{([\s\S]*?)\n\}/g)) {
      expect(m[1], 'a viewport media query styles document rows').not.toMatch(/\.app-doc(__[a-z-]+)?\b(?!-)/);
    }
  });

  it('DocumentList measures the table container, not the viewport', () => {
    expect(source).toContain('ResizeObserver');
    expect(source).not.toContain('matchMedia');
  });
});
