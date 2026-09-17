// e2-first-run-wizard.test.ts — E2 acceptance checks for issue #85.
//
// Frozen check subjects: C3 (verify-manifest names a deleted required file),
// C4 (corrupt bytes blocked with expected/actual sha256) and C7 (firstRun.*
// persistence round-trip). Supporting coverage: the C2 backing RAM-gate math,
// drift detection, completion guards (license gate is unskippable), the
// packaged fail-closed rule, and manifest resolution.
//
// All subjects are Electron-free pure modules (desktop/main/first-run/*), so
// the specs run in the plain node vitest environment.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  autoSelectProfile,
  estimateRequiredMemory,
  GGUF_LOAD_OVERHEAD_BYTES,
  KV_CACHE_ESTIMATE_BYTES,
  kvEstimate,
  resolveFreeRamBytes,
} from '../../main/first-run/ram-gate.js';
import {
  containedJoin,
  loadManifest,
  resolveManifestPath,
  verifyManifest,
  type ResourcesManifest,
} from '../../main/first-run/manifest-verifier.js';
import {
  EMPTY_FIRST_RUN_STATE,
  evaluateStatus,
  firstRunStatePathFor,
  loadFirstRunState,
  saveFirstRunState,
  type FirstRunState,
} from '../../main/first-run/first-run-store.js';
import {
  assertCanComplete,
  manifestCompletionState,
  WIZARD_STEPS,
  WizardBlockError,
} from '../../main/first-run/wizard.js';

// ---- temp workspace (windows-safe teardown; no open handles here) ----------

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stage a manifest + one required file; returns the updated manifest object. */
function stageWorkspace(options: { fileBytes: string }): {
  root: string;
  filePath: string;
  manifestPath: string;
  manifest: ResourcesManifest;
} {
  const root = makeTempDir('e2-wizard-');
  const filePath = path.join(root, 'llm', 'gemma-4-e2b-it', 'model.gguf');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, options.fileBytes);
  const manifest: ResourcesManifest = {
    version: '1',
    models: [
      {
        id: 'gemma-4-e2b-it',
        label: 'Quality LLM',
        kind: 'llm',
        group: 'llm-quality',
        files: [{ path: path.join('llm', 'gemma-4-e2b-it', 'model.gguf'), required: true, sha256: sha256(options.fileBytes), sizeBytes: Buffer.byteLength(options.fileBytes) }],
      },
    ],
  };
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, filePath, manifestPath, manifest };
}

// ---- frozen check C3 (AC3) -------------------------------------------------

describe('C3: verify-manifest blocks on a deleted required file and names it', () => {
  it('C3: deleted required file -> failure naming path + expected hash, never generic', () => {
    const workspace = stageWorkspace({ fileBytes: 'quality-model-bytes-v1' });
    const before = verifyManifest(workspace.manifest, [workspace.root]);
    expect(before.ok).toBe(true);

    fs.rmSync(workspace.filePath);

    const result = verifyManifest(workspace.manifest, [workspace.root]);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0];
    expect(failure?.reason).toBe('missing');
    expect(failure?.path).toBe(path.join('llm', 'gemma-4-e2b-it', 'model.gguf'));
    expect(failure?.expected).toContain(sha256('quality-model-bytes-v1'));
    expect(failure?.actual).toBe('missing');
    // The defect class this wizard closes: no free-text generic message.
    expect(failure?.expected).toMatch(/^sha256 [0-9a-f]{64}$/);
  });
});

// ---- frozen check C4 (AC4) -------------------------------------------------

describe('C4: verify-manifest blocks on corrupted bytes with expected vs actual sha256', () => {
  it('C4: mutated bytes -> hash-mismatch with expected and actual sha256', () => {
    const workspace = stageWorkspace({ fileBytes: 'quality-model-bytes-v1' });

    fs.writeFileSync(workspace.filePath, 'quality-model-bytes-CORRUPTED');

    const result = verifyManifest(workspace.manifest, [workspace.root]);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0];
    expect(failure?.reason).toBe('hash-mismatch');
    expect(failure?.expected).toBe(`sha256 ${sha256('quality-model-bytes-v1')}`);
    expect(failure?.actual).toBe(`sha256 ${sha256('quality-model-bytes-CORRUPTED')}`);
    expect(failure?.actual).not.toBe(failure?.expected);
  });
});

