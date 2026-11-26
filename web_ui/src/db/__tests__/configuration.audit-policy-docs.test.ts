// frozen-check C5 — #373 AC2 (executable docs-pin): CONFIGURATION.md's
// audit-policy block must list each remaining still-excluded main-only
// setting with its code pointer — honestly, per the issue's either/or: a
// main-only setting either gains a marker-carrying awaited-response emit
// path (then it is covered, not excluded) or it is NAMED in the shipped
// policy block as still-excluded WITH its code pointer.
//
// FROZEN SPEC — authored by the independent check author at base
// 54107572c092febc00beff17f719ff631a2215ac, before any implementation
// exists. The implementer must make this pass WITHOUT editing it; the
// canonical copy lives in the issue trace and is dropped into the repo
// byte-identical at web_ui/src/db/__tests__/configuration.audit-policy-docs.test.ts.
//
// RED at base, GREEN after the fix: at base the exclusion paragraph names
// "desktop API-key custody, update feedUrl edits" WITHOUT code pointers, so
// the feedUrl pin and (absent the emit arm) the API-key pin fail.
//
// Pin shape (declared honestly, no tautology attempted):
//   - UNCONDITIONAL: the update feedUrl setting — it has NO renderer-
//     reachable write at all (only the value-preserving copy at
//     desktop/main/index.ts:610-614, saveUpdatesState's feedUrl branch), so
//     the only truthful terminal state is the exclusion line carrying its
//     desktop/main/index.ts code pointer. No executable check in this bundle
//     gives feedUrl an emit path, so no disjunction is offered.
//   - DISJUNCTIVE: the desktop external-model API-key custody — EITHER the
//     exclusion names it with a code pointer (secret-store.ts /
//     desktop/main/security/... / the PUT /settings backend surface), OR the
//     block's roster/coverage prose (outside the Excluded paragraph) claims
//     desktop API-key custody coverage (the marker-carrying awaited-response
//     arm of the issue). BOUND, disclosed: a docs pin cannot EXECUTE the
//     emitted-row test for the coverage arm; it pins that the block makes a
//     specific, desktop-scoped coverage claim instead of staying silent —
//     the emitted-row side of that arm is enforced by the implementer's own
//     real-producer spec, per this repo's frozen-check convention.
//
// Convention note: same docs-pin convention as check C3 (the build-docs
// precedent, web_ui/src/lib/models/build-docs.test.ts) — a
// `@vitest-environment node` web_ui vitest spec reading the repo-root doc.
//
// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(HERE, '..', '..', '..');
const ROOT = resolve(WEB_UI, '..');

const BLOCK_START = '## Local audit log';
/** Matches "API-key" / "API key" / "api-key" — deliberately NOT "apiKey" (the browser-runtime roster row `external.apiKey` must never satisfy this pin). */
const API_KEY_RE = /API[\s-]key/i;
/** How much surrounding text a code pointer may sit in (same item/sentence neighborhood). */
const WINDOW = 400;

/** The audit-policy block: from its H2 heading to the next H2 heading. */
function auditPolicyBlock(): { block: string; excludedText: string } {
  const config = readFileSync(join(ROOT, 'CONFIGURATION.md'), 'utf8');
  const startIdx = config.indexOf(BLOCK_START);
  expect(startIdx, 'CONFIGURATION.md must keep the "Local audit log" policy block this check pins').toBeGreaterThan(-1);
  const endIdx = config.indexOf('\n## ', startIdx + BLOCK_START.length);
  const block = endIdx === -1 ? config.slice(startIdx) : config.slice(startIdx, endIdx);
  const excludedIdx = block.indexOf('**Excluded');
  expect(excludedIdx, 'the audit-policy block must keep its Excluded (intentional, disclosed) paragraph').toBeGreaterThan(-1);
  return { block, excludedText: block.slice(excludedIdx) };
}

/** The text within +/- WINDOW chars of the first match of re in hay. */
function windowAround(hay: string, re: RegExp): string | undefined {
  const match = re.exec(hay);
  if (match === null || match.index === undefined) return undefined;
  return hay.slice(Math.max(0, match.index - WINDOW), match.index + WINDOW);
}

describe('CONFIGURATION.md audit-policy block names each remaining main-only exclusion with its code pointer (issue #373 AC2)', () => {
  test('the update feedUrl exclusion names its code pointer at desktop/main/index.ts (unconditional: no renderer-reachable write exists)', () => {
    const { excludedText } = auditPolicyBlock();
    const feedWindow = windowAround(excludedText, /feedUrl/i);
    expect(feedWindow, 'the Excluded paragraph must still name the update feedUrl setting (no emit path exists for it)').toBeDefined();
    expect(
      feedWindow,
      'the feedUrl exclusion must carry its code pointer: the desktop/main/index.ts saveUpdatesState region (the value-preserving feedUrl copy) — the only place the setting persists',
    ).toMatch(/desktop\/main\/index\.ts/);
  });

  test('desktop API-key custody: EITHER excluded with a code pointer OR claimed as covered in the roster/coverage prose (never silent)', () => {
    const { block, excludedText } = auditPolicyBlock();
    // Arm A: excluded WITH a code pointer to the custody surface.
    const excludedWindow = windowAround(excludedText, API_KEY_RE);
    const armA = excludedWindow !== undefined && /secret-store\.ts|desktop\/main\/security|desktop\/main\/backend\/server\.ts/.test(excludedWindow);
    // Arm B: a DESKTOP-scoped coverage claim outside the Excluded paragraph
    // (the marker-carrying awaited-response arm). The desktop qualifier is
    // required so the browser-runtime `external.apiKey` roster row can never
    // satisfy this arm.
    const coveredWindow = windowAround(block.slice(0, block.length - excludedText.length), API_KEY_RE);
    const armB = coveredWindow !== undefined && /desktop/i.test(coveredWindow);
    expect(
      armA || armB,
      [
        'the audit-policy block must make a specific claim about desktop API-key custody:',
        'either the Excluded paragraph names it WITH a code pointer (secret-store.ts / desktop/main/security / the PUT /settings backend surface),',
        'or the roster/coverage prose (outside Excluded) claims desktop custody coverage — silence or a pointer-less exclusion fails this pin',
      ].join(' '),
    ).toBe(true);
  });
});
