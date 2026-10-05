/**
 * Lumen token contrast guard (docs/design/design-language.md section 2 principle 5 and
 * section 6 phase 1). Parses the SHIPPED lumen-tokens.css (no duplicated
 * value table), resolves var() references, blends alpha colors over the
 * surface they are used on, and computes WCAG 2.x relative-luminance contrast
 * ratios. Text pairs must be >= 4.5:1; UI-boundary / state pairs >= 3:1.
 *
 * Exempt (stated, not tested as pass/fail): --text-disabled (WCAG 1.4.3
 * exempts inactive components; always paired with aria-disabled) and
 * --border-subtle (decorative divider, not a state boundary).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAIR_REMAP } from './token-remap';

type Theme = 'light' | 'dark';
type RGB = { r: number; g: number; b: number; a: number };

const css = readFileSync(resolve(__dirname, 'lumen-tokens.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

function blockDecls(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  // Top-level (non-nested) block for the selector; @media blocks nest `:root`
  // so require the selector at line start.
  const re = new RegExp(`^${selector.replace(/[[\]"]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(css);
  if (!m) throw new Error(`block not found: ${selector}`);
  for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(d[1], d[2].trim());
  return out;
}

const light = blockDecls(':root');
const dark = new Map([...light, ...blockDecls('[data-theme="dark"]')]);

function resolveValue(theme: Theme, name: string, depth = 0): string {
  if (depth > 8) throw new Error(`var cycle at ${name}`);
  const v = (theme === 'dark' ? dark : light).get(name);
  if (v === undefined) throw new Error(`undefined token ${name} (${theme})`);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  return ref ? resolveValue(theme, ref[1], depth + 1) : v;
}

function parseColor(v: string): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(v);
  if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  throw new Error(`unparseable color: ${v}`);
}

function blend(top: RGB, bottom: RGB): RGB {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** Effective opaque color of token `name`, composited over `over` tokens. */
function color(theme: Theme, name: string, over?: string): RGB {
  const c = parseColor(resolveValue(theme, name));
  if (c.a === 1) return c;
  if (over === undefined) throw new Error(`${name} is translucent; give a surface to blend over`);
  return blend(c, color(theme, over));
}

