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

  it('the stager allow-list satisfies each packaged consumer contract (root tokenizers etc.)', async () => {
    // Import the stager's table (the import guard keeps main() from running).
    const stager = await import('../../scripts/stage-installer-resources.mjs');
    const staged = stager.STAGED_MODELS as { group: string; id: string; files: string[] }[];
    const byGroup = new Map(staged.map((m) => [m.group, m.files]));
    // Embedder (embedder.ts): onnx/model.onnx (fp32, isValidModelDir >=10 MB)
    // + root tokenizer.json.
    const embedding = byGroup.get('embedding') ?? [];
    expect(embedding).toContain('onnx/model.onnx');
    expect(embedding).toContain('tokenizer.json');
    // Reranker (rerank-worker.ts): q8 onnx/model_quantized.onnx AND the ROOT
    // tokenizer.json/tokenizer_config.json — AutoTokenizer.from_pretrained
    // loads from the model ROOT; staging them only under onnx/ was the
    // implementation-review CRITICAL finding (hash-gate passes, every
    // retrieval query 500s after first ingest).
    const reranker = byGroup.get('reranker') ?? [];
    expect(reranker).toContain('onnx/model_quantized.onnx');
    expect(reranker).toContain('tokenizer.json');
    expect(reranker).toContain('tokenizer_config.json');
    // LLM groups (llama-engine modelPathFor): model.gguf per ADR-0002 pair.
    for (const group of ['llm-quality', 'llm-fast']) {
      expect(byGroup.get(group) ?? []).toContain('model.gguf');
    }
  });

  it('reconcileRendererManifest drops exactly the staged-id entries and keeps the rest', async () => {
    const stager = await import('../../scripts/stage-installer-resources.mjs');
    const rendererRoot = makeTempDir('e1-renderer-manifest-');
    const modelsDir = path.join(rendererRoot, 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    const sourceManifest = {
      version: '2',
      models: [
        { id: 'ettin-reranker-32m-v1', group: 'reranker', files: [{ path: 'reranker/ettin-reranker-32m-v1/onnx/model_quantized.onnx', required: true }] },
        { id: 'gemma-4-e2b-it', group: 'llm', files: [{ path: 'llm/gemma-4-e2b-it/model.gguf', required: true }] },
        { id: 'onnxruntime-web', group: 'core', files: [{ path: 'ort/ort-wasm-simd-threaded.jsep.wasm', required: true }] },
        { id: 'snowflake-arctic-embed-m-v1.5', group: 'embedding', files: [{ path: 'embeddings/snowflake-arctic-embed-m-v1.5/onnx/model_quantized.onnx', required: true }] },
      ],
    };
    fs.writeFileSync(path.join(modelsDir, 'manifest.json'), JSON.stringify(sourceManifest, null, 2));
    stager.reconcileRendererManifest(rendererRoot, stager.RENDERER_EXCLUDED_MODEL_IDS as ReadonlySet<string>);
    const reconciled = JSON.parse(fs.readFileSync(path.join(modelsDir, 'manifest.json'), 'utf8'));
    const ids = reconciled.models.map((m: { id: string }) => m.id);
    // Staged-weight entries are gone; the packaged renderer's readiness gate
    // no longer demands files this installer deliberately does not ship.
    expect(ids).not.toContain('ettin-reranker-32m-v1');
    expect(ids).not.toContain('gemma-4-e2b-it');
    expect(ids).toContain('onnxruntime-web');
    expect(ids).toContain('snowflake-arctic-embed-m-v1.5');
  });

  it('cross-manifest invariant: staged∩renderer-required groups covered by .env.desktop; accepted collateral pinned', async () => {
    const stager = await import('../../scripts/stage-installer-resources.mjs');
    const stagedIds = new Set((stager.STAGED_MODELS as { id: string }[]).map((m) => m.id));
    const webUiManifest = JSON.parse(
      fs.readFileSync(path.resolve(desktopDir, '..', 'web_ui', 'public', 'models', 'manifest.json'), 'utf8'),
    );
    const envDesktop = fs.readFileSync(path.resolve(desktopDir, '..', 'web_ui', '.env.desktop'), 'utf8');
    const envGroups = new Set(
      ((envDesktop.match(/VITE_EXCLUDE_MODEL_GROUPS=(.*)/) ?? [])[1] ?? '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean),
    );
    const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
    // The desktop bundle must actually bake the exclusion: build:desktop mode
    // selected by desktop:build, mode env from web_ui/.env.desktop.
    expect(desktopPkg.scripts['desktop:build']).toContain('run build:desktop');
    expect(
      JSON.parse(fs.readFileSync(path.resolve(desktopDir, '..', 'web_ui', 'package.json'), 'utf8')).scripts['build:desktop'],
    ).toContain('--mode desktop');

    // Group granularity is coarse (exclusion is per web_ui manifest GROUP, and
    // checkPackagedModels inlines the manifest at Vite build time —
    // reconciling the copied JSON alone fixes nothing, review PRR-132):
    // 1. every staged id that is ALSO renderer-required must have its group
    //    covered by .env.desktop (else the packaged gate demands files the
    //    installer does not ship in the renderer copy);
    // 2. every NON-staged renderer-required id whose group got swept up by
    //    that exclusion is ACCEPTED COLLATERAL and must be exactly the list
    //    below — a new id landing in an excluded group fails here until it is
    //    consciously added (the ADR-0001 snowflake re-pin tripwire).
    const acceptedCollateral: Record<string, string[]> = {
      core: ['onnxruntime-web'], // excluded for ettin; ort ships in the copy but its readiness probe is skipped
      llm: ['wllama-runtime'], // excluded for gemma; wllama wasm/js ship in the copy
    };
    const missingCoverage: string[] = [];
    const collateral: Record<string, string[]> = {};
    for (const entry of webUiManifest.models as {
      id: string;
      group: string;
      files: { path: string; required?: boolean }[];
    }[]) {
      const requiredFiles = entry.files.filter((f) => f.required !== false);
      if (requiredFiles.length === 0 || !envGroups.has(entry.group)) continue;
      if (stagedIds.has(entry.id)) {
        // Its weights must ship in the staged tree (consumer coverage).
        const staged = (stager.STAGED_MODELS as { id: string; files: string[] }[]).find((m) => m.id === entry.id);
        for (const file of requiredFiles) {
          const fileName = path.basename(file.path);
          const covered = (staged?.files ?? []).some((f) => f === fileName || f.endsWith(`/${fileName}`));
          expect(covered, `staged ${entry.id} does not cover renderer-required file ${fileName}`).toBe(true);
        }
        void 0;
      } else {
        (collateral[entry.group] ??= []).push(entry.id);
      }
    }
    // Coverage check (staged side) recorded via excludedGroups semantics:
    for (const entry of webUiManifest.models as { id: string; group: string }[]) {
      if (stagedIds.has(entry.id)) {
        expect(
          envGroups.has(entry.group),
          `staged id ${entry.id} is renderer-required but its group is not excluded by .env.desktop — the packaged gate would demand files the installer does not ship in the renderer copy`,
        ).toBe(true);
      }
    }
    expect(collateral).toEqual(acceptedCollateral);
  });
  it('findMissingSources reports exactly the allow-list files absent from a repo root', async () => {
    const stager = await import('../../scripts/stage-installer-resources.mjs');
    const repoRoot = makeTempDir('e1-missing-sources-');
    const staged = stager.STAGED_MODELS as { id: string; files: string[] }[];
    // Stage only the FIRST file of the FIRST model; everything else is missing.
    const first = staged[0];
    const firstAbs = path.join(repoRoot, 'models', first.id, first.files[0]);
    fs.mkdirSync(path.dirname(firstAbs), { recursive: true });
    fs.writeFileSync(firstAbs, 'x');
    const missing = stager.findMissingSources(repoRoot) as string[];
    const expectedTotal = staged.reduce((n, m) => n + m.files.length, 0);
    expect(missing).toHaveLength(expectedTotal - 1);
    expect(missing).not.toContain(path.join('models', first.id, first.files[0]));
    // Complete fixture tree -> no missing sources.
    for (const model of staged) {
      for (const rel of model.files) {
        const abs = path.join(repoRoot, 'models', model.id, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'x');
      }
    }
    expect(stager.findMissingSources(repoRoot)).toEqual([]);
  });
});
