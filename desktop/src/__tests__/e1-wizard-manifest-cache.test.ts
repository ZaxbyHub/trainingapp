// e1-wizard-manifest-cache.test.ts — issue #131 item 3 (PRR-123) frozen
// check: the extracted, cacheable wizard-manifest loader.
//
// Subject: desktop/main/first-run/wizard-manifest.ts — the NEW module the fix
// extracts from the wizardManifest() closure in desktop/main/index.ts:664-691
// (which re-runs loadManifest + verifyManifest, a full streaming-sha256 pass
// over every required file, on EVERY call). Contract pinned by this spec:
//   createWizardManifest(opts) with
//     opts = { isPackaged: boolean; resourcesPath?: string; repoRoot?: string;
//              userDataPath: string; env?: Record<string, string | undefined> }
//   returns { wizardManifest(call?: { fresh?: boolean }) } whose result shape
//   is IDENTICAL to today's closure: { staged, manifestPath, manifest, verify,
//   loadError }, with verify roots [manifestDir, path.join(userDataPath,
//   'models')] exactly as the closure computes them.
//
// Cache contract pinned (the three discriminating behaviors):
//   1. two sequential non-fresh calls against an UNCHANGED manifest (same
//      mtime) return the cached result — proven by mutating a verified file's
//      content after call 1 WITHOUT touching the manifest: the second
//      non-fresh call must still report clean (an uncached implementation
//      would report a hash-mismatch failure);
//   2. { fresh: true } after the same mutation must re-verify and REPORT the
//      failure (the completion-time TOCTOU re-verify stays a real pass);
//   3. changing the manifest file's mtime alone invalidates the cache entry.
//
// RED at base — desktop/main/first-run/wizard-manifest.ts does not exist, so
// this spec fails at import. GREEN after the fix implements the factory.
// Mutation sensitivities for the Phase 4.5 probe: removing the cache fails
// case 1; removing the fresh bypass fails case 2; keying without mtime fails
// case 3.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWizardManifest } from '../../main/first-run/wizard-manifest.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Stage {
  stage: string;
  manifestPath: string;
  /** Manifest-relative path of the one required, verified model file. */
  rel: string;
  abs: string;
  sha: string;
  original: Buffer;
}

/** A minimal staged resources tree: manifest.json + one verified file. */
function buildStage(prefix: string): Stage {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(stage);
  const rel = 'models/embedding/emb-fx/tokenizer.json';
  const abs = path.join(stage, 'models', 'embedding', 'emb-fx', 'tokenizer.json');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const original = randomBytes(8192);
  fs.writeFileSync(abs, original);
  const sha = createHash('sha256').update(original).digest('hex');
  const manifestPath = path.join(stage, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      version: '1',
      models: [
        {
          id: 'emb-fx',
          group: 'embedding',
          files: [{ path: rel, required: true, sha256: sha, sizeBytes: original.length }],
        },
      ],
    }),
  );
  return { stage, manifestPath, rel, abs, sha, original };
}

/** The factory over a packaged-shaped stage (env override absent). */
function factoryFor(s: Stage): ReturnType<typeof createWizardManifest> {
  return createWizardManifest({
    isPackaged: true,
    resourcesPath: s.stage,
    userDataPath: path.join(s.stage, 'user-data'),
    env: {},
  });
}

/** Rewrite the verified file with DIFFERENT bytes (hash + size drift) while
 *  leaving manifest.json — and therefore the cache key's mtime — untouched. */
function mutateVerifiedFile(s: Stage): void {
  fs.writeFileSync(s.abs, Buffer.concat([randomBytes(1024), s.original.subarray(0, 4096)]));
}

