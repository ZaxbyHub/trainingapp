// External model settings sidecar (universal-provider-settings-overhaul).
//
// The NON-SECRET external.* settings (enabled, protocol, baseUrl, model,
// grounded) persist to `<profileDir>/external.json` — beside, not inside,
// settings.json — so settings.json never carries external.* keys and an older
// desktop build keeps loading it unchanged (downgrade-safe). The API key is
// never written here: it lives only in the main-process SecretStore.
//
// Same durability contract as settings-store.ts: atomic write (same-dir tmp +
// fsync + rename), a missing or corrupt file is never fatal.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

const EXTERNAL_FILE_NAME = 'external.json';

/** <profileDir>/external.json for a store path (<profileDir>/store.sqlite). */
export function externalPathFor(storePath: string): string {
  return path.join(path.dirname(storePath), EXTERNAL_FILE_NAME);
}

/** Read the persisted snapshot; null when absent or corrupt (never throws). */
export function loadExternalSnapshot(storePath: string): Record<string, unknown> | null {
  const file = externalPathFor(storePath);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(`[trainingapp-backend] external model settings at ${file} are not a JSON object; ignoring`);
      return null;
    }
    // Only external.* keys are honored, and never a key value.
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.startsWith('external.') && key !== 'external.apiKey') out[key] = value;
    }
    return out;
  } catch (err) {
    console.error(
      `[trainingapp-backend] could not parse external model settings at ${file}; ignoring (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

/** Atomically persist an engine-accepted snapshot. Throws on write failure. */
export function saveExternalSnapshot(storePath: string, snapshot: Record<string, unknown>): void {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key.startsWith('external.') && key !== 'external.apiKey') clean[key] = value;
  }
  const file = externalPathFor(storePath);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, JSON.stringify(clean, null, 2));
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

/**
 * Tolerant boot replay: apply the stored external snapshot; if the engine
 * refuses it (e.g. the stored URL is public and airgap is now on), retry with
 * the external model disabled and the refused URL dropped, and finally with
 * only external.enabled=false. Logs what was dropped; never throws.
 */
export function replayExternalSnapshot(
  snapshot: Record<string, unknown>,
  apply: (patch: Record<string, unknown>) => { ok: true } | { ok: false; detail: string; errors?: string[] },
): void {
  if (Object.keys(snapshot).length === 0) return;
  const first = apply(snapshot);
  if (first.ok) return;
  const reason = [first.detail, ...(first.errors ?? [])].join('; ');
  const withoutUrl: Record<string, unknown> = { ...snapshot, 'external.enabled': false };
  delete withoutUrl['external.baseUrl'];
  const second = apply(withoutUrl);
  if (second.ok) {
    console.error(
      `[trainingapp-backend] stored external model settings were refused (${reason}); the external model is OFF and its base URL was dropped`,
    );
    return;
  }
  apply({ 'external.enabled': false });
  console.error(`[trainingapp-backend] stored external model settings were refused (${reason}); the external model is OFF`);
}
