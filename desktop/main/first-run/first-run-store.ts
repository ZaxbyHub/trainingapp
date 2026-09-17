// E2 first-run wizard (issue #85): persisted wizard state.
//
// The issue's config keys — firstRun.completed (boolean),
// firstRun.selectedProfile ("quality"|"fast"), firstRun.completedAt (string) —
// CANNOT ride the engine settings API (applySettingsPatch validates a closed
// rag_* set, engine.ts) so they persist in a dedicated atomic sidecar beside
// the profile store, under the SAME durability contract as settings-store.ts
// (B9): atomic tmp+fsync+rename, never-fatal loads, disabled without a store
// path (CI stub runs).
import { existsSync, fsyncSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

const FIRST_RUN_FILE_NAME = 'first-run.json';

export interface FirstRunState {
  firstRun: {
    completed: boolean;
    selectedProfile: 'quality' | 'fast';
    completedAt: string;
    acknowledgedLicenses: boolean;
    /** Drift anchor: sha256 of every verified manifest file at completion. */
    manifestDigests: Record<string, string>;
  };
}

export function EMPTY_FIRST_RUN_STATE(): FirstRunState {
  return {
    firstRun: {
      completed: false,
      selectedProfile: 'fast',
      completedAt: '',
      acknowledgedLicenses: false,
      manifestDigests: {},
    },
  };
}

/** The profile directory that contains store.sqlite (dirname of storePath). */
export function firstRunStatePathFor(storePath: string): string {
  return path.join(path.dirname(storePath), FIRST_RUN_FILE_NAME);
}

/** Read the persisted state; defaults when absent or corrupt (never throws —
 *  a broken sidecar must not take the host down). */
export function loadFirstRunState(storePath: string): FirstRunState {
  const file = firstRunStatePathFor(storePath);
  if (!existsSync(file)) return EMPTY_FIRST_RUN_STATE();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as FirstRunState;
    const inner = parsed?.firstRun;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof inner !== 'object' ||
      inner === null ||
      typeof inner.completed !== 'boolean'
    ) {
      console.error(`[trainingapp-desktop] first-run state at ${file} is not a first-run sidecar; ignoring`);
      return EMPTY_FIRST_RUN_STATE();
    }
    return {
      firstRun: {
        completed: inner.completed,
        selectedProfile: inner.selectedProfile === 'quality' ? 'quality' : 'fast',
        completedAt: typeof inner.completedAt === 'string' ? inner.completedAt : '',
        acknowledgedLicenses: inner.acknowledgedLicenses === true,
        manifestDigests:
          typeof inner.manifestDigests === 'object' && inner.manifestDigests !== null
            ? inner.manifestDigests
            : {},
      },
    };
  } catch (err) {
    console.error(
      `[trainingapp-desktop] could not parse first-run state at ${file}; ignoring (${err instanceof Error ? err.message : String(err)})`,
    );
    return EMPTY_FIRST_RUN_STATE();
  }
}

/** Atomically persist the state. Throws on write failure so the caller can
 *  surface the error instead of silently losing the acknowledgment. */
export function saveFirstRunState(storePath: string, state: FirstRunState): void {
  const file = firstRunStatePathFor(storePath);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, JSON.stringify(state, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (err) {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}

export type FirstRunNeededReason = 'not-completed' | 'drift' | 'reset' | 'complete';

/**
 * Decide whether the wizard must run: never completed, or completed but a
 * manifest-covered file's hash changed since (drift), or the operator forced
 * a re-run (reset). Drift is only detectable when a manifest is RESOLVABLE —
 * with none staged there is nothing to compare and completion stands.
 * Drift outranks the force seam: the force flag only makes the wizard OPEN;
 * it must not relabel an actual integrity drift as a voluntary reset.
 */
export function evaluateStatus(
  state: FirstRunState,
  options: { forced: boolean; manifestDigests: Record<string, string> | null },
): { needed: boolean; reason: FirstRunNeededReason } {
  if (!state.firstRun.completed) {
    return { needed: true, reason: 'not-completed' };
  }
  const stored = state.firstRun.manifestDigests;
  const current = options.manifestDigests;
  if (current !== null) {
    for (const [trackedPath, digest] of Object.entries(stored)) {
      if (current[trackedPath] !== digest) return { needed: true, reason: 'drift' };
    }
  }
  if (options.forced) return { needed: true, reason: 'reset' };
  return { needed: false, reason: 'complete' };
}
