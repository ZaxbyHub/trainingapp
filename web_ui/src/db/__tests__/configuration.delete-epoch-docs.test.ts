// frozen-check C3 — #372 AC3 (executable docs-pin): the delete-epoch
// semantics are disclosed in the user-facing configuration documentation —
// CONFIGURATION.md's chat-history encryption section must state that a
// conversation delete advances the conversation epoch and that the advance
// aborts other tabs' pending saves.
//
// FROZEN SPEC — authored by the independent check author at base
// 54107572c092febc00beff17f719ff631a2215ac, before any implementation
// exists. The implementer must make this pass WITHOUT editing it; the
// canonical copy lives in the issue trace and is dropped into the repo
// byte-identical at web_ui/src/db/__tests__/configuration.delete-epoch-docs.test.ts.
//
// RED at base, GREEN after the fix: at base the encryption section carries
// no delete/epoch disclosure, so both pins below fail.
//
// Convention note (why web_ui vitest, not tests/test_doc_accuracy.py): the
// repo's executable docs-pin precedent for frozen acceptance checks is
// web_ui/src/lib/models/build-docs.test.ts (issue #272 AC5 / frozen check
// C10) — a `@vitest-environment node` spec that reads the repo-root doc from
// disk and asserts its content, running in the same `npm --prefix web_ui
// test` / `npx vitest run` lane that already runs every web_ui spec in CI
// and locally. The python doc-accuracy suite is a stale-token scan, not a
// positive-content pin, and lives in a separate pytest lane; this check pins
// POSITIVE disclosure content, so it follows the build-docs convention.
//
// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(HERE, '..', '..', '..');
const ROOT = resolve(WEB_UI, '..');

const SECTION_START = '### Chat history encryption (browser app)';
const SECTION_END = '### Browser app: Knowledge Packs and course player';

/** The encryption section's current text (read fresh from the repo root). */
function encryptionSection(): string {
  const config = readFileSync(join(ROOT, 'CONFIGURATION.md'), 'utf8');
  const startIdx = config.indexOf(SECTION_START);
  const endIdx = config.indexOf(SECTION_END);
  expect(
    startIdx,
    'CONFIGURATION.md must keep the "Chat history encryption (browser app)" section this check pins',
  ).toBeGreaterThan(-1);
  expect(endIdx, 'the heading after the encryption section must remain findable').toBeGreaterThan(startIdx);
  return config.slice(startIdx, endIdx);
}

describe('CONFIGURATION.md discloses the delete-epoch semantics (issue #372 AC3)', () => {
  test('the encryption section states that deleting a conversation advances the conversation epoch', () => {
    const line = encryptionSection()
      .split('\n')
      .find((l) => /delet/i.test(l) && /epoch/i.test(l));
    expect(
      line,
      'one line of the encryption section must tie DELETE to the EPOCH (a delete advances the stored conversation epoch)',
    ).toBeDefined();
  });

  test('the encryption section states that the delete-driven epoch advance aborts other tabs pending saves', () => {
    const line = encryptionSection()
      .split('\n')
      .find(
        (l) =>
          /(pending sav|abort|no-op|discard|stale)/i.test(l) &&
          /(other tab|another tab|second tab|every tab|colleague)/i.test(l),
      );
    expect(
      line,
      'one line of the encryption section must disclose the app-wide side effect: other tabs pending saves are aborted (stale-epoch no-ops)',
    ).toBeDefined();
  });
});
