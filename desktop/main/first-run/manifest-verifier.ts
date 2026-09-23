// E2 first-run wizard (issue #85): integrity-manifest loader + sha256 verifier.
//
// Consumes the manifest contract PINNED in issue #84's body (E1 owns the
// format and the build-time generator; this verifier is the wizard-side
// consumer #85 owns): `resources/manifest.json` extending the
// web_ui/public/models/manifest.json shape
//   {id, label, kind, group, files:[{path, required}]}
// with REQUIRED sha256 + sizeBytes per file, plus a top-level packs[] array.
// A required file without a sha256 entry is a manifest-schema failure, not a
// silent skip. Every failure names the specific path with expected/actual —
// the generic-message defect class this wizard exists to close has no
// representable shape here (reason is a closed union).
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ManifestFile {
  path: string;
  required?: boolean;
  sha256?: string;
  sizeBytes?: number;
}

export interface ManifestModel {
  id: string;
  label?: string;
  kind?: string;
  group?: string;
  files: ManifestFile[];
}

export interface ManifestPackEntry {
  id: string;
  version?: string;
  name?: string;
  /** Pack-schema fields carried per the #68 pack specification. */
  source_class?: string;
  /** Dir of the staged pack folder, RELATIVE TO the manifest's packs/
   *  directory (the runtime joins `<manifestDir>/packs/` + dir — see
   *  packEntryDir in desktop/main/index.ts): `<classDir>/<packId>-<version>`
   *  by the E1 generator convention. */
  dir?: string;
}

export interface ResourcesManifest {
  version: string | number;
  description?: string;
  models: ManifestModel[];
  packs?: ManifestPackEntry[];
}

export type ManifestFailureReason =
  | 'missing'
  | 'hash-mismatch'
  | 'size-mismatch'
  | 'sha256-required'
  | 'manifest-unreadable'
  | 'traversal'
  | 'unreadable';

/** Join `relative` under `base` and require the result to stay INSIDE `base`.
 *  Returns null when the relative path escapes (traversal attempt) — manifest
 *  paths are installer-controlled, so this is defense-in-depth, but a generic
 *  join silently reads (and hashes) files anywhere on disk. Case-insensitive
 *  on the prefix because Windows path case is not significant. */
export function containedJoin(base: string, relative: string): string | null {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, relative);
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  const inside =
    process.platform === 'win32'
      ? resolved.toLowerCase().startsWith(baseWithSep.toLowerCase())
      : resolved.startsWith(baseWithSep);
  return inside ? resolved : null;
}

export interface ManifestFailure {
  path: string;
  reason: ManifestFailureReason;
  /** The manifest-recorded expectation (hash or size). */
  expected: string;
  /** What was actually observed ('missing' when the file is absent). */
  actual: string;
}

export interface VerifyResult {
  ok: boolean;
  failures: ManifestFailure[];
  /** sha256 of every verified file, keyed by manifest-relative path — the
   *  drift anchor the wizard stores at completion and re-checks on launch. */
  digests: Record<string, string>;
  verifiedCount: number;
}

/** Loader result: `manifest === null` means "no manifest staged" (NOT an error —
 *  dev/CI trees and pre-E1 packaged builds legitimately lack one; the caller
 *  decides fail-closed vs degrade from `isPackaged`). */
export function loadManifest(manifestPath: string | null): { manifest: ResourcesManifest | null; raw: string | null } {
  if (manifestPath === null || !existsSync(manifestPath)) return { manifest: null, raw: null };
  const raw = readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as ResourcesManifest;
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.models)) {
    throw new Error(`manifest at ${manifestPath} is not a resources manifest (models[] missing)`);
  }
  return { manifest: parsed, raw };
}

/**
 * Resolve the manifest location: explicit env override, then the packaged
 * resources root, then a repo-root resources/manifest.json (dev).
 */
export function resolveManifestPath(options: {
  env?: Record<string, string | undefined>;
  isPackaged: boolean;
  resourcesPath?: string;
  repoRoot?: string;
}): string | null {
  const override = options.env?.TRAININGAPP_DESKTOP_MANIFEST;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  if (options.isPackaged && options.resourcesPath !== undefined) {
    return path.join(options.resourcesPath, 'manifest.json');
  }
  if (options.repoRoot !== undefined) return path.join(options.repoRoot, 'resources', 'manifest.json');
  return null;
}

