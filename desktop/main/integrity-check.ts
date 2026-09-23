// E1 (issue #84): startup integrity gate for packaged installer resources.
//
// Verifies the staged resources manifest (`resources/manifest.json`, pinned
// by the E2 verifier contract) BEFORE the backend host starts, and derives
// the packaged→runtime bridge locations from the VERIFIED manifest:
//   - engine per-profile model file overrides (llm-quality / llm-fast
//     `model.gguf`) — threaded through resolveNodeEngine's existing
//     LlamaEngineOptions.models seam (modelOverrides is constructor-only, so
//     this module must run before engine construction);
//   - embedder / reranker model dirs (group 'embedding' / 'reranker') — the
//     bootstrap feeds these into the TRAININGAPP_EMBEDDING_MODEL_DIR /
//     TRAININGAPP_RERANKER_MODEL_DIR env seams after a pass.
//
// Decision table (approved plan, trace 84-package-models-integrity-manifest):
//   packaged + manifest + failures    -> block (backend start refused; every
//                                        failure names path+expected/actual)
//   packaged + manifest + clean       -> pass  (+ modelDirs derived)
//   packaged + no manifest            -> block (fail-closed: named failure)
//   dev + no manifest                 -> skip  (staged:false is by design)
//   dev + manifest present            -> report (verify, never quit, bridge
//                                        does NOT arm)
import path from 'node:path';

import {
  loadManifest,
  resolveManifestPath,
  verifyManifest,
  type ManifestFailure,
  type ResourcesManifest,
} from './first-run/manifest-verifier.js';

export interface IntegrityGateInput {
  isPackaged: boolean;
  /** Electron's process.resourcesPath (packaged resources root). */
  resourcesPath?: string;
  /** Repo root for the dev fallback manifest location. */
  repoRoot?: string;
  env?: Record<string, string | undefined>;
}

/** Manifest-derived absolute locations for the packaged→runtime bridge.
 *  Undefined members mean the manifest did not stage that group. */
export interface IntegrityModelDirs {
  engineQuality?: string;
  engineFast?: string;
  embedder?: string;
  reranker?: string;
}

export interface IntegrityGateResult {
  decision: 'pass' | 'block' | 'skip' | 'report';
  failures: ManifestFailure[];
  manifestPath: string | null;
  manifest: ResourcesManifest | null;
  modelDirs: IntegrityModelDirs;
}

function modelFileForEntry(
  manifestDir: string,
  entry: ResourcesManifest['models'][number] | undefined,
  fileNameSuffix: string,
): string | undefined {
  if (entry === undefined) return undefined;
  const file = entry.files.find((f) => f.path.endsWith(fileNameSuffix) && f.required !== false);
  return file === undefined ? undefined : path.join(manifestDir, file.path);
}

function modelDirForGroup(
  manifestDir: string,
  manifest: ResourcesManifest,
  group: string,
): string | undefined {
  const entry = manifest.models.find((m) => m.group === group);
  if (entry === undefined) return undefined;
  // The model dir is defined by the schema (models/<group>/<id>), not by the
  // file paths (a single-file entry would collapse to the file's own parent).
  // Cross-check containment so a malformed entry cannot widen the dir.
  const dir = path.join(manifestDir, 'models', group, entry.id);
  for (const file of entry.files) {
    const abs = path.join(manifestDir, file.path);
    const withSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
    const inside =
      process.platform === 'win32'
        ? abs.toLowerCase().startsWith(withSep.toLowerCase())
        : abs.startsWith(withSep);
    if (!inside) return undefined;
  }
  return dir;
}

/** Derive the bridge locations from a VERIFIED manifest. */
export function deriveModelDirs(manifestDir: string, manifest: ResourcesManifest): IntegrityModelDirs {
  return {
    engineQuality: modelFileForEntry(manifestDir, manifest.models.find((m) => m.group === 'llm-quality'), 'model.gguf'),
    engineFast: modelFileForEntry(manifestDir, manifest.models.find((m) => m.group === 'llm-fast'), 'model.gguf'),
    embedder: modelDirForGroup(manifestDir, manifest, 'embedding'),
    reranker: modelDirForGroup(manifestDir, manifest, 'reranker'),
  };
}

/** One console/dialog line per failure — the specific-file contract. */
export function formatFailure(failure: ManifestFailure): string {
  return `${failure.path}: ${failure.reason} (expected ${failure.expected}, actual ${failure.actual})`;
}

export function runStartupIntegrityCheck(input: IntegrityGateInput): IntegrityGateResult {
  const empty: IntegrityGateResult = {
    decision: 'skip',
    failures: [],
    manifestPath: null,
    manifest: null,
    modelDirs: {},
  };
  const manifestPath = resolveManifestPath({
    env: input.env,
    isPackaged: input.isPackaged,
    resourcesPath: input.resourcesPath,
    repoRoot: input.repoRoot,
  });
  if (manifestPath === null) {
    return input.isPackaged
      ? {
          ...empty,
          decision: 'block',
          failures: [
            {
              path: 'resources/manifest.json',
              reason: 'manifest-unreadable',
              expected: 'a resources manifest at the packaged resources root',
              actual: 'no manifest location could be resolved',
            },
          ],
        }
      : empty;
  }
  let loaded: ReturnType<typeof loadManifest>;
  try {
    loaded = loadManifest(manifestPath);
  } catch (err) {
    const failure: ManifestFailure = {
      path: manifestPath,
      reason: 'manifest-unreadable',
      expected: 'a valid JSON resources manifest',
      actual: err instanceof Error ? err.message : String(err),
    };
    return input.isPackaged ? { ...empty, decision: 'block', failures: [failure], manifestPath } : { ...empty, decision: 'report', failures: [failure], manifestPath };
  }
  if (loaded.manifest === null) {
    // resolveManifestPath named a candidate that does not exist on disk.
    if (!input.isPackaged) return empty;
    const failure: ManifestFailure = {
      path: manifestPath,
      reason: 'manifest-unreadable',
      expected: 'a resources manifest at the packaged resources root',
      actual: 'manifest file is missing from the installed resources',
    };
    return { ...empty, decision: 'block', failures: [failure], manifestPath };
  }
  // The gate verifies the SHIPPED tree only: roots are exactly the manifest's
  // own directory (the packaged resources root). Dev-staged copies under
  // <userData>/models are the wizard's compatibility surface, not the gate's.
  const verify = verifyManifest(loaded.manifest, [path.dirname(manifestPath)]);
  const failures = verify.failures;
  if (failures.length > 0) {
    return input.isPackaged
      ? { decision: 'block', failures, manifestPath, manifest: loaded.manifest, modelDirs: {} }
      : { decision: 'report', failures, manifestPath, manifest: loaded.manifest, modelDirs: {} };
  }
  return input.isPackaged
    ? {
        decision: 'pass',
        failures: [],
        manifestPath,
        manifest: loaded.manifest,
        modelDirs: deriveModelDirs(path.dirname(manifestPath), loaded.manifest),
      }
    : { decision: 'report', failures: [], manifestPath, manifest: loaded.manifest, modelDirs: {} };
}
