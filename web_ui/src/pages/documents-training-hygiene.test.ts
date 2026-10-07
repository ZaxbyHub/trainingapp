/**
 * Phase-6 ratchet (docs/design/design-language.md sections 4 and 6): the
 * Documents and Training surfaces migrated to Lumen use ONLY Lumen tokens. The
 * files below may not reference a legacy token (--color-*, --spacing-*, ...),
 * hold a color literal, or use a CSS-in-JS escape hatch, and their inline
 * `style` props may carry only POSITIONAL properties (DocumentList's
 * virtualization computes row offsets and the scroll height per render).
 *
 * The TrainingPlayer <iframe> is scanned like everything else (phase 8 moved its
 * legacy inline style to the .app-player__frame class in training.css). It is the
 * security-critical isolation surface, so a test below pins that there is exactly
 * one, that it carries that class and no `style`, and that sandbox/src/onLoad/ref
 * are still present.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETIRED_TOKENS, RETIRED_TOKEN_RE } from '../styles/retired-tokens';
import { COLOR_LITERAL_RE } from '../styles/color-literals';

const SRC = resolve(__dirname, '..');
const FILES = [
  'pages/DocumentsPage.tsx',
  'pages/TrainingPage.tsx',
  'pages/documents.css',
  'pages/training.css',
  'components/DocumentList.tsx',
  'components/DropZone.tsx',
  'components/PacksPanel.tsx',
  'components/TrainingPlayer.tsx',
  'lib/training/slide-position.ts',
];

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const declared = (css: string): Set<string> =>
  new Set([...stripComments(css).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const LUMEN = declared(readFileSync(resolve(SRC, 'styles/lumen-tokens.css'), 'utf8'));
/** The frozen retired-token list (styles/retired-tokens.ts). */
const LEGACY_NAMES = RETIRED_TOKENS;
const LEGACY = RETIRED_TOKEN_RE;
const COLOR_LITERAL = COLOR_LITERAL_RE; // shared with styles/token-ratchet.test.ts (hex + every color function)
const ESCAPE_HATCH = /\bcssText\b|\binsertRule\b|dangerouslySetInnerHTML|\.innerHTML\b/;
const IFRAME = /<iframe\b[\s\S]*?\/>/g;
const PLAYER_FRAME_RULE = /\.app-player__frame\s*\{([^}]*)\}/;
const STYLE_OBJECT = /style=\{\{([\s\S]*?)\}\}/g;
const POSITIONAL = new Set(['position', 'top', 'left', 'right', 'bottom', 'height', 'width']);

function source(rel: string): string {
  return stripComments(readFileSync(resolve(SRC, rel), 'utf8'));
}

describe('Documents & Training token hygiene (phase 6)', () => {
  it('the retired token list is live (guards against a vacuous pass)', () => {
    expect(LEGACY_NAMES).toContain('--color-primary');
    expect(LEGACY.test('var(--color-bubble-system)')).toBe(true);
    expect([...source('components/DocumentList.tsx').matchAll(STYLE_OBJECT)].length).toBeGreaterThan(0);
  });

  it('the TrainingPlayer iframe is exactly one element, styled by the .app-player__frame class (no inline style)', () => {
    const player = source('components/TrainingPlayer.tsx');
    const frames = player.match(IFRAME) ?? [];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('className="app-player__frame"');
    expect(frames[0]).not.toMatch(/\bstyle=/);
    // The isolation attributes are untouched by the restyle.
    for (const attr of ['sandbox={TRAINING_FRAME_SANDBOX}', "src={location?.src ?? 'about:blank'}", 'onLoad={handleFrameLoad}', 'ref={frameRef}']) {
      expect(frames[0]).toContain(attr);
    }
    // Frame chrome comes from Lumen tokens (what the retired --color-secondary / --radius-sm /
    // --color-surface inline style mapped to; see styles/token-remap.ts).
    const rule = readFileSync(resolve(SRC, 'pages/training.css'), 'utf8').match(PLAYER_FRAME_RULE)?.[1] ?? '';
    expect(rule).toMatch(/border:\s*1px solid var\(--border-subtle\)/);
    expect(rule).toMatch(/border-radius:\s*var\(--r-control\)/);
    expect(rule).toMatch(/background-color:\s*var\(--bg-surface\)/);
  });

  for (const rel of FILES) {
    it(`${rel}: Lumen tokens only, no color literals, positional inline styles only`, () => {
      const text = source(rel);
      expect(text.match(LEGACY)?.[0]).toBeUndefined();
      expect(text.match(COLOR_LITERAL)?.[0]).toBeUndefined();
      expect(text.match(ESCAPE_HATCH)?.[0]).toBeUndefined();
      const missing = [...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]).filter((n) => !LUMEN.has(n));
      expect(missing).toEqual([]);
      if (rel.endsWith('.tsx')) {
        // No style={expression}: only literal objects, which are checked below.
        expect(text.match(/style=\{(?!\{)/)?.[0]).toBeUndefined();
        const keys = [...text.matchAll(STYLE_OBJECT)].flatMap((m) =>
          [...m[1].matchAll(/([A-Za-z]+)\s*:/g)].map((k) => k[1])
        );
        expect(keys.filter((k) => !POSITIONAL.has(k))).toEqual([]);
      }
    });
  }

  // Review PRR-210 (WCAG 2.4.3): a flex/grid `order` makes the visual order differ from the DOM
  // (tab) order. These surfaces keep the two identical, at every width.
  for (const rel of ['pages/documents.css', 'pages/training.css']) {
    it(`${rel}: no \`order\` declaration (visual order equals tab order)`, () => {
      expect(source(rel).match(/(?<![\w-])order\s*:/)?.[0]).toBeUndefined();
    });
  }
});
