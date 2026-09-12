import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Root is pinned to the packtool package directory so the config works both
// from inside packtool (`npm test`) and from the repo root (acceptance driver).
const root = fileURLToPath(new URL('.', import.meta.url));

// The acceptance driver runs ONE AC's test file per invocation by setting
// PACKTOOL_AC (e.g. "ac8"). Without the variable, all tests run.
const ac = process.env.PACKTOOL_AC ?? '';
if (ac !== '' && !/^ac[1-8]$/.test(ac)) {
  throw new Error(`invalid PACKTOOL_AC "${ac}" (expected ac1..ac8 or unset)`);
}
const include = ac === '' ? ['storyline/__tests__/**/*.test.ts'] : [`storyline/__tests__/extract.${ac}.test.ts`];

export default defineConfig({
  root,
  test: {
    environment: 'node',
    include,
  },
});
