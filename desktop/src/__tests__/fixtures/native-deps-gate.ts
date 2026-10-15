// fixtures/native-deps-gate.ts — the #193 native-deps skip-vs-fail policy
// (trace test-batch-oct2026 Cluster A, AC21; executed decision D2 recorded at
// https://github.com/ZaxbyHub/trainingapp/issues/193#issuecomment-6187705111).
//
// Decision D2: a spec that needs a compiled addon (e.g. the real-store
// /stats route over better-sqlite3) must SKIP locally when the addon is
// absent (the repo's sanctioned staged-deps skip) but FAIL under CI — a
// silent CI skip is exactly the silent-degrade class this batch exists to
// kill.

export type NativeDepsGateDecision = 'run' | 'skip' | 'fail';

export interface NativeDepsGateInput {
  /** Whether the process runs under CI (e.g. `process.env.CI` is set). */
  ci: boolean;
  /** Whether the native deps the gated suite needs are present. */
  nativeDepsPresent: boolean;
}

/**
 * D2 (#193): deps present -> 'run' (regardless of CI); deps missing under CI
 * -> 'fail' (never a silent skip); deps missing locally -> 'skip'.
 */
export function nativeDepsGate({ ci, nativeDepsPresent }: NativeDepsGateInput): NativeDepsGateDecision {
  if (nativeDepsPresent) return 'run';
  return ci ? 'fail' : 'skip';
}
