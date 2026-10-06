/**
 * Window event names the readiness gate (readiness-gate.ts) dispatches. Kept in a
 * module of its own, with no imports, so a consumer can listen without importing
 * readiness-gate itself: page tests replace that module with a factory mock, and a
 * factory mock has no export it does not list.
 */

/**
 * Dispatched when a readiness check starts and whenever a check settles while no
 * check is current. `detail.inFlight` is readiness-gate's isReadinessCheckInFlight()
 * at dispatch time: true while the LATEST check (the one a reset or a newer check
 * has not superseded) is still running. PR #151 final review LOW-3: the gate's
 * Retry stays busy until this reports false.
 */
export const READINESS_IN_FLIGHT_EVENT = 'readiness-gate-in-flight';

export interface ReadinessInFlightDetail {
  inFlight: boolean;
}
