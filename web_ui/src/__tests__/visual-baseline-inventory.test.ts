// visual-baseline-inventory.test.ts — issue #256 AC2: the committed win32
// baseline set must be exactly the matrix the pixel spec names — 11 states ×
// light/dark × 1440/1024/768/500 = 88 PNGs, none missing and none extra — so
// a partial regeneration (a dropped or orphaned PNG) fails locally instead
// of only on the runner. Each pinned state id is cross-checked against the
// pixel spec's source, so a renamed or removed state fails here too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const VISUAL_DIR = path.join(THIS_DIR, '..', '..', 'e2e', 'visual');
const SPEC_PATH = path.join(VISUAL_DIR, 'lumen-baseline.spec.ts');
const BASELINE_DIR = path.join(VISUAL_DIR, '__screenshots__', 'win32');

// The 11 captured states of lumen-baseline.spec.ts (STATES array + the
// overlay/crash/boot-screen describes). Keep in sync with that spec — the
// first test fails if this list drifts from the spec's source.
const STATES = [
  'boot-screen-error',
  'boot-screen-loading',
  'chat-empty',
  'chat-populated',
  'crash-page',
  'documents-empty',
  'documents-populated',
  'overlay-model-not-ready',
  'settings',
  'settings-external',
  'training-empty',
] as const;
const THEMES = ['dark', 'light'] as const;
const WIDTHS = [1440, 1024, 768, 500] as const;

describe('committed win32 visual baseline inventory (issue #256 AC2)', () => {
  const specSource = fs.readFileSync(SPEC_PATH, 'utf8');

  it('every pinned state id still exists in the pixel spec source', () => {
    for (const state of STATES) {
      // The STATES-array entries use `id: '<state>'`; the overlay/crash
      // describes use `test('<state>'`; the boot-screen states are generated
      // from the capture loop `for (const mode of ['loading', 'error']...)`
      // — pin the LOOP (which produces the PNG names), not the type
      // annotation or prose that merely mention the mode words.
      if (state.startsWith('boot-screen-')) {
        const mode = state.slice('boot-screen-'.length);
        expect(
          specSource.includes("`boot-screen-${mode}`") &&
            specSource.includes("for (const mode of ['loading', 'error']"),
          `boot-screen capture loop for '${mode}' not found in lumen-baseline.spec.ts — update STATES`,
        ).toBe(true);
        continue;
      }
      const present =
        specSource.includes(`id: '${state}'`) || specSource.includes(`test('${state}'`);
      expect(present, `state id '${state}' not found in lumen-baseline.spec.ts — update STATES`).toBe(true);
    }
  });

  it('the committed set is exactly the spec matrix: 11 states x light/dark x 4 widths, none missing, none extra', () => {
    const expected: string[] = [];
    for (const state of STATES) {
      for (const theme of THEMES) {
        for (const width of WIDTHS) {
          expected.push(`${state}-${theme}-${width}.png`);
        }
      }
    }
    expect(expected).toHaveLength(88);
    const actual = fs
      .readdirSync(BASELINE_DIR)
      .filter((f) => f.endsWith('.png'))
      .sort();
    expect(actual).toEqual([...expected].sort());
  });
});
