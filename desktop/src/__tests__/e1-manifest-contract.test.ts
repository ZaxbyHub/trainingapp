// e1-manifest-contract.test.ts — E1 acceptance checks for issue #84.
//
// Frozen check subjects: C2 (the generated resources/manifest.json loads and
// verifies clean through the E2 verifier with sha256/sizeBytes on every
// required file, packs[] entries per the #68-derived shape, and the
// packEntryDir resolution contract). Provenance anchors — the frozen drivers
// .agents/issue-traces/84-package-models-integrity-manifest/repro/check-C2.sh
// (+ c4_fixture.py / c4_verify.py / c5_sneaky.py) replay this spec.
//
// All subjects are Electron-free (node script + desktop/main/first-run/*
// modules), so the spec runs in the plain node vitest environment.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { containedJoin, loadManifest, verifyManifest, type ManifestFailure } from '../../main/first-run/manifest-verifier.js';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATOR = path.join(desktopDir, 'scripts', 'build-installer-manifest.mjs');

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

function writeStageFile(stage: string, rel: string, bytes: number): string {
  const abs = path.join(stage, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, randomBytes(bytes));
  return abs;
}

/** A small contract-shaped stage: 4 model groups, one pack, docs. */
function buildFixtureStage(stage: string): void {
  writeStageFile(stage, 'models/embedding/dummy-emb/onnx/model.onnx', 64 * 1024);
  writeStageFile(stage, 'models/embedding/dummy-emb/tokenizer.json', 2048);
  writeStageFile(stage, 'models/reranker/dummy-rn/onnx/model_quantized.onnx', 32 * 1024);
  writeStageFile(stage, 'models/llm-quality/dummy-lq/model.gguf', 128 * 1024);
  writeStageFile(stage, 'models/llm-fast/dummy-lf/model.gguf', 64 * 1024);
  fs.mkdirSync(path.join(stage, 'packs', 'bundled-docs', 'dummy-pack-1.0.0'), { recursive: true });
  fs.writeFileSync(
    path.join(stage, 'packs', 'bundled-docs', 'dummy-pack-1.0.0', 'pack.json'),
    '{\n  "id": "dummy-pack",\n  "version": "1.0.0",\n  "name": "Dummy",\n  "source_class": "bundled"\n}\n',
  );
  fs.mkdirSync(path.dirname(path.join(stage, 'packs', 'bundled-docs', 'dummy-pack-1.0.0', 'docs', 'a.json')), { recursive: true });
  fs.writeFileSync(path.join(stage, 'packs', 'bundled-docs', 'dummy-pack-1.0.0', 'docs', 'a.json'), '{"doc":true}');
  fs.mkdirSync(path.join(stage, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'docs', 'licenses.md'), '# licenses (fixture)\n');
}

function runGenerator(stage: string, out: string, ...extra: string[]): void {
  execFileSync(process.execPath, [GENERATOR, '--stage-dir', stage, '--out', out, ...extra], {
    stdio: 'pipe',
  });
}

