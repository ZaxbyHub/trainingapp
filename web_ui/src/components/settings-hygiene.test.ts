/**
 * Phase-4 ratchet (docs/design/design-language.md sections 4 and 6): the Settings
 * page body migrated to Lumen uses ONLY Lumen tokens and classes. These files may
 * not reference a legacy token (--color-*, --spacing-*, ...), hold a color literal,
 * use a CSS-in-JS escape hatch, or carry inline `style` props. The single allowed
 * inline style is a progress fill's computed width (`style={{ width: ... }}`):
 * geometry from data, not a color or spacing value. Same rules as
 * layouts/shell-hygiene.test.ts (phase 3); src/ui/ is covered by
 * src/ui/ui-token-hygiene.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');
const SETTINGS_FILES = [
  'pages/SettingsPage.tsx',
  'components/ExternalModelSection.tsx',
  'components/SettingsControls.tsx',
  'components/SettingsMetrics.tsx',
  'components/ModelDownloadProgress.tsx',
  'components/settings.css',
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
/** The one allowed inline style: `style={{ width: `<template>` }}` (a computed fill width). */
const ALLOWED_STYLE = /style=\{\{\s*width:\s*`[^`]*`\s*\}\}/g;
const INLINE_STYLE = /\bstyle=\{/;

/** --settings-* properties a Settings component sets at runtime via style.setProperty. */
const PRIVATE = new Set(
  SETTINGS_FILES.filter((f) => f.endsWith('.tsx')).flatMap((f) =>
    [...readFileSync(resolve(SRC, f), 'utf8').matchAll(/setProperty\(\s*['"`](--settings-[\w-]+)/g)].map((m) => m[1]),
  ),
);

describe('Settings token hygiene (phase 4)', () => {
  it('the private-property allowance is derived from setProperty calls (not a blanket pass)', () => {
    expect([...PRIVATE]).toEqual(['--settings-nav-h']);
  });

  it('the legacy token list and the style rule are live (guards against a vacuous pass)', () => {
    expect(LEGACY_NAMES).toContain('--color-text-muted');
    expect(LEGACY_NAMES).toContain('--spacing-md');
    expect(LEGACY.test('var(--color-bubble-assistant)')).toBe(true);
    const sample = '<div style={{ width: `${pct}%` }} /><p style={{ color: "red" }} />';
    expect(INLINE_STYLE.test(sample.replace(ALLOWED_STYLE, ''))).toBe(true);
    expect(INLINE_STYLE.test('<div style={{ width: `${pct}%` }} />'.replace(ALLOWED_STYLE, ''))).toBe(false);
    expect(INLINE_STYLE.test('<div style={{ width: `${pct}%`, padding: 2 }} />'.replace(ALLOWED_STYLE, ''))).toBe(true);
  });

  for (const rel of SETTINGS_FILES) {
    it(`${rel}: Lumen tokens only, no color literals, no inline color/spacing styles`, () => {
      const text = stripComments(readFileSync(resolve(SRC, rel), 'utf8'));
      expect(text.match(LEGACY)?.[0]).toBeUndefined();
      expect(text.match(COLOR_LITERAL)?.[0]).toBeUndefined();
      expect(text.match(ESCAPE_HATCH)?.[0]).toBeUndefined();
      if (rel.endsWith('.tsx')) expect(text.replace(ALLOWED_STYLE, '').match(INLINE_STYLE)?.[0]).toBeUndefined();
      // Component-private runtime properties (--settings-*) are allowed when a Settings
      // component sets them itself (SettingsNav's measured --settings-nav-h).
      const missing = [...text.matchAll(/var\(\s*(--[\w-]+)/g)]
        .map((m) => m[1])
        .filter((n) => !LUMEN.has(n) && !PRIVATE.has(n));
      expect(missing).toEqual([]);
    });
  }
});