/** Chunk size for streaming-style hashing: the Quality LLM GGUF is ~2.6 GB,
 *  far above any buffer a startup path should allocate whole (E1, issue #84).
 *  Reading in fixed chunks keeps the hash synchronous (this module's API is
 *  sync by contract) without a whole-file allocation. */
const HASH_CHUNK_BYTES = 8 * 1024 * 1024;

function sha256File(absolutePath: string): string {
  const hash = createHash('sha256');
  const fd = openSync(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    for (;;) {
      // readSync reads up to buffer.length bytes and returns 0 at EOF. Typed
      // as any: Node's overload resolution for Buffer + BigInt offset is
      // needlessly narrow in the DOM-lib-free tsconfig here.
      const read = readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null as unknown as any);
      if (read === 0) break;
      hash.update(read === HASH_CHUNK_BYTES ? buffer : buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Declared byte total for one model group (e.g. 'llm-quality', 'llm-fast')
 * from the manifest — the RAM-gate input for models NOT staged on disk yet
 * (first run before any file exists). Files without a declared sizeBytes
 * contribute nothing rather than poisoning the estimate.
 */
export function manifestGroupBytes(manifest: ResourcesManifest, group: string): number | undefined {
  let total = 0;
  let seen = false;
  for (const model of manifest.models) {
    if (model.group !== group) continue;
    for (const file of model.files) {
      seen = true;
      if (typeof file.sizeBytes === 'number' && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0) {
        total += file.sizeBytes;
      }
    }
  }
  return seen ? total : undefined;
}

/** Verify every required file of every model against its manifest record.
 *  `roots` are candidate directories the manifest-relative paths resolve
 *  against, in order (e.g. the packaged resources root, then the per-profile
 *  models dir). Optional (required:false) files are skipped entirely. */
export function verifyManifest(manifest: ResourcesManifest, roots: string[]): VerifyResult {
  const failures: ManifestFailure[] = [];
  const digests: Record<string, string> = {};
  let verifiedCount = 0;
  for (const model of manifest.models) {
    for (const file of model.files) {
      if (file.required === false) continue;
      if (file.sha256 === undefined || file.sha256.length === 0) {
        failures.push({
          path: file.path,
          reason: 'sha256-required',
          expected: 'a sha256 entry (E1 manifest contract requires it for every required file)',
          actual: 'absent from the manifest',
        });
        continue;
      }
      const found = roots
        .map((root) => containedJoin(root, file.path))
        .find((candidate): candidate is string => candidate !== null && existsSync(candidate));
      if (found === undefined) {
        // Distinguish "not present" from "never looked because the path tried
        // to escape its root" — a traversal attempt is its own named failure.
        const escaped = roots.some((root) => containedJoin(root, file.path) === null);
        failures.push({
          path: file.path,
          reason: escaped ? 'traversal' : 'missing',
          expected: escaped ? `a path inside the manifest roots (${roots.join(', ')})` : `sha256 ${file.sha256}`,
          actual: escaped ? 'path escapes the manifest roots' : 'missing',
        });
        continue;
      }
      // Per-file error naming (E1, issue #84): a hashing/stat failure must
      // name THIS file, never collapse to a generic manifest-unreadable.
      let actualHash: string;
      try {
        actualHash = sha256File(found);
      } catch (err) {
        failures.push({
          path: file.path,
          reason: 'unreadable',
          expected: `sha256 ${file.sha256}`,
          actual: `could not read/hash ${found}: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      if (actualHash !== file.sha256.toLowerCase()) {
        failures.push({
          path: file.path,
          reason: 'hash-mismatch',
          expected: `sha256 ${file.sha256}`,
          actual: `sha256 ${actualHash}`,
        });
        continue;
      }
      if (file.sizeBytes !== undefined) {
        let actualSize: number;
        try {
          actualSize = statSync(found).size;
        } catch (err) {
          failures.push({
            path: file.path,
            reason: 'unreadable',
            expected: `${file.sizeBytes} bytes`,
            actual: `could not stat ${found}: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
        if (actualSize !== file.sizeBytes) {
          failures.push({
            path: file.path,
            reason: 'size-mismatch',
            expected: `${file.sizeBytes} bytes`,
            actual: `${actualSize} bytes`,
          });
          continue;
        }
      }
      digests[file.path] = actualHash;
      verifiedCount += 1;
    }
  }
  return { ok: failures.length === 0, failures, digests, verifiedCount };
}
