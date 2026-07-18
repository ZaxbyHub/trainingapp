#!/usr/bin/env node
/**
 * Issue #37 P2: air-gapped build wrapper.
 *
 * Sets `VITE_AIRGAP=1` for the offline build so that Vite inlines
 * `import.meta.env.VITE_AIRGAP === '1'` as a literal true, letting Rollup
 * tree-shake the `@mlc-ai/web-llm` dynamic import out of the bundle. Then runs
 * prepare-models + build, and FINALLY runs `validate-build --airgap` (not the
 * default `validate-build`) so the airgap-specific check fires: it asserts no
 * emitted chunk references `CreateMLCEngine` / `prebuiltMLCAppConfig` and no
 * chunk name matches `/web-?llm/i`. Without the explicit `--airgap` flag the
 * new airgap exclusion check would be dead code (the default validate-build
 * does not run it).
 *
 * Implemented as a node wrapper (rather than `cross-env VITE_AIRGAP=1 npm run
 * build:offline`) so it is portable across Windows cmd, PowerShell, and POSIX
 * shells without adding a dependency, AND so the validate step can receive the
 * `--airgap` flag (which `build:offline`'s hardcoded `validate-build` does not).
 * The child inherits stdio so build output streams normally and the exit code
 * propagates.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(__dirname, '..');

const env = { ...process.env, VITE_AIRGAP: '1' };
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const node = process.execPath;

function run(label, args, opts = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: WEB_UI,
    stdio: 'inherit',
    env,
    ...opts,
  });
  if (result.error) {
    console.error(`[build:airgap] ${label} failed to spawn: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[build:airgap] ${label} exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// 1. Stage model weights (operator-acquired; airgap build still expects them).
run('prepare-models', [npm, 'run', 'prepare-models']);

// 2. Vite build under VITE_AIRGAP=1 (Rollup tree-shakes @mlc-ai/web-llm).
run('build', [npm, 'run', 'build']);

// 3. Validate WITH --airgap so the WebLLM-exclusion check fires. This is the
//    load-bearing difference vs `build:offline` (which runs validate-build
//    with no flags and would skip the airgap symbol scan).
run('validate-build --airgap', [node, 'scripts/validate-build.mjs', '--airgap']);

console.log('[build:airgap] OK — air-gapped artifact built and validated.');