// ---- PRR-001 regression: manifest path containment -------------------------

describe('PRR-001: manifest-controlled paths cannot escape their roots', () => {
  it('a traversal file path is a named traversal failure, never read outside the root', () => {
    const root = makeTempDir('e2-traversal-');
    const manifest: ResourcesManifest = {
      version: '1',
      models: [
        {
          id: 'evil',
          files: [
            {
              path: path.join('..', '..', '..', 'Windows', 'System32', 'drivers', 'etc', 'hosts'),
              required: true,
              sha256: sha256('anything'),
            },
          ],
        },
      ],
    };
    const result = verifyManifest(manifest, [root]);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toBe('traversal');
    expect(result.digests).toEqual({});
  });

  it('containedJoin allows safe relatives and refuses escapes', () => {
    const base = path.resolve(makeTempDir('e2-contained-'));
    expect(containedJoin(base, path.join('llm', 'model.gguf'))).toBe(path.join(base, 'llm', 'model.gguf'));
    expect(containedJoin(base, path.join('..', 'elsewhere'))).toBeNull();
    expect(containedJoin(base, 'C:/elsewhere/absolute')).toBeNull();
  });
});

// ---- frozen check C7 (AC7) -------------------------------------------------

describe('C7: firstRun keys persist atomically and round-trip', () => {
  it('C7: completed/selectedProfile/completedAt round-trip a reload', () => {
    const root = makeTempDir('e2-store-');
    const storePath = path.join(root, 'store.sqlite');

    const before = loadFirstRunState(storePath);
    expect(before.firstRun.completed).toBe(false);

    saveFirstRunState(storePath, {
      firstRun: {
        completed: true,
        selectedProfile: 'quality',
        completedAt: '2026-09-17T12:00:00.000Z',
        acknowledgedLicenses: true,
        manifestDigests: { 'llm/gemma-4-e2b-it/model.gguf': 'abc'.padEnd(64, '0') },
      },
    });

    const after = loadFirstRunState(storePath);
    expect(after.firstRun.completed).toBe(true);
    expect(after.firstRun.selectedProfile).toBe('quality');
    expect(after.firstRun.completedAt).toBe('2026-09-17T12:00:00.000Z');
    expect(after.firstRun.acknowledgedLicenses).toBe(true);
    expect(after.firstRun.manifestDigests['llm/gemma-4-e2b-it/model.gguf']).toBeDefined();
    // The sidecar lives beside the store (profile dir), named first-run.json.
    expect(firstRunStatePathFor(storePath)).toBe(path.join(root, 'first-run.json'));
    // No tmp residue after a successful atomic save.
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
  });

  it('C7: corrupt sidecar degrades to defaults (never fatal)', () => {
    const root = makeTempDir('e2-store-');
    const storePath = path.join(root, 'store.sqlite');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(firstRunStatePathFor(storePath), '{not json');
    const state = loadFirstRunState(storePath);
    expect(state.firstRun.completed).toBe(false);
    expect(state.firstRun.selectedProfile).toBe('fast');
  });
});

// ---- C2 backing math (AC2) -------------------------------------------------

