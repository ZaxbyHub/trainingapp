/**
 * staging-lock.mjs — exclusive staging lock for the shared installer-resource
 * staging tree (issue #174 AC1).
 *
 * `desktop/installer-resources/` is written by stage-installer-resources.mjs
 * (wipe + copy) and then read/enumerated by build-installer-manifest.mjs
 * (manifest write). Two overlapping invocations on one machine used to race:
 * one run's wipe could land in the middle of the other's copy or enumeration,
 * tearing the staged tree with no diagnostic naming the concurrency. The lock
 * lives OUTSIDE the staged tree — `<stage-dir>.lock`, a sibling — so the
 * stager's wholesale wipe never deletes it and the generator's staged-tree
 * walk never sees it, and it is derived from the EFFECTIVE stage dir so
 * temporary replicas get their own lock.
 *
 * Contract (issue #174 AC1: "serialize or isolate; loud failure at minimum"):
 *   - `O_EXCL` create; the loser fails LOUD with the named STAGING_LOCK_HELD
 *     error carrying the holder pid — no silent stealing and no waiting, so a
 *     deadlock is impossible and a stale lock is always an explicit operator
 *     decision;
 *   - release removes the file ONLY when the recorded holder pid matches the
 *     caller (a crashed holder's lock is never unlinked by a bystander);
 *   - `withStagingLockSync` releases on BOTH the success and the throw path —
 *     scripts must keep `process.exit` OUT of the guarded region (an exit
 *     skips finally and would strand the lock; both consumers were
 *     restructured to return/throw instead, issue #174 round-1 critic).
 */
import fs from 'node:fs';

export class StagingLockHeld extends Error {
  constructor(lockPath, holder) {
    super(
      `STAGING_LOCK_HELD: ${lockPath} is held by pid ${holder.pid} since ${holder.since} — ` +
        'another staging run is active on this machine; if no build is running, remove the stale lock and retry',
    );
    this.name = 'StagingLockHeld';
    this.code = 'STAGING_LOCK_HELD';
    this.holder = holder;
  }
}

/** The lock file for a stage dir: a SIBLING of the staged tree. */
export function stagingLockPathFor(stageDir) {
  return `${stageDir}.lock`;
}

/**
 * Acquire the exclusive staging lock for `stageDir`. Throws StagingLockHeld
 * when another run holds it. Returns the lock path.
 */
export function acquireStagingLock(stageDir, { pid = process.pid, now = () => new Date().toISOString() } = {}) {
  const lockPath = stagingLockPathFor(stageDir);
  try {
    // 'wx' = fail if the path exists: the mutual exclusion is the atomic
    // exclusive create, not a check-then-write.
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid, since: now() }), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return lockPath;
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') {
      let holder = { pid: '?', since: '?' };
      try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && 'pid' in parsed) holder = parsed;
      } catch {
        // Unreadable/foreign lock: still refuse, with the raw path as evidence.
      }
      throw new StagingLockHeld(lockPath, holder);
    }
    throw err;
  }
}

/**
 * Release a lock previously acquired for `stageDir`. The lock is unlinked
 * ONLY when the recorded holder pid matches `pid` — a bystander never deletes
 * a crashed holder's lock (that stays an explicit operator action; see the
 * StagingLockHeld message).
 */
export function releaseStagingLock(stageDir, { pid = process.pid } = {}) {
  const lockPath = stagingLockPathFor(stageDir);
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return false; // nothing to release (or unreadable): never unlink blind
  }
  if (holder === null || typeof holder !== 'object') return false;
  if (Number(holder.pid) !== Number(pid)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the exclusive staging lock for `stageDir`. The lock
 * is released on BOTH paths — including when `fn` returns a promise (release
 * waits for the promise to settle, never before). Keep process.exit out of
 * `fn`: an exit skips the release entirely.
 */
export function withStagingLockSync(stageDir, fn, opts = {}) {
  acquireStagingLock(stageDir, opts);
  // Release errors must NEVER mask the guarded fn's own failure.
  const release = () => {
    try {
      return releaseStagingLock(stageDir, opts);
    } catch (releaseErr) {
      console.error('staging-lock: release failed: ' + (releaseErr instanceof Error ? releaseErr.message : String(releaseErr)));
      return false;
    }
  };
  let result;
  try {
    result = fn();
  } catch (err) {
    release();
    throw err;
  }
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    return result.then(
      (value) => {
        release();
        return value;
      },
      (err) => {
        release();
        throw err;
      },
    );
  }
  release();
  return result;
}
