/**
 * Disabled-cursor guard (docs/design/design-language.md section 3.6). jsdom does
 * not resolve the cascade, so this parses the shipped ui.css and resolves, for
 * representative disabled elements, which `cursor` declaration wins by
 * specificity then source order. Regression: a 0,1,0 `.ui-disabled *` rule used
 * to lose to the later `.ui-radio-card` / `.ui-segmented__*` pointer rules.
 *
 * Supported selector subset (everything else is skipped, so a rule using
 * pseudo-classes/attributes/sibling combinators never counts as a match):
 * descendant chains of compound selectors made of a tag, classes, or `*`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface El {
  tag: string;
  classes: string[];
}
interface Rule {
  selector: string;
  cursor: string;
  order: number;
}

const rules: Rule[] = [];
{
  // Drop @media/@keyframes blocks (their inner rules are not unconditional).
  const flat = css.replace(/@[a-z-]+[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '');
  let order = 0;
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const c = /(?:^|;|\s)cursor:\s*([a-z-]+)/.exec(m[2]);
    order += 1;
    if (!c) continue;
    for (const sel of m[1].split(',')) rules.push({ selector: sel.trim(), cursor: c[1], order });
  }
}

function matchesCompound(compound: string, el: El): boolean | null {
  if (/[:[+~>]/.test(compound)) return null; // unsupported
  const parts = compound.match(/\*|[.]?[A-Za-z0-9_-]+/g) ?? [];
  for (const p of parts) {
    if (p === '*') continue;
    if (p.startsWith('.')) {
      if (!el.classes.includes(p.slice(1))) return false;
    } else if (el.tag !== p) return false;
  }
  return true;
}

/** Specificity (classes only; tags ignored since none of our rules differ on them). */
function matches(selector: string, chain: El[]): { ok: boolean; spec: number } {
  const compounds = selector.split(/\s+/);
  let ci = compounds.length - 1;
  const target = chain[chain.length - 1];
  const first = matchesCompound(compounds[ci], target);
  if (first !== true) return { ok: false, spec: 0 };
  ci -= 1;
  for (let ai = chain.length - 2; ai >= 0 && ci >= 0; ai -= 1) {
    if (matchesCompound(compounds[ci], chain[ai]) === true) ci -= 1;
  }
  const spec = (selector.match(/\./g) ?? []).length;
  return { ok: ci < 0, spec };
}

function winningCursor(chain: El[]): string | undefined {
  let best: { spec: number; order: number; cursor: string } | undefined;
  for (const r of rules) {
    const m = matches(r.selector, chain);
    if (!m.ok) continue;
    if (!best || m.spec > best.spec || (m.spec === best.spec && r.order > best.order)) {
      best = { spec: m.spec, order: r.order, cursor: r.cursor };
    }
  }
  return best?.cursor;
}

const el = (tag: string, ...classes: string[]): El => ({ tag, classes });

describe('ui.css disabled cursor resolves to not-allowed', () => {
  // Control: the resolver sees the pointer rules for ENABLED items (guards against a vacuous pass).
  it('enabled items resolve to pointer', () => {
    expect(winningCursor([el('label', 'ui-radio-card')])).toBe('pointer');
    expect(winningCursor([el('label', 'ui-segmented__item'), el('input', 'ui-segmented__input')])).toBe('pointer');
    expect(winningCursor([el('label', 'ui-toggle', 'ui-switch'), el('input', 'ui-toggle__input')])).toBe('pointer');
  });

  const cases: Array<[string, El[]]> = [
    ['radio card label', [el('label', 'ui-radio-card', 'ui-disabled')]],
    ['radio card input', [el('label', 'ui-radio-card', 'ui-disabled'), el('input', 'ui-radio-card__input')]],
    [
      'radio card text',
      [el('label', 'ui-radio-card', 'ui-disabled'), el('span', 'ui-radio-card__text'), el('span', 'ui-radio-card__label')],
    ],
    ['segmented item', [el('label', 'ui-segmented__item', 'ui-disabled')]],
    [
      'segmented item (selected)',
      [el('label', 'ui-segmented__item', 'ui-segmented-on', 'ui-disabled')],
    ],
    ['segmented input', [el('label', 'ui-segmented__item', 'ui-disabled'), el('input', 'ui-segmented__input')]],
    ['switch label', [el('label', 'ui-toggle', 'ui-switch', 'ui-disabled')]],
    ['switch input', [el('label', 'ui-toggle', 'ui-switch', 'ui-disabled'), el('input', 'ui-toggle__input')]],
    ['checkbox input', [el('label', 'ui-toggle', 'ui-checkbox', 'ui-disabled'), el('input', 'ui-toggle__input')]],
  ];
  for (const [name, chain] of cases) {
    it(`${name}: cursor not-allowed`, () => {
      expect(winningCursor(chain)).toBe('not-allowed');
    });
  }

  it('a disabled+selected segmented item uses the disabled text color', () => {
    expect(css).toMatch(/\.ui-segmented__item\.ui-disabled\.ui-segmented-on\s*\{[^}]*color:\s*var\(--text-disabled\)/);
  });
});