describe('C2 backing: RAM-gate math and auto-selection', () => {
  it('estimateRequiredMemory matches the A3 formula (file + 1GiB KV + 1GiB overhead)', () => {
    expect(kvEstimate(8192)).toBe(KV_CACHE_ESTIMATE_BYTES);
    expect(KV_CACHE_ESTIMATE_BYTES).toBe(1024 ** 3);
    expect(GGUF_LOAD_OVERHEAD_BYTES).toBe(1024 ** 3);
    const qualityBytes = Math.round(3.85 * 1024 ** 3);
    const required = estimateRequiredMemory(qualityBytes, 8192);
    expect(required).toBe(qualityBytes + KV_CACHE_ESTIMATE_BYTES + GGUF_LOAD_OVERHEAD_BYTES);
    // The A3 acceptance bound: the ~5.85 GiB requirement fits 8 GiB free.
    expect(required).toBeLessThan(8 * 1024 ** 3);
  });

  it('autoSelectProfile keeps quality when it fits, downgrades to fast with numbers otherwise', () => {
    const qualityBytes = Math.round(3.85 * 1024 ** 3);
    const fits = autoSelectProfile({
      freeBytes: 16 * 1024 ** 3,
      nCtx: 8192,
      qualityFileBytes: qualityBytes,
      fastFileBytes: Math.round(0.7 * 1024 ** 3),
    });
    expect(fits.profile).toBe('quality');
    expect(fits.warning).toBeUndefined();

    const lowRam = autoSelectProfile({
      freeBytes: 4 * 1024 ** 3,
      nCtx: 8192,
      qualityFileBytes: qualityBytes,
      fastFileBytes: Math.round(0.7 * 1024 ** 3),
    });
    expect(lowRam.profile).toBe('fast');
    expect(lowRam.warning).toBeDefined();
    expect(lowRam.warning?.detail).toContain(String(estimateRequiredMemory(qualityBytes, 8192)));
    expect(lowRam.warning?.detail).toContain(String(4 * 1024 ** 3));
    expect(lowRam.warning?.requiredBytes).toBeGreaterThan(4 * 1024 ** 3);
  });

  it('resolveFreeRamBytes honors the documented dev/test seam', () => {
    expect(resolveFreeRamBytes({ TRAININGAPP_DESKTOP_FREE_RAM_BYTES: '5368709120' })).toBe(5 * 1024 ** 3);
    // Junk falls back to os.freemem (positive, sane).
    const fallback = resolveFreeRamBytes({ TRAININGAPP_DESKTOP_FREE_RAM_BYTES: 'not-a-number' });
    expect(fallback).toBeGreaterThan(0);
  });
});

// ---- drift + completion guards ---------------------------------------------