function runGeneratorVerify(stage: string, out: string): { status: number; stderr: string } {
  const result = execFileSync(
    process.execPath,
    [GENERATOR, '--stage-dir', stage, '--out', out, '--verify'],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  return { status: 0, stderr: result };
}

describe('e1 manifest contract (issue #84, frozen check C2)', () => {
  it('generator output loads and verifies clean through the E2 verifier', () => {
    const stage = makeTempDir('e1-manifest-clean-');
    buildFixtureStage(stage);
    const out = path.join(stage, 'manifest.json');
    runGenerator(stage, out);
    const { manifest } = loadManifest(out);
    expect(manifest).not.toBeNull();
    const verify = verifyManifest(manifest as NonNullable<ReturnType<typeof loadManifest>['manifest']>, [stage]);
    expect(verify.failures).toEqual([]);
    expect(verify.ok).toBe(true);
    expect(verify.verifiedCount).toBeGreaterThan(0);
  });

  it('every required file carries sha256 + sizeBytes and paths are stage-root-relative', () => {
    const stage = makeTempDir('e1-manifest-shape-');
    buildFixtureStage(stage);
    const out = path.join(stage, 'manifest.json');
    runGenerator(stage, out);
    const { manifest } = loadManifest(out);
    expect(manifest?.models.length).toBeGreaterThan(0);
    for (const model of manifest?.models ?? []) {
      expect(model.files.length).toBeGreaterThan(0);
      for (const file of model.files) {
        expect(file.path.startsWith('models/') || file.path.startsWith('docs/')).toBe(true);
        expect(file.path.includes('\\')).toBe(false);
        expect(file.required).toBe(true);
        expect(typeof file.sha256).toBe('string');
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof file.sizeBytes).toBe('number');
        expect(fs.existsSync(path.join(stage, file.path))).toBe(true);
      }
    }
  });

  it('packs[] entries carry id/version/name/source_class/dir with dir packs-root-relative', () => {
    const stage = makeTempDir('e1-manifest-packs-');
    buildFixtureStage(stage);
    const out = path.join(stage, 'manifest.json');
    runGenerator(stage, out);
    const { manifest } = loadManifest(out);
    const pack = manifest?.packs?.find((p) => p.id === 'dummy-pack');
    expect(pack).toBeDefined();
    expect(pack?.version).toBe('1.0.0');
    expect(pack?.name).toBe('Dummy');
    expect(pack?.source_class).toBe('bundled');
    // Packs-root-relative: joining <manifestDir>/packs + dir must land on the
    // staged pack dir (the packEntryDir contract in desktop/main/index.ts).
    expect(pack?.dir).toBe('bundled-docs/dummy-pack-1.0.0');
    expect(pack?.dir.startsWith('packs/')).toBe(false);
    const files = (pack as { files?: { path: string; sha256?: string; sizeBytes?: number }[] }).files ?? [];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof file.sizeBytes).toBe('number');
      // Pack files are enumerated WITHOUT required (runtime verifies models[]
      // only; packs are build+install verified — the honest layering).
      expect((file as { required?: boolean }).required).toBeUndefined();
    }
  });

  it('every emitted pack dir resolves through the packEntryDir join to a staged dir', () => {
    const stage = makeTempDir('e1-manifest-packdir-');
    buildFixtureStage(stage);
    const out = path.join(stage, 'manifest.json');
    runGenerator(stage, out);
    const { manifest } = loadManifest(out);
    const manifestDir = path.dirname(out);
    for (const pack of manifest?.packs ?? []) {
      // Mirror of packEntryDir in desktop/main/index.ts.
      const joined = containedJoin(path.join(manifestDir, 'packs'), pack.dir ?? `${pack.id}-${pack.version ?? ''}`);
      expect(joined).not.toBeNull();
      expect(fs.existsSync(joined as string)).toBe(true);
      expect(fs.statSync(joined as string).isDirectory()).toBe(true);
    }
  });

  it('a required file without a manifest sha256 is a schema failure, not a silent skip', () => {
    const stage = makeTempDir('e1-manifest-tamper-');
    buildFixtureStage(stage);
    const out = path.join(stage, 'manifest.json');
    runGenerator(stage, out);
    const { manifest } = loadManifest(out);
    // Hand-tamper: strip the sha256 from one required file entry.
    const victim = manifest?.models[0]?.files[0];
    expect(victim).toBeDefined();
    delete (victim as { sha256?: string }).sha256;
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
    const verify = verifyManifest(manifest as NonNullable<ReturnType<typeof loadManifest>['manifest']>, [stage]);
    const failure = verify.failures.find((f: ManifestFailure) => f.reason === 'sha256-required');
    expect(failure?.path).toBe(victim?.path);
    expect(verify.ok).toBe(false);
  });

  it('whole-tree enumeration: a planted unlisted file fails --verify by name', () => {
    const stage = makeTempDir('e1-manifest-sneaky-');
    buildFixtureStage(stage);
    const out = path.join(stage, 'manifest.json');
    runGenerator(stage, out);
    writeStageFile(stage, 'models/llm-fast/sneaky/model.gguf', 1024);
    let failed: Error | undefined;
    try {
      runGeneratorVerify(stage, out);
    } catch (err) {
      failed = err as Error;
    }
    expect(failed).toBeDefined();
    expect(String((failed as { stderr?: Buffer }).stderr ?? failed)).toContain('sneaky');
  });

  it('--verify is read-only: the manifest bytes are unchanged by a verify run', () => {
    const stage = makeTempDir('e1-manifest-readonly-');
    buildFixtureStage(stage);
    const out = path.join(stage, 'manifest.json');
    runGenerator(stage, out);
    const before = fs.readFileSync(out);
    runGeneratorVerify(stage, out);
    expect(fs.readFileSync(out).equals(before)).toBe(true);
  });
});
