import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Root is pinned to the packtool package directory so the config works both
// from inside packtool (`npm test`) and from the repo root (acceptance driver).
const root = fileURLToPath(new URL('.', import.meta.url));

// The acceptance driver runs ONE AC's test file per invocation by setting
// PACKTOOL_AC (e.g. "ac8"). Without the variable, all tests run.
// Both suites share the ac1..ac8 numbering (D1 extract + D3 build-storyline),
// so a selector runs every file that exists for that AC — never silently
// only the D1 file (PR-review finding: PACKTOOL_AC=ac2 used to skip
// build-storyline.ac2 entirely).
const ac = process.env.PACKTOOL_AC ?? '';
if (ac !== '' && !/^ac[1-8]$/.test(ac)) {
  throw new Error(`invalid PACKTOOL_AC "${ac}" (expected ac1..ac8 or unset)`);
}
const include = ac === ''
  ? ['storyline/__tests__/**/*.test.ts', 'docs/__tests__/**/*.test.ts']
  : [
      `storyline/__tests__/extract.${ac}.test.ts`,
      `storyline/__tests__/build-storyline.${ac}.test.ts`,
    ];

export default defineConfig({
  root,
  test: {
    environment: 'node',
    include,
  },
});