describe('drift detection (AC6 logic) and completion guards (AC5 logic)', () => {
  const completedState = (digests: Record<string, string>): FirstRunState => ({
    firstRun: {
      completed: true,
      selectedProfile: 'quality',
      completedAt: '2026-09-17T12:00:00.000Z',
      acknowledgedLicenses: true,
      manifestDigests: digests,
    },
  });

  it('mutating a covered file flips needed=true with reason=drift', () => {
    const state = completedState({ 'llm/model.gguf': 'old-digest' });
    expect(evaluateStatus(state, { forced: false, manifestDigests: { 'llm/model.gguf': 'new-digest' } })).toEqual({
      needed: true,
      reason: 'drift',
    });
    expect(evaluateStatus(state, { forced: false, manifestDigests: { 'llm/model.gguf': 'old-digest' } })).toEqual({
      needed: false,
      reason: 'complete',
    });
  });

  it('an absent manifest never fabricates drift; an unfinished run is not-completed', () => {
    expect(
      evaluateStatus(completedState({ 'llm/model.gguf': 'old-digest' }), { forced: false, manifestDigests: null }),
    ).toEqual({ needed: false, reason: 'complete' });
    expect(evaluateStatus(EMPTY_FIRST_RUN_STATE(), { forced: false, manifestDigests: null })).toEqual({
      needed: true,
      reason: 'not-completed',
    });
    expect(evaluateStatus(completedState({}), { forced: true, manifestDigests: null })).toEqual({
      needed: true,
      reason: 'reset',
    });
  });

  it('drift outranks the force seam (the force flag opens the wizard; drift names the reason)', () => {
    expect(
      evaluateStatus(completedState({ 'llm/model.gguf': 'old-digest' }), {
        forced: true,
        manifestDigests: { 'llm/model.gguf': 'new-digest' },
      }),
    ).toEqual({ needed: true, reason: 'drift' });
  });

  it('assertCanComplete refuses without license acknowledgment (unskippable gate)', () => {
    expect(() =>
      assertCanComplete({
        selectedProfile: 'quality',
        acknowledgedLicenses: false,
        manifestOk: true,
        inactiveRequiredPacks: [],
      }),
    ).toThrow(WizardBlockError);
    try {
      assertCanComplete({
        selectedProfile: 'quality',
        acknowledgedLicenses: false,
        manifestOk: true,
        inactiveRequiredPacks: [],
      });
    } catch (err) {
      expect((err as WizardBlockError).reason).toBe('licenses-not-acknowledged');
      expect((err as Error).message).toContain('licensing-notices');
    }
  });

  it('assertCanComplete refuses on failed verification and inactive required packs', () => {
    expect(() =>
      assertCanComplete({
        selectedProfile: 'fast',
        acknowledgedLicenses: true,
        manifestOk: false,
        inactiveRequiredPacks: [],
      }),
    ).toThrow(/verify-manifest/);
    expect(() =>
      assertCanComplete({
        selectedProfile: 'fast',
        acknowledgedLicenses: true,
        manifestOk: true,
        inactiveRequiredPacks: ['bundled-docs'],
      }),
    ).toThrow(/bundled-docs/);
    // The happy path: every gate satisfied.
    expect(() =>
      assertCanComplete({
        selectedProfile: 'fast',
        acknowledgedLicenses: true,
        manifestOk: true,
        inactiveRequiredPacks: [],
      }),
    ).not.toThrow();
  });

  it('manifestCompletionState: packaged-without-manifest fails closed; dev-absent is N/A', () => {
    expect(manifestCompletionState({ packaged: true, staged: false, failureCount: 0 })).toBe(false);
    expect(manifestCompletionState({ packaged: true, staged: true, failureCount: 2 })).toBe(false);
    expect(manifestCompletionState({ packaged: true, staged: true, failureCount: 0 })).toBe(true);
    expect(manifestCompletionState({ packaged: false, staged: false, failureCount: 0 })).toBeNull();
  });
});

// ---- manifest resolution ----------------------------------------------------

describe('manifest resolution and loader', () => {
  it('resolveManifestPath: env override wins; packaged uses resources; dev uses repo root', () => {
    expect(
      resolveManifestPath({
        env: { TRAININGAPP_DESKTOP_MANIFEST: '/custom/manifest.json' },
        isPackaged: true,
        resourcesPath: '/res',
        repoRoot: '/repo',
      }),
    ).toBe(path.resolve('/custom/manifest.json'));
    expect(resolveManifestPath({ env: {}, isPackaged: true, resourcesPath: '/res', repoRoot: '/repo' })).toBe(
      path.join('/res', 'manifest.json'),
    );
    expect(resolveManifestPath({ env: {}, isPackaged: false, repoRoot: '/repo' })).toBe(
      path.join('/repo', 'resources', 'manifest.json'),
    );
  });

  it('loadManifest: absent path is staged:null (not an error); malformed manifest throws', () => {
    expect(loadManifest(null).manifest).toBeNull();
    const missing = path.join(makeTempDir('e2-manifest-'), 'none.json');
    expect(loadManifest(missing).manifest).toBeNull();

    const root = makeTempDir('e2-manifest-');
    const bad = path.join(root, 'manifest.json');
    fs.writeFileSync(bad, '{"models": "not-an-array"}');
    expect(() => loadManifest(bad)).toThrow(/resources manifest/);
  });

  it('a required file without a manifest sha256 is a schema failure, not a silent skip', () => {
    const root = makeTempDir('e2-wizard-');
    const manifest: ResourcesManifest = {
      version: '1',
      models: [{ id: 'm', files: [{ path: 'x.bin', required: true }] }],
    };
    const result = verifyManifest(manifest, [root]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toBe('sha256-required');
  });

  it('the pinned step order matches the issue state machine', () => {
    expect(WIZARD_STEPS).toEqual([
      'detect-hardware',
      'select-profile',
      'verify-manifest',
      'activate-packs',
      'licensing-notices',
      'complete',
    ]);
  });
});
