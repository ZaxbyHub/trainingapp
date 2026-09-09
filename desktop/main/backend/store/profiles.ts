// store/profiles.ts — profile layout resolution + legacy migration (issue #64).
//
// ADR-0006 (docs/adr/0006-profile-model.md): the DEFAULT is one OS-user-scoped
// single profile at <userData>/profiles/default/store.sqlite; a named-profiles
// mode (<userData>/profiles/<name>/store.sqlite) is opt-in via
// TRAININGAPP_PROFILE_MODE=named + TRAININGAPP_PROFILE_NAME. This module is a
// pure path/layout function — no Electron dependency — so tests drive it with
// plain temp dirs.
import fs from 'node:fs';
import path from 'node:path';

export type ProfileMode = 'single' | 'named';

export const PROFILE_MODE_ENV = 'TRAININGAPP_PROFILE_MODE';
export const PROFILE_NAME_ENV = 'TRAININGAPP_PROFILE_NAME';
export const DEFAULT_PROFILE_NAME = 'default';
/** Store file name under a profile directory (ADR-0006). */
export const STORE_FILE_NAME = 'store.sqlite';

const PROFILE_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

export interface ProfileLayout {
  mode: ProfileMode;
  profileName: string;
  /** Absolute store file path for the resolved profile. */
  storePath: string;
}

function assertValidProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid profile name "${name}": must match [a-z0-9-]{1,64} (lowercase letters, digits, hyphens)`,
    );
  }
}

/**
 * Resolve the profile layout: mode via TRAININGAPP_PROFILE_MODE ('single'
 * default | 'named'), name via TRAININGAPP_PROFILE_NAME. Profile names are
 * strict allowlist values — they become directory names under
 * <userData>/profiles/ and must never traverse. In named mode an explicit
 * name is REQUIRED (never a silent fallback to the default profile); in
 * single mode the name is always 'default'.
 */
export function resolveProfileLayout(opts: {
  userDataPath: string;
  env?: Record<string, string | undefined>;
}): ProfileLayout {
  const env = opts.env ?? process.env;
  const rawMode = env[PROFILE_MODE_ENV] ?? 'single';
  if (rawMode !== 'single' && rawMode !== 'named') {
    throw new Error(`invalid ${PROFILE_MODE_ENV} value "${rawMode}": expected 'single' or 'named'`);
  }
  let profileName: string;
  if (rawMode === 'named') {
    const explicit = env[PROFILE_NAME_ENV];
    if (explicit === undefined || explicit.length === 0) {
      throw new Error(`${PROFILE_MODE_ENV}='named' requires an explicit ${PROFILE_NAME_ENV}`);
    }
    profileName = explicit;
  } else {
    profileName = DEFAULT_PROFILE_NAME;
  }
  assertValidProfileName(profileName);
  return {
    mode: rawMode,
    profileName,
    storePath: path.join(opts.userDataPath, 'profiles', profileName, STORE_FILE_NAME),
  };
}

/**
 * Move B5's interim layout (<userData>/store/store.db) into the ADR-0006
 * default profile. Idempotent: returns false when there is nothing to move
 * (already migrated, or never created). The move is a same-volume rename —
 * atomic on NTFS/ext4, so a crash mid-move cannot lose data; rollback is the
 * reverse rename (documented in ADR-0006).
 */
export function migrateLegacyStoreLayout(userDataPath: string): boolean {
  const legacy = path.join(userDataPath, 'store', 'store.db');
  const targetDir = path.join(userDataPath, 'profiles', DEFAULT_PROFILE_NAME);
  const target = path.join(targetDir, STORE_FILE_NAME);
  if (!fs.existsSync(legacy) || fs.existsSync(target)) return false;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.renameSync(legacy, target);
  // Best-effort cleanup of the now-empty legacy directory.
  try {
    fs.rmdirSync(path.join(userDataPath, 'store'));
  } catch {
    // Non-empty (stray sidecars) or already gone — not a migration failure.
  }
  return true;
}
