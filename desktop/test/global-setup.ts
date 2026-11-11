// global-setup.ts — F-AC6 (issue #282): build packtool's compiled CLI before
// the desktop suite runs, so a clean checkout passes `npm test` without
// reading CI (desktop-build.yml builds packtool in CI; nothing in the desktop
// package did it locally).
//
// Compile only (packtool/node_modules/typescript/bin/tsc via process.execPath
// — never npx, never a Windows .cmd shim): no network access is performed,
// ever. When packtool/dist exists it is removed and rebuilt so both the
// frozen C13 legs are deterministic in any worktree (the driver clears dist
// too; the rebuild is unconditional). Fails loudly, naming packtool/node_modules,
// when the compiler or the runtime deps are absent.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// desktop/test/ -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKTOOL_DIR = path.join(REPO_ROOT, 'packtool');
const PACKTOOL_DIST = path.join(PACKTOOL_DIR, 'dist');
const TSC_BIN = path.join(PACKTOOL_DIR, 'node_modules', 'typescript', 'bin', 'tsc');

export default function globalSetup(): void {
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
  // Deterministic for the frozen C13 leg: that driver removes packtool/dist
  // BEFORE vitest starts, so a missing cli.js here always rebuilds. When the
  // artifact already exists we keep it: an rm+rebuild while the parallel
  // worker pool spins up raced file locks on Windows (freshly emitted dist
  // files transiently ENOENT for `node dist/cli.js` spawns mid-suite) and a
  // stale-but-complete artifact is equally valid for the suite.
  if (fs.existsSync(path.join(PACKTOOL_DIST, 'cli.js'))) {
    return;
  }
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
