// E1/E2 wizard manifest access (issue #131 item 3, PRR-123): extracted from
// the wizardManifest() closure that lived in desktop/main/index.ts so the
// verify pass can be CACHED per (manifestPath, mtime) in the long-lived main
// process. verifyManifest runs a full streaming-sha256 pass over every
// required file (~2.4 s over the staged tree — bench/RESULTS.md E1), and the
// closure re-ran it at every call site: boot push, every first-run status
// invocation, activate-packs, and TWICE inside the complete handler.
//
// Contract (frozen spec e1-wizard-manifest-cache.test.ts):
//   - result shape identical to the old closure: {staged, manifestPath,
//     manifest, verify, loadError};
//   - verify roots exactly [manifestDir, <userData>/models];
//   - `env` read per call when options.env is omitted (closure fidelity for
//     TRAININGAPP_DESKTOP_MANIFEST changes mid-session);
//   - cache keyed (manifestPath, manifest mtimeMs): a non-fresh call on an
//     unchanged manifest returns the cached verify result WITHOUT re-hashing;
//     `{fresh: true}` re-verifies and refreshes the cache — the
//     completion-time TOCTOU re-verify stays a real pass, and the digest
//     capture right after it reads that same fresh result instead of paying
//     a second hash.
//
// Deliberate staleness window: a verified file mutated WITHOUT the manifest
// changing is only re-detected by the next fresh call (completion) — the
// trade the issue itself specifies (status/activate paths save the pass,
// completion keeps the TOCTOU guarantee).
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  loadManifest,
  resolveManifestPath,
  verifyManifest,
  type ResourcesManifest,
  type VerifyResult,
} from './manifest-verifier.js';

export interface WizardManifestResult {
  staged: boolean;
  manifestPath: string | null;
  manifest: ResourcesManifest | null;
  verify: VerifyResult | null;
  loadError: string | null;
}

export interface CreateWizardManifestOptions {
  isPackaged: boolean;
  /** Electron's process.resourcesPath for packaged builds. */
  resourcesPath?: string;
  /** Repo root for the dev fallback manifest location. */
  repoRoot?: string;
  userDataPath: string;
  /** Omitted => process.env is read on EACH call (closure fidelity). */
  env?: Record<string, string | undefined>;
}

export function createWizardManifest(options: CreateWizardManifestOptions): {
  wizardManifest(call?: { fresh?: boolean }): WizardManifestResult;
} {
  let cached: { key: string; result: WizardManifestResult } | null = null;

  /** The uncached load+verify — the old closure's body, unchanged. */
  const compute = (manifestPath: string): WizardManifestResult => {
    const manifestDir = path.dirname(manifestPath);
    try {
      const { manifest } = loadManifest(manifestPath);
      const verify =
        manifest === null
          ? null
          : verifyManifest(manifest, [manifestDir, path.join(options.userDataPath, 'models')]);
      return { staged: manifest !== null, manifestPath, manifest, verify, loadError: null };
    } catch (err) {
      return {
        staged: true,
        manifestPath,
        manifest: null,
        verify: null,
        loadError: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const wizardManifest = (call?: { fresh?: boolean }): WizardManifestResult => {
    const env = options.env ?? process.env;
    const manifestPath = resolveManifestPath({
      env,
      isPackaged: options.isPackaged,
      resourcesPath: options.resourcesPath,
      repoRoot: options.repoRoot,
    });
    if (manifestPath === null || !existsSync(manifestPath)) {
      // staged:false is NOT an error — dev/CI trees and pre-E1 packaged
      // builds have none; the fail-closed decision belongs to the caller.
      return { staged: false, manifestPath, manifest: null, verify: null, loadError: null };
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(manifestPath).mtimeMs;
    } catch {
      // Deleted between existsSync and stat: fall through to compute, which
      // reproduces the old closure's loadManifest throw -> loadError result.
      return compute(manifestPath);
    }
    const key = JSON.stringify([manifestPath, mtimeMs]);
    if (call?.fresh !== true && cached !== null && cached.key === key) {
      return cached.result;
    }
    const result = compute(manifestPath);
    cached = { key, result };
    return result;
  };

  return { wizardManifest };
}
