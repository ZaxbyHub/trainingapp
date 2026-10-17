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
 *
 * Import-safe (issue #216 AC5): importing this module executes nothing — the
 * steps/runner are exported seams and only direct execution drives the build.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(__dirname, '..');

function isMain(metaUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** The airgap build plan: exactly these steps, in order (contract-pinned). */
export function airgapSteps({ npm, node }) {
  return [
    // 1. Stage model weights (operator-acquired; airgap build still expects them).
    { label: 'prepare-models', args: [npm, 'run', 'prepare-models'] },
    // 2. Vite build under VITE_AIRGAP=1 (Rollup tree-shakes @mlc-ai/web-llm).
    { label: 'build', args: [npm, 'run', 'build'] },
    // 3. Validate WITH --airgap so the WebLLM-exclusion check fires. This is
    //    the load-bearing difference vs `build:offline` (which runs
    //    validate-build with no flags and would skip the airgap symbol scan).
    { label: 'validate-build --airgap', args: [node, 'scripts/validate-build.mjs', '--airgap'] },
  ];
}

/** Run one step with VITE_AIRGAP=1; returns an exit code (0 = OK). */
export function runStep(step, { env, cwd = WEB_UI, spawnSyncImpl = spawnSync, logError = console.error } = {}) {
  const result = spawnSyncImpl(step.args[0], step.args.slice(1), {
    cwd,
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    logError(`[build:airgap] ${step.label} failed to spawn: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    logError(`[build:airgap] ${step.label} exited with status ${result.status}`);
    return result.status ?? 1;
  }
  return 0;
}

export function main({ spawnSyncImpl, log = console.log, logError = console.error } = {}) {
  const env = { ...process.env, VITE_AIRGAP: '1' };
  const isWin = process.platform === 'win32';
  const npm = isWin ? 'npm.cmd' : 'npm';
  const node = process.execPath;
  for (const step of airgapSteps({ npm, node })) {
    const code = runStep(step, { env, spawnSyncImpl, logError });
    if (code !== 0) return code;
  }
  log('[build:airgap] OK — air-gapped artifact built and validated.');
  return 0;
}

// Entry guard (issue #216 AC5): only direct execution drives the build.
if (isMain(import.meta.url)) {
  process.exit(main());
}
