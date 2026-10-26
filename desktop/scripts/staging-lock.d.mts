/** Type declarations for staging-lock.mjs (issue #174 AC1). */
export declare class StagingLockHeld extends Error {
  code: 'STAGING_LOCK_HELD';
  name: 'StagingLockHeld';
  holder: { pid: unknown; since: unknown };
  constructor(lockPath: string, holder: { pid: unknown; since: unknown });
}
export declare function stagingLockPathFor(stageDir: string): string;
export declare function acquireStagingLock(
  stageDir: string,
  opts?: { pid?: number; now?: () => string },
): string;
export declare function releaseStagingLock(stageDir: string, opts?: { pid?: number }): boolean;
export declare function withStagingLockSync<T>(
  stageDir: string,
  fn: () => T,
  opts?: { pid?: number; now?: () => string },
): T;
