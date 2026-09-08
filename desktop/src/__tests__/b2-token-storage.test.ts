// Token-storage structural guard, ported into vitest so it runs in CI's
// `npm --prefix desktop test` (the driver-side grep in desktop/repro/check-b2.sh
// runs the same two patterns but only on explicit `check-b2.sh token-bridge`
// invocations). Invariant (issue #60, AC3): the desktop transport token is
// never parked in web storage and never delivered via a URL parameter.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
// desktop/src/__tests__ -> desktop -> repo root
const ROOT = path.resolve(here, '..', '..', '..');
const SCAN_DIRS = [path.join(ROOT, 'desktop', 'main'), path.join(ROOT, 'desktop', 'preload')];

/** Recursively list .ts files under a directory (node_modules never appears there). */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const STORAGE_USAGE = /(localStorage|sessionStorage)\s*(\.|\[)/;
const URL_PARAM_TOKEN = /[?&#]token=/;

describe('AC3 structural guard: token never in web storage or URL params', () => {
  it('desktop/main + desktop/preload contain zero storage-API usage shapes', () => {
    for (const file of SCAN_DIRS.flatMap((d) => tsFiles(d))) {
      const source = readFileSync(file, 'utf8');
      expect(STORAGE_USAGE.test(source), `${file} must not touch localStorage/sessionStorage`).toBe(false);
    }
  });

  it('desktop/main + desktop/preload contain zero token-as-URL-parameter patterns', () => {
    for (const file of SCAN_DIRS.flatMap((d) => tsFiles(d))) {
      const source = readFileSync(file, 'utf8');
      expect(URL_PARAM_TOKEN.test(source), `${file} must not deliver a token via URL parameter`).toBe(false);
    }
  });
});
