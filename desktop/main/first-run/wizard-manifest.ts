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
//   - `env` read per call when options.env is omitted (fidelity for the
//     TRAININGAPP_DESKTOP_MANIFEST override; note repoRoot is captured once
//     at construction — a mid-session TRAININGAPP_DESKTOP_REPO_ROOT change
//     does not re-resolve, unlike the old closure);
//   - cache keyed (manifestPath, manifest mtimeMs): a non-fresh call on an
//     unchanged manifest returns the cached CLEAN verify result WITHOUT
//     re-hashing; `{fresh: true}` re-verifies and refreshes the cache — the
//     completion-time TOCTOU re-verify stays a real pass, and the digest
//     capture right after it reads that same fresh result instead of paying
//     a second hash.
//
// Deliberate staleness window: a verified file mutated WITHOUT the manifest
// changing is only re-detected by the next fresh call (completion) — the
// trade the issue itself specifies (status/activate paths save the pass,
// completion keeps the TOCTOU guarantee). The consumer consequence: the
// drift re-check in evaluateStatus compares stored digests against these
// cached digests, so within one process it cannot surface such a mutation;
// the startup integrity gate re-verifies at every launch and the completion
// handler re-verifies on every wizard completion. Results that are not
// CLEAN are never cached, and evict any cached entry under the current key
// (see wizardManifest below): a transient loadError (EBUSY/EPERM/EMFILE on
// Windows while an installer copy is in flight) recovers on the next status
// call exactly as the uncached closure did (PRR-003), and a FAILED verify
// (missing/unreadable/digest-mismatch) re-verifies on every non-fresh call
// until repaired, so a repaired tree converges instead of wedging the
// wizard behind a cached failure (issue #175; cost: the ~2.4s staged-tree
// hash pass repeats per status call while the failure persists).
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
      // Deleted between existsSync and stat: loadManifest re-guards with its
      // own existsSync and returns {manifest: null}, so compute() yields the
      // same staged:false/loadError:null shape the old closure produced in
      // this race — deliberately NOT cached, so a restored file recomputes.
      return compute(manifestPath);
    }
    const key = JSON.stringify([manifestPath, mtimeMs]);
    if (call?.fresh !== true && cached !== null && cached.key === key) {
      return cached.result;
    }
    const result = compute(manifestPath);
    // A loadError result (transient read failure: EBUSY/EPERM/EMFILE on
    // Windows while an installer copy is in flight) is NOT cached: the old
    // uncached closure recovered on the next status call, and latching a
    // transient error under an unchanged mtime would block the wizard until
    // restart (PRR-003).
    //
    // Issue #175: a result with verify FAILURES is not admitted either, and
    // evicts any cached entry under the current key. verifyManifest reports
    // missing/unreadable/digest-mismatch as failures with loadError ===
    // null, so this admission predicate decides whether a repaired tree
    // converges: repair does not touch the manifest mtime, so a cached
    // failure would keep failing the status handler — which disables the
    // wizard's Complete button — while the only fresh caller is the
    // completion handler, unreachable from the UI in exactly that state.
    // Eviction (not skip) matters when a fresh pass observes a drift that
    // contradicts a previously cached clean result: serving the stale clean
    // verdict would hide the failure the operator must see (plan-critic
    // round 2, R2-1; pinned by the frozen C13 case).
    const cleanResult =
      result.loadError === null &&
      (result.verify === null || result.verify.failures.length === 0);
    cached = cleanResult ? { key, result } : null;
    return result;
  };

  return { wizardManifest };
}
