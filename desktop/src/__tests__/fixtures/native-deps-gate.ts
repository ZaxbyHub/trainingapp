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

// ---------------------------------------------------------------------------
// Shared gate factory (issue #203): the ONE home for the presence probe, the
// skip/fail message text, and the force-absent test knob. Suites construct no
// presence probe of their own and carry no skip-gate ternary; they call
// nativeDepsIt (it-level) or nativeDepsDescribeGroup (describe-level) instead.
// The adoption net in i193-native-deps-gate.test.ts enforces this.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

export const STAGING_INSTRUCTION = 'npm --prefix desktop ci';
export const NATIVE_DEPS_ARTIFACT = 'desktop/node_modules/better-sqlite3';
export const FORCE_ABSENT_ENV = 'TRAININGAPP_TEST_FORCE_NATIVE_DEPS_ABSENT';
export const NATIVE_DEPS_SKIP_MARKER =
  `SKIPPED: ${NATIVE_DEPS_ARTIFACT} absent — run \`${STAGING_INSTRUCTION}\` to stage it (issue #193 D2: local skip)`;
export const NATIVE_DEPS_FAIL_MESSAGE =
  `native deps missing under CI: ${NATIVE_DEPS_ARTIFACT} absent — run \`${STAGING_INSTRUCTION}\` to stage it (issue #193 D2: fail, never silently skip)`;

function selfRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

/**
 * The ONE native-deps presence probe (issue #203): the test-only force knob is
 * honored first, then the staged-addon existence check. Suites must call this
 * (or the factories below) instead of constructing their own probe.
 */
export function nativeDepsPresent(repoRoot?: string): boolean {
  if (process.env[FORCE_ABSENT_ENV] === '1') return false;
  const root = repoRoot ?? selfRepoRoot();
  return fs.existsSync(path.join(root, 'desktop', 'node_modules', 'better-sqlite3'));
}

/** Probe + CI + policy in one: the suite-facing D2 decision. */
export function nativeDepsDecision(): NativeDepsGateDecision {
  return nativeDepsGate({ ci: Boolean(process.env.CI), nativeDepsPresent: nativeDepsPresent() });
}

/* vitest call shapes used by the gated suites: (name, fn) and (name, options, fn). */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type ItLike = (name: string, ...rest: any[]) => void;

/**
 * it-level factory: 'run' executes the row; 'skip' skips it with the staging
 * instruction in the row title; 'fail' fails it loudly with the shared
 * message (never a silent skip under CI).
 */
export function nativeDepsIt(label: string): ItLike {
  const decision = nativeDepsDecision();
  if (decision === 'run') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (name: string, ...rest: any[]) => (it as any)(name, ...rest);
  }
  if (decision === 'skip') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (name: string, ...rest: any[]) => (it.skip as any)(`${name} [${NATIVE_DEPS_SKIP_MARKER}]`, ...rest);
  }
  return (name: string) => {
    it(`${name} [${label}: native deps missing under CI]`, () => {
      throw new Error(NATIVE_DEPS_FAIL_MESSAGE);
    });
  };
}

/**
 * describe-level factory (the i169 shape): `describeGroup` runs or skips the
 * whole group (skip titles carry the staging instruction), and `guard` is a
 * beforeAll-safe thunk that throws the shared fail message when the gate says
 * 'fail' (the suite-scoped fail branch). Both are inert on 'run'.
 */
export function nativeDepsDescribeGroup(title: string): {
  describeGroup: (body: () => void) => void;
  guard: () => void;
} {
  const decision = nativeDepsDecision();
  if (decision === 'skip') {
    return {
      describeGroup: (body: () => void) => describe.skip(`${title} [${NATIVE_DEPS_SKIP_MARKER}]`, body),
      guard: () => {},
    };
  }
  return {
    describeGroup: (body: () => void) => describe(title, body),
    guard: decision === 'fail' ? () => { throw new Error(NATIVE_DEPS_FAIL_MESSAGE); } : () => {},
  };
}
