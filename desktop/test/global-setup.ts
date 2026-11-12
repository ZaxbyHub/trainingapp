// global-setup.ts — F-AC6 (issue #282): build packtool's compiled CLI before
// the desktop suite runs, so a clean checkout passes `npm test` without
// reading CI (desktop-build.yml builds packtool in CI; nothing in the desktop
// package did it locally).
//
// Compile only (packtool/node_modules/typescript/bin/tsc via process.execPath
// — never npx, never a Windows .cmd shim): no network access is performed,
// ever.
//
// Ordering and skips (impl-review r3 + pr323 review PRR-001):
// 1. An existing complete artifact wins FIRST — keep-if-complete, no deps
//    required (an rm+rebuild while the parallel worker pool spins up raced
//    file locks on Windows, and the required security/harness-contracts jobs
//    run desktop vitest WITHOUT packtool deps, so a deps precondition can
//    never sit ahead of this check).
// 2. Otherwise: no packtool deps + TRAININGAPP_SKIP_PACKTOOL_GLOBAL_SETUP=1
//    (set by the security/harness-contracts workflows, whose rostered specs
//    never invoke the packtool CLI) skips the build with a loud warning
//    instead of failing the gate.
// 3. Otherwise a missing deps tree throws loudly, naming packtool/node_modules.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// desktop/test/ -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKTOOL_DIR = path.join(REPO_ROOT, 'packtool');
const PACKTOOL_DIST = path.join(PACKTOOL_DIR, 'dist');
const TSC_BIN = path.join(PACKTOOL_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
const SKIP_ENV = 'TRAININGAPP_SKIP_PACKTOOL_GLOBAL_SETUP';

export default function globalSetup(): void {
  // 1. Keep-if-complete FIRST: the artifact alone satisfies every spec that
  // shells out to `node packtool/dist/cli.js`, so no deps precondition may
  // run ahead of it (PRR-001: the required security job has no packtool deps).
  if (fs.existsSync(path.join(PACKTOOL_DIST, 'cli.js'))) {
    return;
  }
  // 2. Opt-out for CI jobs whose rostered specs never touch the packtool CLI.
  if (
    !fs.existsSync(path.join(PACKTOOL_DIR, 'node_modules'))
    && process.env[SKIP_ENV] === '1'
  ) {
    console.warn(
      `[trainingapp] ${SKIP_ENV}=1 and packtool/node_modules absent: skipping the `
        + 'packtool build. Specs that shell out to packtool/dist/cli.js will fail '
        + 'in this run by design (this job\'s roster does not include them).',
    );
    return;
  }
  if (!fs.existsSync(path.join(PACKTOOL_DIR, 'node_modules'))) {
    throw new Error(
      'PRECONDITION_MISSING packtool/node_modules — run `npm --prefix packtool ci` once '
        + '(no network is run by this setup; the suite cannot compile packtool without its deps)',
    );
  }
  if (!fs.existsSync(TSC_BIN)) {
    throw new Error(
      'PRECONDITION_MISSING packtool/node_modules/typescript — run `npm --prefix packtool ci` once',
    );
  }
  // 3. Deterministic rebuild when the artifact is absent: remove any partial
  // output, then compile.
  fs.rmSync(PACKTOOL_DIST, { recursive: true, force: true });
  const run = spawnSync(process.execPath, [TSC_BIN, '-p', path.join(PACKTOOL_DIR, 'tsconfig.json')], {
    cwd: PACKTOOL_DIR,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (run.status !== 0 || !fs.existsSync(path.join(PACKTOOL_DIST, 'cli.js'))) {
    const detail = run.stderr || run.stdout || '(no compiler output)';
    throw new Error(
      `packtool build failed (status ${String(run.status)}); the desktop suite needs `
        + `packtool/dist/cli.js. Compiler output:\n${detail}`,
    );
  }
}
