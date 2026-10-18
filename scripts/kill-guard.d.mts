/**
 * Type declarations for scripts/kill-guard.mjs (issue #216 AC1).
 * Hand-written so `desktop` (moduleResolution nodenext, no allowJs) can
 * import the shared ESM wrapper from TypeScript harness code.
 */
export interface TaskkillResult {
  status: number | null;
  error?: Error | null;
}

export interface KillProcessTreeOptions {
  runTaskkill?: (args: string[]) => TaskkillResult;
  isAlive?: (pid: number) => boolean;
  log?: (message: string) => void;
}

export interface KillProcessTreeResult {
  skipped: boolean;
  status: number | null;
  error: Error | null;
}

export declare const taskkillArgs: (pid: number) => string[];
export declare function defaultRunTaskkill(args: string[]): TaskkillResult;
export declare function killProcessTree(
  pid: number,
  options?: KillProcessTreeOptions,
): KillProcessTreeResult;
