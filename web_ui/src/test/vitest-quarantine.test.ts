/**
 * Vitest quarantine honesty pin (issue #271 AC5).
 *
 * Reads web_ui/vitest.config.ts, docx-extractor.test.ts and
 * xlsx-extractor.test.ts as text and asserts:
 *  1. none of the four un-quarantined specs (docx/xlsx/pptx extractor,
 *     webgpu-watchdog) are listed in the config's exclude region;
 *  2. every remaining src/ exclusion carries a live `#N` owner annotation —
 *     a number from QUARANTINE_OWNERS (issue #348), never one of the closed
 *     #20-#26 owners and never this issue's own number — per the AC5
 *     association rule: a comment block applies to every entry below it until
 *     the next comment block starts, and a trailing inline comment on an
 *     entry overrides it;
 *  3. the two rewritten extractor specs show a value (non-`import type`)
 *     import of the real extractor and zero `vi.mock` of the extractor module.
 *
 * Controls 4 runs the SAME validator over synthetic texts: ownerless fails,
 * fully-owned passes, inline-override associates the inline owner.
 *
 * @vitest-environment node
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const CONFIG_PATH = join(ROOT, 'vitest.config.ts');
const DOCX_SPEC_PATH = join(ROOT, 'src', 'lib', 'processing', 'docx-extractor.test.ts');
const XLSX_SPEC_PATH = join(ROOT, 'src', 'lib', 'processing', 'xlsx-extractor.test.ts');

/** Live follow-up owner(s) of the remaining quarantined specs. */
const QUARANTINE_OWNERS: readonly number[] = [348];
/** Owner ids that are closed work items and must never reappear. */
const FORBIDDEN_OWNERS = /#2[0-6]\b/;
/** This issue's own number is not a live owner for the quarantine. */
const SELF_NUMBER = 271;

const UN_QUARANTINED_SPECS = [
  'src/lib/processing/docx-extractor.test.ts',
  'src/lib/processing/xlsx-extractor.test.ts',
  'src/lib/processing/pptx-extractor.test.ts',
  'src/lib/llm/webgpu-watchdog.test.ts',
];

interface QuarantineEntry {
  path: string;
  owners: number[];
  line: number;
}

/**
 * Parse the config's exclude region into entries with associated owners per
 * the AC5 rule. A "comment block" is a run of consecutive `//`-prefixed
 * source lines; an entry is a quoted 'src/...' string line; a trailing
 * inline comment (code before //) overrides the block owner for that entry.
 */
export function parseQuarantine(configText: string): QuarantineEntry[] {
  const entries: QuarantineEntry[] = [];
  const lines = configText.split('\n');
  let blockOwners: number[] = [];
  let sawEntrySinceBlock = false;
  let inExclude = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === 'exclude: [') {
      inExclude = true;
      blockOwners = [];
      continue;
    }
    if (!inExclude) continue;
    if (trimmed === '],' || trimmed === ']') {
      inExclude = false;
      continue;
    }

    const codeCommentSplit = raw.indexOf('//');
    const code = codeCommentSplit >= 0 ? raw.slice(0, codeCommentSplit) : raw;
    const comment = codeCommentSplit >= 0 ? raw.slice(codeCommentSplit + 2) : '';

    if (code.trim() === '' && comment.trim() !== '') {
      // Pure comment line: part of the current comment block — but a comment
      // line that FOLLOWS an entry starts a NEW block (the previous block's
      // association ended at the last entry it applied to). Issue #271 AC5.
      if (sawEntrySinceBlock) {
        blockOwners = [];
      }
      blockOwners = blockOwners.concat(comment.match(/#(\d+)\b/g)?.map((t) => Number(t.slice(1))) ?? []);
      sawEntrySinceBlock = false;
      continue;
    }

    const entryMatch = code.match(/'(src\/[^']+)'/);
    if (entryMatch) {
      const inlineOwners = comment.match(/#(\d+)\b/g)?.map((t) => Number(t.slice(1))) ?? [];
      entries.push({
        path: entryMatch[1],
        owners: inlineOwners.length > 0 ? inlineOwners : [...blockOwners],
        line: i + 1,
      });
      sawEntrySinceBlock = true;
      continue;
    }

    // A plain code line (glob entry, boilerplate) starts a NEW block context.
    if (code.trim() !== '') {
      blockOwners = [];
      sawEntrySinceBlock = false;
    }
  }
  return entries;
}

export function validateQuarantine(
  entries: QuarantineEntry[],
  allowedOwners: readonly number[],
  forbidden: RegExp,
  selfNumber: number,
): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (UN_QUARANTINED_SPECS.includes(entry.path)) {
      problems.push(`${entry.path}: un-quarantined spec is still listed`);
    }
    const live = entry.owners.filter((n) => allowedOwners.includes(n));
    if (live.length === 0) {
      problems.push(`${entry.path}: no live owner (owners: ${entry.owners.join(',') || 'none'})`);
    }
    if (entry.owners.some((n) => n === selfNumber)) {
      problems.push(`${entry.path}: cites this issue's own number`);
    }
    const rawOwners = entry.owners;
    if (forbidden.test(rawOwners.map((n) => `#${n}`).join(' '))) {
      problems.push(`${entry.path}: cites a closed #20-#26 owner`);
    }
  }
  return problems;
}