describe('e1 wizard-manifest cache (issue #131 item 3)', () => {
  it('returns the closure result shape for a staged, cleanly verified manifest', () => {
    const s = buildStage('131-wiz-shape-');
    const w = factoryFor(s);
    const r = w.wizardManifest();
    expect(r.staged).toBe(true);
    expect(r.manifestPath).toBe(path.join(s.stage, 'manifest.json'));
    expect(r.manifest).not.toBeNull();
    expect(r.loadError).toBeNull();
    expect(r.verify?.ok).toBe(true);
    expect(r.verify?.failures).toEqual([]);
    expect(r.verify?.verifiedCount).toBe(1);
    expect(r.verify?.digests[s.rel]).toBe(s.sha);
  });

  it('reports staged:false with null manifest/verify when no manifest exists', () => {
    const s = buildStage('131-wiz-absent-');
    fs.rmSync(s.manifestPath);
    const w = factoryFor(s);
    const r = w.wizardManifest();
    expect(r).toEqual({
      staged: false,
      manifestPath: path.join(s.stage, 'manifest.json'),
      manifest: null,
      verify: null,
      loadError: null,
    });
  });

  it('cache hit: a post-verify file mutation with an UNCHANGED manifest mtime is invisible to the next non-fresh call', () => {
    const s = buildStage('131-wiz-cache-');
    const w = factoryFor(s);
    const first = w.wizardManifest();
    expect(first.verify?.ok).toBe(true);
    mutateVerifiedFile(s);
    const second = w.wizardManifest();
    // Cache hit: same (manifestPath, mtime) key => the cached CLEAN verdict.
    // An uncached implementation would re-hash and see the drift.
    expect(second.staged).toBe(true);
    expect(second.verify?.ok).toBe(true);
    expect(second.verify?.failures).toEqual([]);
    expect(second.verify?.digests[s.rel]).toBe(s.sha);
  });

  it('fresh bypass: the same mutation IS detected by a fresh call (TOCTOU preserved)', () => {
    const s = buildStage('131-wiz-fresh-');
    const w = factoryFor(s);
    expect(w.wizardManifest().verify?.ok).toBe(true);
    mutateVerifiedFile(s);
    const fresh = w.wizardManifest({ fresh: true });
    expect(fresh.staged).toBe(true);
    expect(fresh.verify?.ok).toBe(false);
    expect(fresh.verify?.failures).toHaveLength(1);
    expect(fresh.verify?.failures[0]?.path).toBe(s.rel);
    expect(['hash-mismatch', 'size-mismatch']).toContain(fresh.verify?.failures[0]?.reason);
  });

  it('a manifest mtime change alone invalidates the cached result', () => {
    const s = buildStage('131-wiz-mtime-');
    const w = factoryFor(s);
    expect(w.wizardManifest().verify?.ok).toBe(true);
    mutateVerifiedFile(s);
    // Still cached (unchanged key): clean.
    expect(w.wizardManifest().verify?.ok).toBe(true);
    // Bump ONLY the manifest file's mtime — the file tree is untouched since
    // the mutation above, so any result change is caused by key invalidation.
    const bumped = new Date(Date.now() + 10_000);
    fs.utimesSync(s.manifestPath, bumped, bumped);
    const r = w.wizardManifest();
    expect(r.verify?.ok).toBe(false);
    expect(r.verify?.failures[0]?.path).toBe(s.rel);
    expect(['hash-mismatch', 'size-mismatch']).toContain(r.verify?.failures[0]?.reason);
  });

  // ---- Acceptance checks: a cached verify FAILURE must not outlive the
  // on-disk repair it describes. The cache admits every result whose
  // loadError === null — including results with non-empty verify.failures —
  // so a non-fresh call on an UNCHANGED manifest keeps serving the stale
  // failure after the underlying file has been repaired. Cases 1-3 below are
  // RED at base; case 4 pins the existing fresh-refresh behavior (GREEN at
  // base). All four leave manifest.json untouched between calls, so the cache
  // key (manifestPath, mtimeMs) never changes.

  it('cached-verify-failure-not-served: repairing wrong file bytes is visible to the next non-fresh call', () => {
    const s = buildStage('131-wiz-fixmismatch-');
    const w = factoryFor(s);
    mutateVerifiedFile(s); // wrong bytes (hash drift); manifest mtime untouched
    const first = w.wizardManifest();
    expect(first.staged).toBe(true);
    expect(first.loadError).toBeNull();
    expect(first.verify?.ok).toBe(false);
    expect(first.verify?.failures).toHaveLength(1);
    expect(first.verify?.failures[0]?.path).toBe(s.rel);
    expect(['hash-mismatch', 'size-mismatch']).toContain(first.verify?.failures[0]?.reason);
    // Repair: restore the exact original bytes. The manifest is untouched, so
    // the cache key is unchanged — the next non-fresh call must NOT be served
    // the cached failure verdict from call 1.
    fs.writeFileSync(s.abs, s.original);
    const second = w.wizardManifest();
    expect(second.verify?.ok).toBe(true);
    expect(second.verify?.failures).toEqual([]);
    expect(second.verify?.digests[s.rel]).toBe(s.sha);
  });

  it('missing-then-staged: creating a previously missing required file is visible to the next non-fresh call', () => {
    const s = buildStage('131-wiz-missing-');
    fs.rmSync(s.abs); // required file absent; manifest present + unchanged
    const w = factoryFor(s);
    const first = w.wizardManifest();
    expect(first.staged).toBe(true);
    expect(first.loadError).toBeNull();
    expect(first.verify?.ok).toBe(false);
    expect(first.verify?.failures).toHaveLength(1);
    expect(first.verify?.failures[0]?.path).toBe(s.rel);
    expect(first.verify?.failures[0]?.reason).toBe('missing');
    // Stage the file with the manifest-declared bytes; the manifest mtime is
    // untouched, so the key is unchanged and call 2 must see the repair.
    fs.writeFileSync(s.abs, s.original);
    const second = w.wizardManifest();
    expect(second.verify?.ok).toBe(true);
    expect(second.verify?.failures).toEqual([]);
    expect(second.verify?.verifiedCount).toBe(1);
  });

  it('unreadable-then-readable: replacing an unreadable path (directory) with valid bytes is visible to the next non-fresh call', () => {
    const s = buildStage('131-wiz-unreadable-');
    // A directory at the file's path is the deterministic cross-platform way
    // to make the read/hash fail (openSync on a directory throws EPERM on
    // Windows / EISDIR elsewhere) without chmod games: the path passes
    // existsSync, then sha256File throws and the verifier pushes a failure
    // with reason 'unreadable' — loadError stays null, so it caches.
    fs.rmSync(s.abs);
    fs.mkdirSync(s.abs);
    const w = factoryFor(s);
    const first = w.wizardManifest();
    expect(first.staged).toBe(true);
    expect(first.loadError).toBeNull();
    expect(first.verify?.ok).toBe(false);
    expect(first.verify?.failures).toHaveLength(1);
    expect(first.verify?.failures[0]?.path).toBe(s.rel);
    expect(first.verify?.failures[0]?.reason).toBe('unreadable');
    // Repair: remove the directory and stage the valid file.
    fs.rmSync(s.abs, { recursive: true });
    fs.writeFileSync(s.abs, s.original);
    const second = w.wizardManifest();
    expect(second.verify?.ok).toBe(true);
    expect(second.verify?.failures).toEqual([]);
    expect(second.verify?.digests[s.rel]).toBe(s.sha);
  });

  it('fresh-then-non-fresh-returns-fresh: the next non-fresh call reports the fresh pass verdict after the staged bytes diverge', () => {
    const s = buildStage('131-wiz-f2nf-');
    const w = factoryFor(s);
    const first = w.wizardManifest();
    expect(first.verify?.ok).toBe(true);
    // Diverge the staged bytes (manifest mtime preserved) BEFORE the fresh
    // pass, so call 1's cached result and the fresh pass's result DISAGREE:
    // the fresh pass detects the drift (verify.ok false), call 1 cached the
    // clean verdict. The subsequent non-fresh call must serve the FRESH
    // pass's result: if the fresh pass did not refresh the cache, this
    // would return call 1's clean result and fail. (Dropping the cache
    // entirely recomputes the same drifted state and is killed by the
    // UNCHANGED-manifest-mtime case instead.)
    mutateVerifiedFile(s);
    const fresh = w.wizardManifest({ fresh: true });
    expect(fresh.verify?.ok, 'harness sanity: the fresh pass detects the drift').toBe(false);
    const second = w.wizardManifest();
    expect(second.verify?.ok).toBe(fresh.verify?.ok);
    expect(second.verify?.digests[s.rel]).toBe(fresh.verify?.digests[s.rel]);
  });
});
