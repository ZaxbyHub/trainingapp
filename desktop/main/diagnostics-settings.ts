// Diagnostics sidecar (issue #248, AC2): the Electron main process is the
// SOLE persistence authority for the Enhanced logging level. State lives in
// `<profileDir>/diagnostics-settings.json` (the directory that also holds
// store.sqlite / settings.json), read once at file-sink activation.
//
// Durability contract (identical idiom to backend/settings-store.ts):
//   - write is ATOMIC: `diagnostics-settings.json.<pid>.<rand>.tmp` in the
//     SAME directory, fsynced, then renamed onto the target (same-dir rename
//     is atomic on NTFS/ext4); the tmp file is unlinked on any failure;
//   - a MISSING or CORRUPT sidecar is never fatal and reads as
//     { enhancedLogging: false } (the default level is `info`).

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

const DIAGNOSTICS_FILE_NAME = 'diagnostics-settings.json';

export interface DiagnosticsSettings {
  enhancedLogging: boolean;
}

export function diagnosticsSettingsPathFor(storePath: string): string {
  return path.join(path.dirname(storePath), DIAGNOSTICS_FILE_NAME);
}

/**
 * Read the persisted diagnostics state; absent or corrupt sidecars read as
 * `{ enhancedLogging: false }` and are never fatal.
 */
export function loadDiagnosticsSettings(storePath: string): DiagnosticsSettings {
  const file = diagnosticsSettingsPathFor(storePath);
  if (!existsSync(file)) return { enhancedLogging: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(`[trainingapp-diagnostics] settings sidecar at ${file} is not a JSON object; using defaults`);
      return { enhancedLogging: false };
    }
    const record = parsed as Record<string, unknown>;
    return { enhancedLogging: record.enhancedLogging === true };
  } catch {
    console.error(`[trainingapp-diagnostics] could not parse settings sidecar at ${file}; using defaults`);
    return { enhancedLogging: false };
  }
}

/**
 * Atomically persist the diagnostics state. Throws on write failure so the
 * caller can revert the live level instead of silently lying about
 * persistence; the tmp file is cleaned up in that case.
 */
export function saveDiagnosticsSettings(storePath: string, settings: DiagnosticsSettings): void {
  const file = diagnosticsSettingsPathFor(storePath);
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
