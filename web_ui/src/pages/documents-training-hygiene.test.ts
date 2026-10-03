/**
 * Phase-6 ratchet (docs/design/design-language.md sections 4 and 6): the
 * Documents and Training surfaces migrated to Lumen use ONLY Lumen tokens. The
 * files below may not reference a legacy token (--color-*, --spacing-*, ...),
 * hold a color literal, or use a CSS-in-JS escape hatch, and their inline
 * `style` props may carry only POSITIONAL properties (DocumentList's
 * virtualization computes row offsets and the scroll height per render).
 *
 * One deliberate exception: the TrainingPlayer <iframe> element is excluded and
 * must stay exactly one element. It is the security-critical isolation surface
 * (sandbox, src computation) and is left byte-identical, including its legacy
 * inline style, rather than restyled.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
const LEGACY_NAMES = [...declared(readFileSync(resolve(SRC, 'styles/tokens.css'), 'utf8'))].filter((n) => !LUMEN.has(n));
const LEGACY = new RegExp(`(${LEGACY_NAMES.join('|')})(?![\\w-])`);
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const ESCAPE_HATCH = /\bcssText\b|\binsertRule\b|dangerouslySetInnerHTML|\.innerHTML\b/;
const IFRAME = /<iframe\b[\s\S]*?\/>/g;
const STYLE_OBJECT = /style=\{\{([\s\S]*?)\}\}/g;
const POSITIONAL = new Set(['position', 'top', 'left', 'right', 'bottom', 'height', 'width']);

function source(rel: string): string {
  return stripComments(readFileSync(resolve(SRC, rel), 'utf8')).replace(IFRAME, '');
}

describe('Documents & Training token hygiene (phase 6)', () => {
  it('the legacy token list is derived and the iframe exclusion is exact (guards against a vacuous pass)', () => {
    expect(LEGACY_NAMES).toContain('--color-primary');
    expect(LEGACY.test('var(--color-bubble-system)')).toBe(true);
    const player = stripComments(readFileSync(resolve(SRC, 'components/TrainingPlayer.tsx'), 'utf8'));
    expect(player.match(IFRAME)).toHaveLength(1);
    expect([...source('components/DocumentList.tsx').matchAll(STYLE_OBJECT)].length).toBeGreaterThan(0);
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
});
