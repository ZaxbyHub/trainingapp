// e1-wizard-manifest-hardening.test.ts — swarm-pr-review follow-ups on PR #172
// (PRR-003/032/034/035). Complements the FROZEN cache spec (whose bytes are
// checkpoint-bound) with the gaps the review confirmed: fresh must REFRESH
// the cache entry, transient loadError results must NOT be latched, the
// loadError branch shape is pinned, and the second verify root
// (<userData>/models) participates in verification. New file on purpose —
// never edit the frozen spec files.
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

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Stage { stage: string; manifestPath: string; rel: string; abs: string; sha: string; original: Buffer; userDataPath: string }

function buildStage(prefix: string, fileUnder: 'manifestDir' | 'userDataModels' = 'manifestDir'): Stage {
  const stage = makeDir(prefix);
  const userDataPath = path.join(stage, 'user-data');
  const rel = fileUnder === 'manifestDir' ? 'models/embedding/emb-fx/tokenizer.json' : 'models/embedding/emb-fx/tokenizer.json';
  // root2 semantics (pre-existing, verbatim from the old closure): the
  // manifest-relative path joins under <userData>/models — a staged copy
  // mirrors the full manifest tree there.
  const abs = fileUnder === 'manifestDir'
    ? path.join(stage, 'models', 'embedding', 'emb-fx', 'tokenizer.json')
    : path.join(userDataPath, 'models', 'models', 'embedding', 'emb-fx', 'tokenizer.json');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const original = randomBytes(8192);
  fs.writeFileSync(abs, original);
  const sha = createHash('sha256').update(original).digest('hex');
  const manifestPath = path.join(stage, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: '1',
    models: [{ id: 'emb-fx', group: 'embedding', files: [{ path: rel, required: true, sha256: sha, sizeBytes: original.length }] }],
  }));
  return { stage, manifestPath, rel, abs, sha, original, userDataPath };
}

function factoryFor(s: Stage): ReturnType<typeof createWizardManifest> {
  return createWizardManifest({ isPackaged: true, resourcesPath: s.stage, userDataPath: s.userDataPath, env: {} });
}

function mutate(abs: string, original: Buffer): void {
  fs.writeFileSync(abs, Buffer.concat([randomBytes(1024), original.subarray(0, 4096)]));
}

describe('e1 wizard-manifest hardening (PR #172 review)', () => {
  it('PRR-032: a fresh call REFRESHES the cache entry (the next non-fresh call sees the fresh verdict)', () => {
    const s = buildStage('131-hard-refresh-');
    const w = factoryFor(s);
    expect(w.wizardManifest().verify?.ok).toBe(true);
    mutate(s.abs, s.original);
    const fresh = w.wizardManifest({ fresh: true });
    expect(fresh.verify?.ok).toBe(false);
    // Without the refresh write, this non-fresh call would return the stale
    // CLEAN entry; with it, the fresh failure verdict is what is cached.
    const after = w.wizardManifest();
    expect(after.verify?.ok).toBe(false);
    expect(after.verify?.failures[0]?.path).toBe(s.rel);
  });

  it('PRR-003: a transient loadError result is NOT latched (the next non-fresh call recovers at the same mtime)', () => {
    const s = buildStage('131-hard-loaderr-');
    // Pin the manifest mtime to an exact millisecond Date BEFORE the broken
    // call, so the cache key is deterministic (mtimeMs is a float; restoring
    // a sub-millisecond value through Date would silently change the key and
    // make this test vacuous).
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.writeFileSync(s.manifestPath, '{ this is not json');
    fs.utimesSync(s.manifestPath, pinned, pinned);
    const keyMtime = fs.statSync(s.manifestPath).mtimeMs;
    const w = factoryFor(s);
    const broken = w.wizardManifest();
    expect(broken.staged).toBe(true);
    expect(broken.loadError).not.toBeNull();
    expect(broken.manifest).toBeNull();
    // Restore VALID content and the SAME pinned mtime: if the broken result
    // had been latched under (path, mtime), this call would keep returning
    // the error forever.
    fs.writeFileSync(s.manifestPath, JSON.stringify({
      version: '1',
      models: [{ id: 'emb-fx', group: 'embedding', files: [{ path: s.rel, required: true, sha256: s.sha, sizeBytes: s.original.length }] }],
    }));
    fs.utimesSync(s.manifestPath, pinned, pinned);
    expect(fs.statSync(s.manifestPath).mtimeMs).toBe(keyMtime);
    const recovered = w.wizardManifest();
    expect(recovered.loadError).toBeNull();
    expect(recovered.verify?.ok).toBe(true);
  });

  it('PRR-034: the loadError branch shape is pinned (malformed manifest -> staged:true + message + null manifest/verify)', () => {
    const s = buildStage('131-hard-shape-');
    fs.writeFileSync(s.manifestPath, ']]]');
    const r = factoryFor(s).wizardManifest();
    expect(r.staged).toBe(true);
    expect(typeof r.loadError).toBe('string');
    expect(r.loadError).toContain('JSON');
    expect(r.manifest).toBeNull();
    expect(r.verify).toBeNull();
  });

  it('PRR-035: the second verify root <userData>/models participates (file resolves there and its mutation is detected)', () => {
    const s = buildStage('131-hard-u/proot-'.replace('/', ''), 'userDataModels');
    const w = factoryFor(s);
    const first = w.wizardManifest();
    expect(first.verify?.ok).toBe(true);
    expect(first.verify?.digests[s.rel]).toBe(s.sha);
    mutate(s.abs, s.original);
    const fresh = w.wizardManifest({ fresh: true });
    expect(fresh.verify?.ok).toBe(false);
    expect(fresh.verify?.failures[0]?.path).toBe(s.rel);
  });
});
