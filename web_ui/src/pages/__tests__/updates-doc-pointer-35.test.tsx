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
 * its family-blind ratchet (dead-doc-references-35.test.tsx) cannot see.
 *
 * Method: reads the SettingsPage SOURCE via readFileSync — the component is
 * NOT imported (importing pages pulls native ESM deps like edgevec and fails
 * at collection). Comment-aware: the same block+line comment state machine
 * as the class scanner (web_ui/src/components/dead-doc-scanner.test.ts) —
 * only code/text segments count as user-visible; developer comments may
 * legitimately cite repo-tree docs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The unshipped repo document this check pins out of user-visible copy. */
const UPDATES_DOC_RE = /\bdocs\/updates\.md\b/g;

/** Block+line comment state machine (canonical implementation and self-tests
 *  live in dead-doc-scanner.test.ts). For each line, returns the [start, end)
 *  spans classified as CODE — everything outside // line comments and
 *  block comments; block state carries across lines. */
function visibleLineSpans(text: string): Array<Array<[number, number]>> {
  const lines = text.split('\n');
  const spansPerLine: Array<Array<[number, number]>> = [];
  let inBlock = false;
  for (const line of lines) {
    const spans: Array<[number, number]> = [];
    let open = 0;
    let codeOpen = true;
    let i = 0;
    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) {
        spansPerLine.push([]);
        continue;
      }
      inBlock = false;
      i = close + 2;
      open = i;
    }
    while (i < line.length) {
      const lineC = line.indexOf('//', i);
      const blockC = line.indexOf('/*', i);
      if (lineC === -1 && blockC === -1) break;
      if (blockC !== -1 && (lineC === -1 || blockC < lineC)) {
        if (blockC > open) spans.push([open, blockC]);
        const close = line.indexOf('*/', blockC + 2);
        if (close === -1) {
          inBlock = true;
          codeOpen = false;
          i = line.length;
        } else {
          i = close + 2;
          open = i;
        }
      } else {
        if (lineC > open) spans.push([open, lineC]);
        codeOpen = false;
        i = line.length;
      }
    }
    if (codeOpen && open < line.length) spans.push([open, line.length]);
    spansPerLine.push(spans);
  }
  return spansPerLine;
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
    const spansPerLine = visibleLineSpans(src);

    const offenders: string[] = [];
    spansPerLine.forEach((spans, idx) => {
      const lineText = lines[idx] ?? '';
      for (const [start, end] of spans) {
        const segment = lineText.slice(start, end);
        UPDATES_DOC_RE.lastIndex = 0;
        const match = segment.match(UPDATES_DOC_RE);
        if (match) {
          offenders.push(
            `web_ui/src/pages/SettingsPage.tsx:${idx + 1} ${match[0]} :: ${lineText.trim()}`,
          );
        }
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
