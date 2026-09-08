// Per-launch desktop auth token (issue #60, Workstream B2).
//
// Contract (frozen by desktop/src/__tests__/b2-token-lifecycle.test.ts):
// 256 bits of CSPRNG entropy per launch, held in MAIN-PROCESS MEMORY ONLY.
// Never persisted to disk, never logged, never sent anywhere except through
// the desktop:get-token IPC handler to the app's own renderer (which received
// it via contextBridge, not storage). The token dies with the process; a new
// launch mints a fresh one, so a token observed in a previous session is dead
// (token-replay-across-restarts is covered in docs/security/desktop.md).
import { randomBytes } from 'node:crypto';

/** Mint one fresh launch token: crypto.randomBytes(32).toString('hex'). */
export function mintLaunchToken(): string {
  return randomBytes(32).toString('hex');
}

let launchToken: string | null = null;

/**
 * Initialize the per-launch token exactly once (idempotent). Called from
 * bootstrap() after the app is ready; every later reader gets the same value.
 */
export function initializeLaunchToken(): string {
  if (launchToken === null) {
    launchToken = mintLaunchToken();
  }
  return launchToken;
}

/** The per-launch token. Fails fast if bootstrap never initialized it. */
export function getLaunchToken(): string {
  if (launchToken === null) {
    throw new Error('desktop launch token not initialized; bootstrap() must call initializeLaunchToken()');
  }
  return launchToken;
}

/**
 * Test hook: clear the holder so a fresh test can exercise initialization.
 * Never call from production code (bootstrap initializes exactly once).
 */
export function __resetLaunchTokenForTests(): void {
  launchToken = null;
}
