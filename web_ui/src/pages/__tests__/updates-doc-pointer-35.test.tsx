/**
 * updates-doc-pointer (#260 AC1) — frozen acceptance check, authored at
 * arm's length from the fix: WHEN the Settings Updates section renders, the
 * system SHALL NOT surface a docs/updates.md reference in user-visible copy.
 *
 * Why: docs/updates.md is a developer-facing repo document that installed
 * builds do not ship (desktop/installer-resources/docs/ stages licenses
 * only), so a rendered pointer is dead for installed users. Same defect
 * class as #35 C10; PR #259's sweep reworded the PACKAGING-family sites but
 * left two live instances in SettingsPage (base: lines 277 and 307), which
 * its family-blind ratchet (dead-doc-references-35.test.tsx) could not see.
 *
 * Method: reads the SettingsPage SOURCE via readFileSync — the component is
 * NOT imported (importing pages pulls native ESM deps like edgevec and fails
 * at collection). Comment-aware via the same block+line comment classifier
 * as the class scanner (web_ui/src/components/dead-doc-scanner.test.ts):
 * comment interiors are blanked, while string and template literals — user-
 * visible copy — stay scannable, and their //, /* and escapes cannot start
 * comments. Only non-comment text counts as user-visible; developer
 * comments may legitimately cite repo-tree docs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The unshipped repo document this check pins out of user-visible copy. */
const UPDATES_DOC_RE = /\bdocs\/updates\.md\b/g;

/** Index of the closing quote for a string starting at `open`, honoring
 *  backslash escapes; -1 when the line ends first (unterminated). */
function findStringEnd(line: string, open: number, quote: string): number {
  for (let i = open + 1; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === quote) return i;
  }
  return -1;
}

/** Per line, the line with COMMENT interiors blanked to spaces
 *  (offset-preserving): // line comments and block comments are replaced,
 *  while code, string literals and template literals stay scannable. A '//'
 *  that is the tail of a '://' URL scheme is not a comment start. Mirrors
 *  visibleText in dead-doc-scanner.test.ts (the canonical classifier; the
 *  two copies are diff-pinned by the scanner's self-tests and kept
 *  byte-identical by review convention). */
function visibleLines(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let inBlock = false;
  let inTemplate = false;
  for (const line of lines) {
    const chars = line.split('');
    const blank = (from: number, to: number) => {
      for (let k = from; k < to; k++) chars[k] = ' ';
    };
    let i = 0;
    if (inBlock) {
      const close = line.indexOf('*/', i);
      if (close === -1) {
        out.push(' '.repeat(line.length));
        continue;
      }
      blank(i, close + 2);
      inBlock = false;
      i = close + 2;
    }
    if (inTemplate) {
      const close = findStringEnd(line, i, '`');
      if (close === -1) {
        out.push(line);
        continue;
      }
      inTemplate = false;
      i = close + 1;
    }
    while (i < line.length) {
      const ch = line[i];
      if (ch === "'" || ch === '"') {
        const close = findStringEnd(line, i, ch);
        if (close === -1) break;
        i = close + 1;
        continue;
      }
      if (ch === '`') {
        const close = findStringEnd(line, i, '`');
        if (close === -1) {
          inTemplate = true;
          break;
        }
        i = close + 1;
        continue;
      }
      if (ch === '/' && line[i + 1] === '*') {
        const close = line.indexOf('*/', i + 2);
        if (close === -1) {
          blank(i, line.length);
          inBlock = true;
          break;
        }
        blank(i, close + 2);
        i = close + 2;
        continue;
      }
      if (ch === '/' && line[i + 1] === '/') {
        if (i > 0 && line[i - 1] === ':') {
          i += 2;
          continue;
        }
        blank(i, line.length);
        break;
      }
      i++;
    }
    out.push(chars.join(''));
  }
  return out;
}

describe('updates doc pointer (#260 AC1)', () => {
  it('settings updates copy names no unshipped runbook pointer', () => {
    const settingsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'SettingsPage.tsx',
    );
    const src = readFileSync(settingsPath, 'utf8');
    const lines = src.split('\n');
    const visible = visibleLines(src);

    const offenders: string[] = [];
    visible.forEach((lineText, idx) => {
      UPDATES_DOC_RE.lastIndex = 0;
      const match = lineText.match(UPDATES_DOC_RE);
      if (match) {
        offenders.push(
          `web_ui/src/pages/SettingsPage.tsx:${idx + 1} ${match[0]} :: ${lines[idx]?.trim() ?? ''}`,
        );
      }
    });

    expect(
      offenders,
      [
        'SettingsPage user-visible copy still references the unshipped docs/updates.md:',
        ...offenders,
        '(docs/updates.md does not ship in installed builds — desktop/installer-resources/docs/ stages licenses only;',
        'reword each pointer to a self-contained affordance per the #35 C10 class fix.)',
      ].join('\n'),
    ).toEqual([]);
  });
});
