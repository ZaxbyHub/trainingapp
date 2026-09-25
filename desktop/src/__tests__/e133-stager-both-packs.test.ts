/**
 * e133-stager-both-packs.test.ts — #133 round 4/5: when the operator built
 * BOTH the documents pack and the Articulate training pack, the stager stages
 * BOTH (classDirs bundled-docs + training) and the installer manifest lists
 * both. Round-5 review finding: the first cut of this spec read the
 * machine-local desktop/installer-resources/manifest.json — a build artifact
 * that cannot exist on a fresh CI runner (acceptance tests run BEFORE the
 * staging step) — so the spec redmed CI while looking green locally. This
 * version is fully self-contained: resolveStagedPacks is driven over temp
 * roots for every mode, and the manifest assertions run the REAL generator as
 * a subprocess over a temp staged tree.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStagedPacks } from '../../scripts/stage-installer-resources.mjs';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..');
const DOCS_PACK_DIR = 'opmed-initial-1.0.0';
const TRAINING_PACK_DIR = 'opmed-cdp-mlc-1.0.0';
const FIXTURE_PACK_SOURCE = path.join(REPO_ROOT, 'contracts', 'fixtures', 'packs', 'bundled-min');

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e133-stager-packs-'));
}

function writePackJson(root: string, dirName: string, id: string, sourceClass: string): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'pack.json'),
    `${JSON.stringify({ id, name: id, version: '1.0.0', source_class: sourceClass }, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

interface StagedPack {
  source: string;
  classDir: string;
}

function resolveFor(root: string): { packs: StagedPack[]; problems: string[] } {
  const problems: string[] = [];
  const packs = resolveStagedPacks({
    knowledgePackSrcRoot: root,
    docsPackDir: DOCS_PACK_DIR,
    trainingPackDir: TRAINING_PACK_DIR,
    fixturePackSource: FIXTURE_PACK_SOURCE,
    onProblem: (message: string) => problems.push(message),
  });
  return { packs, problems };
}

describe('bundled docs + training staging (#133 round 4/5)', () => {
  it('real-content root with BOTH packs built stages both, classed bundled-docs + training', () => {
    const root = makeRoot();
    const docsDir = writePackJson(root, DOCS_PACK_DIR, 'opmed-initial', 'bundled');
    const trainingDir = writePackJson(root, TRAINING_PACK_DIR, 'opmed-cdp-mlc', 'training');
    const { packs, problems } = resolveFor(root);
    expect(problems).toEqual([]);
    expect(packs).toEqual([
      { source: docsDir, classDir: 'bundled-docs' },
      { source: trainingDir, classDir: 'training' },
    ]);
  });

  it('a docs-only root FAILS LOUD (never silently ships an installer without the bundled course)', () => {
    const root = makeRoot();
    writePackJson(root, DOCS_PACK_DIR, 'opmed-initial', 'bundled');
    const { packs, problems } = resolveFor(root);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${TRAINING_PACK_DIR}/pack.json`);
    expect(problems[0]).toContain('build-training-pack.mjs');
    // The fail-loud is the gate; the returned list only carries what exists.
    expect(packs.map((p) => p.classDir)).toEqual(['bundled-docs']);
  });

  it('a training-only root also fails loud (both packs are required in real-content mode)', () => {
    const root = makeRoot();
    writePackJson(root, TRAINING_PACK_DIR, 'opmed-cdp-mlc', 'training');
    const { problems } = resolveFor(root);
    expect(problems.some((m) => m.includes(`${DOCS_PACK_DIR}/pack.json`))).toBe(true);
  });

  it('an EMPTY knowledge-pack-src root fails loud on both (the fixture fallback needs the root gone)', () => {
    const root = makeRoot();
    const { problems } = resolveFor(root);
    expect(problems.length).toBe(2);
  });

  it('root ABSENT (CI / weights-less checkout) stages the bundled-min fixture only', () => {
    const { packs, problems } = resolveFor(path.join(makeRoot(), 'does-not-exist'));
    expect(problems).toEqual([]);
    expect(packs).toEqual([{ source: FIXTURE_PACK_SOURCE, classDir: 'bundled-docs' }]);
  });

  it('END-TO-END: the real manifest generator lists both packs with the training class + layout', () => {
    // Mirror of the tree stagePacks() writes for the resolveStagedPacks
    // output plus the minimum a manifest requires (>= 1 models/ group).
    const stage = makeRoot();
    const packFixture = (classDir: string, dirName: string, id: string, sourceClass: string) => {
      const dir = path.join(stage, 'packs', classDir, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'pack.json'),
        `${JSON.stringify({ id, name: id, version: '1.0.0', source_class: sourceClass }, null, 2)}\n`,
        'utf8',
      );
      fs.writeFileSync(path.join(dir, 'index.bin'), 'x', 'utf8');
    };
    packFixture('bundled-docs', 'opmed-initial-1.0.0', 'opmed-initial', 'bundled');
    packFixture('training', 'opmed-cdp-mlc-1.0.0', 'opmed-cdp-mlc', 'training');
    const modelsDir = path.join(stage, 'models', 'embedding', 'bge-small-en-v1.5');
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.writeFileSync(path.join(modelsDir, 'config.json'), '{}', 'utf8');

    const script = path.join(DESKTOP_DIR, 'scripts', 'build-installer-manifest.mjs');
    execFileSync(process.execPath, [script, '--stage-dir', stage], { stdio: 'pipe' });
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8')) as {
      packs: Array<{ id: string; dir: string; source_class: string }>;
    };
    const ids = manifest.packs.map((entry) => entry.id).sort();
    expect(ids).toEqual(['opmed-cdp-mlc', 'opmed-initial']);
    const training = manifest.packs.find((entry) => entry.id === 'opmed-cdp-mlc');
    expect(training?.source_class).toBe('training');
    expect(training?.dir).toBe('training/opmed-cdp-mlc-1.0.0');
  });
});
