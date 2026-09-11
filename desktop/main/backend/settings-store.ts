// B9 (issue #67): per-profile settings persistence for the desktop backend.
//
// GET/PUT /settings existed since B3/B4 but kept state on the engine INSTANCE
// only, so an inference-profile override was lost on every restart. This
// module persists the engine-accepted snapshot to `<profileDir>/settings.json`
// (the directory that also holds store.sqlite) and loads it at boot, BEFORE
// the engine is handed to the listener.
//
// Durability contract (plan D-4, Round-3 pin C-2):
//   - write is ATOMIC: `settings.json.<pid>.<rand>.tmp` in the SAME directory,
//     fsynced, then renamed onto settings.json (same-dir rename is atomic on
//     NTFS/ext4); the tmp file is unlinked on any failure;
//   - a MISSING or CORRUPT sidecar is never fatal: the host boots with engine
//     defaults and logs a warning;
//   - persistence is DISABLED when the host has no store path (CI stub runs),
//     preserving today's engine-memory behavior there.

import { existsSync, fsyncSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

const SETTINGS_FILE_NAME = 'settings.json';

/** The profile directory that contains store.sqlite (dirname of storePath). */
export function settingsPathFor(storePath: string): string {
  return path.join(path.dirname(storePath), SETTINGS_FILE_NAME);
}

/**
 * Read the persisted snapshot; `null` when absent or corrupt (never throws —
 * a broken sidecar must not take the host down).
 */
export function loadSettingsSnapshot(storePath: string): Record<string, unknown> | null {
  const file = settingsPathFor(storePath);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(`[trainingapp-backend] settings snapshot at ${file} is not a JSON object; ignoring`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.error(
      `[trainingapp-backend] could not parse settings snapshot at ${file}; ignoring (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

/**
 * Atomically persist a snapshot the engine already ACCEPTED. Throws on write
 * failure so the server can surface a 500 instead of silently lying about
 * persistence; the tmp file is cleaned up in that case.
 */
export function saveSettingsSnapshot(storePath: string, settings: Record<string, unknown>): void {
  const file = settingsPathFor(storePath);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, JSON.stringify(settings, null, 2));
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
