// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// PR #391 F-006: this file is deliberately NOT the frozen C3 pin
// (configuration.delete-epoch-docs.test.ts). The frozen pin only requires a
// single line containing a delete token and an epoch token, so a contradictory
// disclosure stays green. This strict semantics oracle rejects negation and
// requires the documented causal pair: delete advances the epoch AND stale
// pending saves are aborted. It runs over the shipped document, so rewording it
// into a contradiction turns this test red without editing the frozen artifact.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..');
const CONFIGURATION = readFileSync(resolve(ROOT, 'CONFIGURATION.md'), 'utf8');

function disclosesDeleteEpoch(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ');
  const NEGATOR = String.raw`(?:does not|doesn't|do not|don't|is not|isn't|are not|aren't|was not|wasn't|were not|weren't|won't|can't|cannot|never|without|not)`;
  const activeAdvance = /\bdelet\w*[^.]{0,160}\b(?:advances?|increments?|bumps?)\b[^.]{0,80}\bepoch\b/i.test(normalized);
  const negatedAdvance = new RegExp(String.raw`\b${NEGATOR}\s+(?:\w+\s+){0,3}(?:advance|increment|bump)\w*`, 'i').test(normalized);
  const staleAborted =
    /\b(?:pending|stale)\b[^.]{0,120}\b(?:saves?|writes?|updates?)\b[^.]{0,120}\b(?:abort|reject|refus)\w*/i.test(normalized) ||
    /\b(?:abort|reject|refus)\w*[^.]{0,120}\b(?:pending|stale)\b[^.]{0,120}\b(?:saves?|writes?|updates?)\b/i.test(normalized);
  const negatedAbort = new RegExp(String.raw`\b${NEGATOR}\s+(?:\w+\s+){0,3}(?:abort|reject|refus)\w*`, 'i').test(normalized);
  return activeAdvance && !negatedAdvance && staleAborted && !negatedAbort;
}

describe('delete-epoch documentation semantics (non-frozen strict oracle)', () => {
  test('the shipped disclosure states the advance and stale-save abort as a causal pair', () => {
    expect(disclosesDeleteEpoch(CONFIGURATION)).toBe(true);
  });

  test('a negated advance is rejected', () => {
    const contradictory =
      'Deleting a conversation does not advance the conversation epoch. Pending saves are applied normally.';
    expect(disclosesDeleteEpoch(contradictory)).toBe(false);
  });

  test('an unrelated delete/epoch mention with preserved saves is rejected', () => {
    const contradictory =
      'Conversations can be deleted; the epoch is unrelated. Pending saves are kept for later.';
    expect(disclosesDeleteEpoch(contradictory)).toBe(false);
  });

  test('a negated stale-save abort is rejected even when the advance is stated', () => {
    const contradictory =
      'Deleting a conversation advances the conversation epoch. Pending saves are not aborted.';
    expect(disclosesDeleteEpoch(contradictory)).toBe(false);
  });

  test('a contracted negated abort (aren\'t) is rejected', () => {
    const contradictory =
      "Deleting a conversation advances the conversation epoch. Pending saves aren't aborted.";
    expect(disclosesDeleteEpoch(contradictory)).toBe(false);
  });
});
