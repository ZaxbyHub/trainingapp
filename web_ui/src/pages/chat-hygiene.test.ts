/**
 * Phase-5 ratchet (docs/design/design-language.md sections 4 and 6): the Chat
 * surface migrated to Lumen uses ONLY Lumen tokens and classes. These files may
 * not reference a legacy token (--color-*, --spacing-*, ...), hold a color
 * literal, use a CSS-in-JS escape hatch, or carry inline `style` props (inline
 * styles cannot express hover/focus-visible and bypass the token tests).
 * Measured geometry written through the CSSOM (the composer's auto-resize
 * height) is not a `style=` prop and stays allowed. Mirrors
 * layouts/shell-hygiene.test.ts (phase 3).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');
const CHAT_FILES = [
  'pages/ChatPage.tsx',
  'pages/chat.css',
  'components/ChatInput.tsx',
  'components/ChatMessageList.tsx',
  'components/ChatMessageBubble.tsx',
  'components/SourceCitation.tsx',
  'components/LearnPanel.tsx',
  'components/GroundingBadge.tsx',
  'components/InferenceModeToggle.tsx',
  'components/StreamingIndicator.tsx',
  'components/MarkdownRenderer.tsx',
  'components/ModelChip.tsx',
  'components/PinnedSlideContext.tsx',
  'components/IsolationBanner.tsx',
  'lib/chat/model-chip.ts',
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
/** jsdom's selector engine throws on :has() during getComputedStyle (it broke the
 *  SourceCitation suite once); keep it out of chat.css. */
const HAS_SELECTOR = /:has\(/;

describe('chat surface token hygiene (phase 5)', () => {
  it('the legacy token list is derived (guards against a vacuous pass)', () => {
    expect(LEGACY_NAMES).toContain('--color-primary');
    expect(LEGACY_NAMES).toContain('--color-bubble-system');
    expect(LEGACY.test('var(--color-text-muted)')).toBe(true);
    expect(INLINE_STYLE.test('<div style={{ color: "red" }} />')).toBe(true);
  });

  for (const rel of CHAT_FILES) {
    it(`${rel}: Lumen tokens only, no color literals, no inline styles`, () => {
      const text = stripComments(readFileSync(resolve(SRC, rel), 'utf8'));
      expect(text.match(LEGACY)?.[0]).toBeUndefined();
      expect(text.match(COLOR_LITERAL)?.[0]).toBeUndefined();
      expect(text.match(ESCAPE_HATCH)?.[0]).toBeUndefined();
      if (rel.endsWith('.tsx')) expect(text.match(INLINE_STYLE)?.[0]).toBeUndefined();
      if (rel.endsWith('.css')) expect(text.match(HAS_SELECTOR)?.[0]).toBeUndefined();
      const missing = [...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]).filter((n) => !LUMEN.has(n));
      expect(missing).toEqual([]);
    });
  }
});