describe('vitest quarantine honesty (issue #271 AC5)', () => {
  const configText = readFileSync(CONFIG_PATH, 'utf-8');

  test('none of the four un-quarantined specs appear in the exclude region', () => {
    for (const spec of UN_QUARANTINED_SPECS) {
      const excludeRegion = configText.slice(configText.indexOf('exclude: ['), configText.indexOf('],', configText.indexOf('exclude: [')));
      expect(excludeRegion).not.toContain(spec);
    }
  });

  test('every remaining src/ exclusion carries a live #N owner (validator on the real config)', () => {
    const entries = parseQuarantine(configText).filter((e) => e.path.startsWith('src/'));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const problems = validateQuarantine(entries, QUARANTINE_OWNERS, FORBIDDEN_OWNERS, SELF_NUMBER);
    expect(problems).toEqual([]);
  });

  test('rewritten extractor specs value-import the real extractor and never mock it', () => {
    for (const [path, symbol] of [
      [DOCX_SPEC_PATH, 'extractDocxText'],
      [XLSX_SPEC_PATH, 'extractXlsxText'],
    ] as const) {
      const text = readFileSync(path, 'utf-8');
      const valueImports = text.split('\n').filter(
        (l) => l.startsWith('import {') && l.includes(symbol),
      );
      expect(valueImports.length, `value import of ${symbol} in ${path}`).toBeGreaterThanOrEqual(1);
      // Match the real module specifier (case-sensitive, optional factory
      // argument). The symbol-derived form was wrong ('DocxText-extractor').
      const mod = symbol === 'extractDocxText' ? 'docx-extractor' : 'xlsx-extractor';
      expect(text).not.toMatch(new RegExp(`vi\\.mock\\(\\s*['"]\\./${mod}['"]`));
    }
  });

  test('controls: the validator rejects an ownerless entry and accepts a fully-owned one', () => {
    const owned = `exclude: [
      // Owned by issue #348 (pre-existing drift).
      'src/pages/SomePage.test.tsx',
    ],`;
    const ownerless = `exclude: [
      'src/pages/OtherPage.test.tsx',
    ],`;
    const inlineOverride = `exclude: [
      // Owned by issue #348.
      'src/pages/InlinePage.test.tsx', // owned by issue #348 (drift)
    ],`;

    const ownedEntries = parseQuarantine(owned).filter((e) => e.path.startsWith('src/'));
    expect(validateQuarantine(ownedEntries, QUARANTINE_OWNERS, FORBIDDEN_OWNERS, SELF_NUMBER)).toEqual([]);

    const ownerlessEntries = parseQuarantine(ownerless).filter((e) => e.path.startsWith('src/'));
    const ownerlessProblems = validateQuarantine(ownerlessEntries, QUARANTINE_OWNERS, FORBIDDEN_OWNERS, SELF_NUMBER);
    expect(ownerlessProblems.some((p) => p.includes('no live owner'))).toBe(true);

    const inlineEntries = parseQuarantine(inlineOverride).filter((e) => e.path.startsWith('src/'));
    expect(inlineEntries[0].owners).toEqual([348]);

    // Block-boundary regression (final-critic counterexample): an entry under
    // a NEW comment block that carries no owner must NOT inherit the previous
    // block's owner.
    const newBlock = `exclude: [
      // Owned by issue #348.
      'src/pages/Owned.test.tsx',
      // New block: deliberately no owner.
      'src/pages/Ownerless.test.tsx',
    ],`;
    const newBlockEntries = parseQuarantine(newBlock).filter((e) => e.path.startsWith('src/'));
    expect(newBlockEntries[0].owners).toEqual([348]);
    expect(newBlockEntries[1].owners).toEqual([]);
    const newBlockProblems = validateQuarantine(newBlockEntries, QUARANTINE_OWNERS, FORBIDDEN_OWNERS, SELF_NUMBER);
    expect(newBlockProblems.some((p) => p.includes('src/pages/Ownerless.test.tsx') && p.includes('no live owner'))).toBe(true);
  });

  test('controls: a closed #20-#26 owner and a self-citation are both rejected', () => {
    const closedOwner = `exclude: [
      // Owned by chat engine PR #21.
      'src/pages/LegacyPage.test.tsx',
    ],`;
    const selfCite = `exclude: [
      // Owned by issue #271.
      'src/pages/SelfPage.test.tsx',
    ],`;
    const closedProblems = validateQuarantine(
      parseQuarantine(closedOwner).filter((e) => e.path.startsWith('src/')),
      QUARANTINE_OWNERS, FORBIDDEN_OWNERS, SELF_NUMBER,
    );
    expect(closedProblems.length).toBeGreaterThan(0);
    const selfProblems = validateQuarantine(
      parseQuarantine(selfCite).filter((e) => e.path.startsWith('src/')),
      QUARANTINE_OWNERS, FORBIDDEN_OWNERS, SELF_NUMBER,
    );
    expect(selfProblems.some((p) => p.includes('own number'))).toBe(true);
  });
});
