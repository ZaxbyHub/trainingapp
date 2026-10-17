#!/usr/bin/env node
// Guardrail for PRR95-001: Electron sandboxed renderers (sandbox: true, which
// this shell always sets) can only load CommonJS preload scripts. The compile
// chain must therefore emit dist/preload/index.cjs with CommonJS content —
// an ESM preload fails at runtime with "Cannot use import statement outside
// a module", a defect class the vitest suite (which imports the TS source
// through a stub) structurally cannot catch.
//
// Import-safe (issue #216 AC5): importing this module executes nothing —
// `verifyPreloadFormat` is the exported contract and only direct execution
// drives the CLI.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Verify a preload directory holds a CommonJS index.cjs with the expected
 * sandbox shape. Returns an array of error messages (empty = OK).
 */
export function verifyPreloadFormat(preloadDir) {
  const errors = [];
  const cjs = path.join(preloadDir, 'index.cjs');
  const js = path.join(preloadDir, 'index.js');

  if (!existsSync(cjs)) {
    const hint = existsSync(js)
      ? `found ${js} instead — the compile chain must rename the CommonJS output to .cjs (see the compile script)`
      : `looked in ${preloadDir} — run npm run compile first`;
    errors.push(`[verify-preload-format] FAIL: ${cjs} missing. ${hint}`);
    return errors;
  }

  const source = readFileSync(cjs, 'utf8');
  const esmPatterns = [/^\s*import\s+[^"(]/m, /^\s*export\s+/m];
  if (esmPatterns.some((re) => re.test(source))) {
    errors.push(
      `[verify-preload-format] FAIL: ${cjs} contains ESM syntax. Sandboxed renderers require CommonJS preloads (PRR95-001). Recompile via tsconfig.preload.json.`,
    );
  }
  if (!/\brequire\s*\(\s*['"]electron['"]\s*\)/.test(source)) {
    errors.push(`[verify-preload-format] FAIL: ${cjs} does not require('electron') — unexpected preload shape.`);
  }
  return errors;
}

function isMain(metaUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

export function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const preloadDir = path.join(here, '..', 'dist', 'preload');
  const errors = verifyPreloadFormat(preloadDir);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    return 1;
  }
  console.log(`[verify-preload-format] OK: ${path.join(preloadDir, 'index.cjs')} is CommonJS as sandboxed preloads require.`);
  return 0;
}

// Entry guard (issue #216 AC5): only direct execution drives the CLI.
if (isMain(import.meta.url)) {
  process.exit(main());
}
