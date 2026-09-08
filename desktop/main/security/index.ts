// Security barrel for the desktop transport (issue #60, Workstream B2).
//
// bootstrap() consumes exactly this module; every new transport-facing seam
// in desktop/ must thread through these exports rather than rolling its own
// policy (invariant documented in desktop/README.md "Security posture").
export { resolveSecurityConfig, DEFAULT_TOKEN_HEADER_NAME, DEFAULT_ALLOWED_ORIGINS, DEV_ORIGINS_ENV, type SecurityConfig } from './config.js';
export { mintLaunchToken, initializeLaunchToken, getLaunchToken, __resetLaunchTokenForTests } from './token.js';
export { createLoopbackGuard, originAllowed, type LoopbackGuard, type LoopbackGuardRequest, type CreateLoopbackGuardOptions } from './loopback-guard.js';
export { buildCspPolicy, INLINE_THEME_BOOTSTRAP_SHA256 } from './csp.js';
import { createLoopbackGuard, type CreateLoopbackGuardOptions, type LoopbackGuard } from './loopback-guard.js';
import { __resetLaunchTokenForTests } from './token.js';

let activeGuard: LoopbackGuard | null = null;

/**
 * Construct the per-launch request gate from the resolved config and token.
 * Called once from bootstrap(); `getLoopbackGuard()` then hands the SAME
 * instance to whichever backend host Workstream B3 (#61) lands (Node main or
 * the ADR-0003 Python sidecar front). B3's server MUST compose this gate in
 * front of every request route — see docs/security/desktop.md ("B3
 * integration contract"). The bootstrap boot fails fast if this was never
 * called, so a future regression that drops the construction cannot ship.
 */
export function initializeTransportSecurity(opts: CreateLoopbackGuardOptions): LoopbackGuard {
  activeGuard = createLoopbackGuard(opts);
  return activeGuard;
}

/** The active per-launch gate, or null before bootstrap initialization. */
export function getLoopbackGuard(): LoopbackGuard | null {
  return activeGuard;
}

/**
 * Test hook: clear the transport-security singletons (guard holder + launch
 * token) so a fresh test can exercise initialization from scratch. Never call
 * from production code.
 */
export function __resetTransportSecurityForTests(): void {
  activeGuard = null;
  __resetLaunchTokenForTests();
}