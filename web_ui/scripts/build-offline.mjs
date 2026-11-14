#!/usr/bin/env node
/**
 * build-offline.mjs — the flag-forwarding wrapper for `npm run build:offline`
 * (issue #272 AC1).
 *
 * Preserves the base chain exactly (prepare-models → prepare-packs → build →
 * validate-build, the four steps `build:offline` ran as a hardcoded `&&`
 * string) while forwarding the model flags (--no-llm / --no-reranker /
 * --no-embedder) to exactly the two steps that understand them:
 * prepare-models and validate-build. prepare-packs and vite build never
 * receive flags. Unknown flags fail fast with a usage message instead of
 * being silently dropped (or, pre-wrapper, mis-parsed by npm as its own
 * config — the EUNKNOWNCONFIG abort this wrapper replaces).
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const KNOWN_FLAGS = ['--no-llm', '--no-reranker', '--no-embedder'];
const USAGE = `usage: npm run build:offline [-- --no-llm|--no-reranker|--no-embedder]

Forwards the model flags to the prepare-models and validate-build steps.
prepare-packs and vite build never receive flags. Unknown flags are rejected.`;

/**
 * Parse CLI flags. Returns { flags, error } — flags is the forwarded model
 * flags in the order given; error names the first unknown flag.
 */
export function parseArgs(argv) {
  const flags = [];
  for (const arg of argv) {
    if (KNOWN_FLAGS.includes(arg)) {
      flags.push(arg);
    } else {
      return { flags: [], error: `unknown flag: ${arg}` };
    }
  }
  return { flags, error: null };
}

/**
 * The offline step plan: one entry per step, in the base chain's order.
 * `flags: true` marks the steps that receive the forwarded model flags;
 * `flags: false` marks the steps that never do.
 */
export function offlineSteps({ npm = 'npm', node = process.execPath, flags = [] } = {}) {
  return [
    { name: 'prepare-models', command: node, args: ['scripts/prepare-models.mjs', ...flags] },
    { name: 'prepare-packs', command: node, args: ['scripts/prepare-packs.mjs'] },
    { name: 'build', command: npm, args: ['run', 'build'] },
    { name: 'validate-build', command: node, args: ['scripts/validate-build.mjs', ...flags] },
  ];
}

/**
 * Run the steps with the injected spawn implementation. Stops the chain on
 * the first non-zero status and returns that status; returns 0 when all
 * steps succeed.
 */
export function runSteps(spawnImpl) {
  for (const step of spawnImpl.steps) {
    const result = step.run();
    if (result.status !== 0) {
      return result.status;
    }
  }
  return 0;
}

/**
 * Production orchestration entry (the path the frozen check drives): parses
 * argv, plans the steps, and spawns each one with the injected (or real)
 * spawnSync. Test doubles replace spawnSyncImpl; deleting the argument
 * forwarding or the parse here fails the build-offline spec.
 */
export function main(argv = process.argv.slice(2), { spawnSyncImpl = spawnSync } = {}) {
  const { flags, error } = parseArgs(argv);
  if (error) {
    console.error(USAGE);
    console.error(`build-offline: ${error}`);
    return 2;
  }
  const steps = offlineSteps({ flags });
  for (const step of steps) {
    // npm resolves to npm.cmd on Windows, which spawnSync cannot exec without
    // a shell; node scripts exec fine either way. With shell:true the command
    // word needs quoting because process.execPath contains spaces.
    const useShell = process.platform === 'win32';
    const command = useShell && step.command.includes(' ') ? `"${step.command}"` : step.command;
    const result = spawnSyncImpl(command, step.args, {
      stdio: 'inherit',
      shell: useShell,
    });
    if (result.status !== 0 || result.error) {
      console.error(
        `build-offline: step ${step.name} failed` +
          (result.error ? ` (${result.error.message})` : ` with status ${result.status}`),
      );
      return result.status ?? 1;
    }
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  process.exit(main());
}
