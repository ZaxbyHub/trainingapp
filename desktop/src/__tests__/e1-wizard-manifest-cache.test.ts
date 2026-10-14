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
});