function luminance({ r, g, b }: RGB): number {
  const ch = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function ratio(fg: RGB, bg: RGB): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast of fg token over bg token; translucent bg blends over `base`. */
function contrast(theme: Theme, fg: string, bg: string, base = '--bg-surface'): number {
  const bgc = color(theme, bg, base);
  // fg may itself be translucent (borders): composite it over the bg first.
  const fgc = parseColor(resolveValue(theme, fg));
  return ratio(fgc.a === 1 ? fgc : blend(fgc, bgc), bgc);
}

const SURFACES = ['--bg-canvas', '--bg-surface', '--bg-raised', '--bg-sunken'] as const;
const INTERACTIVE_SURFACES = [...SURFACES, '--bg-hover', '--bg-hover-raised', '--bg-selected'] as const;
const STATUSES = ['success', 'warning', 'danger', 'info'] as const;
const THEMES: Theme[] = ['light', 'dark'];

/** Distinct [lumenFill, lumenFg] pairs of the phase-8 remap table (deleted tokens have none). */
const remapPairs: [string, string][] = [
  ...new Map(
    PAIR_REMAP.flatMap((p): [string, [string, string]][] =>
      p.lumenFill && p.lumenFg ? [[`${p.lumenFill}|${p.lumenFg}`, [p.lumenFill, p.lumenFg]]] : []
    )
  ).values(),
];


/** Every listed pair must pass its threshold in both themes (no recorded deviations). */
function check(theme: Theme, title: string, fn: () => void): void {
  it(`${theme}: ${title}`, fn);
}

describe('lumen token contrast (WCAG 2.x relative luminance)', () => {
  it('the remap table contributes pairs (guards against a vacuous loop)', () => {
    expect(remapPairs.length).toBeGreaterThanOrEqual(10);
    expect(remapPairs).toContainEqual(['--accent', '--accent-fg']);
    expect(remapPairs).toContainEqual(['--danger', '--danger-fg-on-fill']);
    expect(remapPairs).toContainEqual(['--bg-canvas', '--text-primary']);
    expect(remapPairs).toContainEqual(['--bubble-user', '--text-primary']);
  });

  it('sanity: black on white is 21:1 and the parser sees both themes', () => {
    expect(ratio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(21, 5);
    expect(resolveValue('light', '--accent')).toBe('#4a55f0');
    expect(resolveValue('dark', '--accent')).toBe('#7a8fff');
  });

  for (const theme of THEMES) {
    describe(theme, () => {
      // Hover/hover-raised/selected only occur under specific parents, so
      // primary/secondary text is checked on every surface, while the muted
      // tokens are checked on the surfaces the spec guarantees (canvas,
      // surface, raised, sunken, selected, hover-raised).
      for (const fg of ['--text-primary', '--text-secondary']) {
        for (const bg of INTERACTIVE_SURFACES) {
          check(theme, `${fg} on ${bg} >= 4.5`, () => {
            expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
      for (const fg of ['--text-tertiary', '--text-placeholder']) {
        for (const bg of [...SURFACES, '--bg-selected', '--bg-hover-raised']) {
          check(theme, `${fg} on ${bg} >= 4.5`, () => {
            expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
      for (const fg of ['--accent', '--accent-hover']) {
        for (const bg of [...SURFACES, '--bg-selected']) {
          check(theme, `${fg} (links/text) on ${bg} >= 4.5`, () => {
            expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
      check(theme, '--accent-fg on --accent >= 4.5', () => {
        expect(contrast(theme, '--accent-fg', '--accent')).toBeGreaterThanOrEqual(4.5);
      });
      check(theme, '--accent-fg on --accent-hover >= 4.5', () => {
        expect(contrast(theme, '--accent-fg', '--accent-hover')).toBeGreaterThanOrEqual(4.5);
      });

      for (const s of STATUSES) {
        for (const bg of SURFACES) {
          check(theme, `--${s} text on ${bg} >= 4.5`, () => {
            expect(contrast(theme, `--${s}`, bg)).toBeGreaterThanOrEqual(4.5);
          });
        }
        for (const base of ['--bg-surface', '--bg-canvas', '--bg-raised']) {
          check(theme, `--${s} text on --${s}-subtle (over ${base}) >= 4.5`, () => {
            expect(contrast(theme, `--${s}`, `--${s}-subtle`, base)).toBeGreaterThanOrEqual(4.5);
          });
        }
        check(theme, `--${s}-fg-on-fill on solid --${s} fill >= 4.5`, () => {
          expect(contrast(theme, `--${s}-fg-on-fill`, `--${s}`)).toBeGreaterThanOrEqual(4.5);
        });
        // Banner edge is a boundary: >= 3:1 against the surface it sits on.
        check(theme, `--${s}-border edge vs --bg-surface >= 3`, () => {
          expect(contrast(theme, `--${s}-border`, '--bg-surface')).toBeGreaterThanOrEqual(3);
        });
      }

      // 1.4.11 non-text contrast: control boundaries and state indicators.
      for (const bg of SURFACES) {
        check(theme, `--border-control on ${bg} >= 3`, () => {
          expect(contrast(theme, '--border-control', bg)).toBeGreaterThanOrEqual(3);
        });
        check(theme, `--focus-ring on ${bg} >= 3`, () => {
          expect(contrast(theme, '--focus-ring', bg)).toBeGreaterThanOrEqual(3);
        });
        check(theme, `--accent (switch/checkbox on-state) on ${bg} >= 3`, () => {
          expect(contrast(theme, '--accent', bg)).toBeGreaterThanOrEqual(3);
        });
      }
      check(theme, '--accent selected indicator vs --bg-selected >= 3', () => {
        expect(contrast(theme, '--accent', '--bg-selected')).toBeGreaterThanOrEqual(3);
      });
      check(theme, '--focus-ring on --bg-selected / hover surfaces >= 3', () => {
        for (const bg of ['--bg-selected', '--bg-hover', '--bg-hover-raised']) {
          expect(contrast(theme, '--focus-ring', bg)).toBeGreaterThanOrEqual(3);
        }
      });
      check(theme, '--border-control on --bg-selected / --bg-hover >= 3', () => {
        for (const bg of ['--bg-selected', '--bg-hover']) {
          expect(contrast(theme, '--border-control', bg)).toBeGreaterThanOrEqual(3);
        }
      });

      // Phase 8: every Lumen pair in the pairwise remap table (token-remap.ts) is a text
      // pair >= 4.5:1. Translucent fills (--bubble-user in dark) are composited over both
      // page surfaces they can sit on.
      for (const [fill, fg] of remapPairs) {
        for (const base of ['--bg-surface', '--bg-canvas']) {
          check(theme, `remap pair ${fg} on ${fill} (over ${base}) >= 4.5`, () => {
            expect(contrast(theme, fg, fill, base)).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
    });
  }
});

// Opt-in: `LUMEN_CONTRAST_TABLE=1 npx vitest run src/styles` prints every
// measured ratio (used to produce the human-readable results table).
describe.skipIf(!process.env.LUMEN_CONTRAST_TABLE)('lumen contrast table', () => {
  it('prints ratios', () => {
    const rows: string[] = [];
    for (const theme of THEMES) {
      const add = (fg: string, bg: string, base?: string) =>
        rows.push(`${theme}\t${fg} on ${bg}\t${contrast(theme, fg, bg, base).toFixed(2)}`);
      for (const bg of INTERACTIVE_SURFACES) {
        add('--text-primary', bg);
        add('--text-secondary', bg);
      }
      for (const bg of [...SURFACES, '--bg-selected']) {
        add('--text-tertiary', bg);
        add('--accent', bg);
        add('--accent-hover', bg);
      }
      add('--accent-fg', '--accent');
      for (const s of STATUSES) {
        add(`--${s}`, '--bg-surface');
        add(`--${s}`, `--${s}-subtle`, '--bg-surface');
        add(`--${s}-fg-on-fill`, `--${s}`);
        add(`--${s}-border`, '--bg-surface');
      }
      for (const bg of SURFACES) {
        add('--border-control', bg);
        add('--focus-ring', bg);
      }
    }
    console.info(rows.join('\n'));
  });
});
