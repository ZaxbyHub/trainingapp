/**
 * package.json offline build/serve wiring tests (issue #272 AC2 / frozen
 * check C8).
 *
 * Reads web_ui/package.json and asserts the serve/start offline scripts
 * exist with the documented bodies, build:offline routes through the
 * flag-forwarding wrapper (the entry-point half of the AC1 binding), and
 * `build` itself is unchanged (test:e2e and test:visual chain on it).
 *
 * @vitest-environment node
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>;
};

describe('offline serve/start npm wiring (issue #272 AC2)', () => {
  test('serve:offline runs the standalone serve-offline.mjs script', () => {
    expect(PKG.scripts['serve:offline']).toBe('node scripts/serve-offline.mjs');
  });

  test('start:offline chains build:offline then serve:offline and takes no flags', () => {
    expect(PKG.scripts['start:offline']).toBe('npm run build:offline && npm run serve:offline');
    // npm appends post-`--` args to the whole script string, so start:offline
    // must stay flag-free (flags go to build:offline; the archive is served).
    expect(PKG.scripts['start:offline']).not.toContain('--no-');
  });

  test('build:offline routes through the flag-forwarding wrapper (entry-point binding)', () => {
    expect(PKG.scripts['build:offline']).toBe('node scripts/build-offline.mjs');
  });

  test('the plain build script is unchanged (tsc -b && vite build)', () => {
    expect(PKG.scripts['build']).toBe('tsc -b && vite build');
  });
});
