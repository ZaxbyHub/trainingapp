/**
 * Phase-3 ratchet (docs/design/design-language.md sections 4 and 6): the app
 * shell migrated to Lumen uses ONLY Lumen tokens and classes. The shell files
 * below may not reference a legacy token (--color-*, --spacing-*, ...), hold a
 * color literal, use a CSS-in-JS escape hatch, or carry inline `style` props
 * (inline styles cannot express hover/focus-visible and bypass the token
 * tests). src/ui/ is covered by src/ui/ui-token-hygiene.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');
const SHELL_FILES = [
  'layouts/AppLayout.tsx',
  'layouts/shell.css',
  'components/Sidebar.tsx',
  'components/SidebarConversationItem.tsx',
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
const INLINE_STYLE = /\bstyle=\{/;

describe('app shell token hygiene (phase 3)', () => {
  it('the legacy token list is derived (guards against a vacuous pass)', () => {
    expect(LEGACY_NAMES).toContain('--color-primary');
    expect(LEGACY_NAMES).toContain('--spacing-md');
    expect(LEGACY.test('var(--color-bubble-assistant)')).toBe(true);
    expect(INLINE_STYLE.test('<div style={{ color: "red" }} />')).toBe(true);
  });

  for (const rel of SHELL_FILES) {
    it(`${rel}: Lumen tokens only, no color literals, no inline styles`, () => {
      const text = stripComments(readFileSync(resolve(SRC, rel), 'utf8'));
      expect(text.match(LEGACY)?.[0]).toBeUndefined();
      expect(text.match(COLOR_LITERAL)?.[0]).toBeUndefined();
      expect(text.match(ESCAPE_HATCH)?.[0]).toBeUndefined();
      if (rel.endsWith('.tsx')) expect(text.match(INLINE_STYLE)?.[0]).toBeUndefined();
      const missing = [...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]).filter((n) => !LUMEN.has(n));
      expect(missing).toEqual([]);
    });
  }
});
