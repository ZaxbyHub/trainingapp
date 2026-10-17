/**
 * Shared checked kill wrapper for harness scripts (issue #216 AC1).
 *
 * Every harness process-tree kill routes through `killProcessTree`, the
 * generalization of the packaged-smoke batch's `taskkillTree` contract:
 * - a liveness predicate refuses to kill an exited child,
 * - the raw `taskkill` invocation lives in exactly one place
 *   (`defaultRunTaskkill`) so the status is always observable,
 * - the spawn result is checked and failures are logged — never silent.
 *
 * Typed for TypeScript consumers via `kill-guard.d.mts`.
 */
import { spawnSync } from 'node:child_process';

/** The single raw taskkill argument shape: kill the tree, force, by PID. */
export const taskkillArgs = (pid) => ['/PID', String(pid), '/T', '/F'];

/** The single raw `taskkill` invocation site. */
export function defaultRunTaskkill(args) {
  return spawnSync('taskkill', args, { stdio: 'ignore', timeout: 15_000 });
}

/**
 * killProcessTree(pid, { runTaskkill, isAlive, log })
 *
 * Returns `{ skipped, status, error }`:
 * - `skipped: true`  — the liveness predicate refused (child already exited)
 *                      or the pid is invalid; nothing was spawned.
 * - `status: 0`      — taskkill reported success.
 * - `status: N`      — taskkill ran and reported failure (logged).
 * - `status: null` with `error` — the spawn itself failed (logged).
 */
export function killProcessTree(pid, { runTaskkill = defaultRunTaskkill, isAlive, log = () => {} } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { skipped: true, status: null, error: new Error(`invalid pid: ${String(pid)}`) };
  }
  if (typeof isAlive === 'function' && !isAlive(pid)) {
    return { skipped: true, status: null, error: null };
  }
  let res;
  try {
    res = runTaskkill(taskkillArgs(pid));
  } catch (err) {
    log(`kill-guard: taskkill failed (${err instanceof Error ? err.message : String(err)})`);
    return { skipped: false, status: null, error: err instanceof Error ? err : new Error(String(err)) };
  }
  if (res && res.error) {
    const err = res.error instanceof Error ? res.error : new Error(String(res.error));
    log(`kill-guard: taskkill failed (${err.message})`);
    return { skipped: false, status: null, error: err };
  }
  const status = res ? res.status : null;
  if (status !== 0) {
    log(`kill-guard: taskkill failed (status=${String(status)})`);
    return { skipped: false, status, error: null };
  }
  return { skipped: false, status: 0, error: null };
}
