#!/usr/bin/env node
// Guardrail for PRR95-001: Electron sandboxed renderers (sandbox: true, which
// this shell always sets) can only load CommonJS preload scripts. The compile
// chain must therefore emit dist/preload/index.cjs with CommonJS content —
// an ESM preload fails at runtime with "Cannot use import statement outside
// a module", a defect class the vitest suite (which imports the TS source
// through a stub) structurally cannot catch.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const preloadDir = path.join(here, '..', 'dist', 'preload');
const cjs = path.join(preloadDir, 'index.cjs');
const js = path.join(preloadDir, 'index.js');

if (!existsSync(cjs)) {
  const hint = existsSync(js)
    ? `found ${js} instead — the compile chain must rename the CommonJS output to .cjs (see the compile script)`
    : `looked in ${preloadDir} — run npm run compile first`;
  console.error(`[verify-preload-format] FAIL: ${cjs} missing. ${hint}`);
  process.exit(1);
}

const source = readFileSync(cjs, 'utf8');
const esmPatterns = [/^\s*import\s+[^"(]/m, /^\s*export\s+/m];
if (esmPatterns.some((re) => re.test(source))) {
  console.error(
    `[verify-preload-format] FAIL: ${cjs} contains ESM syntax. Sandboxed renderers require CommonJS preloads (PRR95-001). Recompile via tsconfig.preload.json.`,
  );
  process.exit(1);
}
if (!/\brequire\s*\(\s*['"]electron['"]\s*\)/.test(source)) {
  console.error(`[verify-preload-format] FAIL: ${cjs} does not require('electron') — unexpected preload shape.`);
  process.exit(1);
}
console.log(`[verify-preload-format] OK: ${cjs} is CommonJS as sandboxed preloads require.`);
