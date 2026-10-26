/**
 * e174-stager-negatives.test.ts — issue #174 AC3 (frozen check C11,
 * `stager-negative-paths`).
 *
 * The manifest generator's fail-loud guards (symlink refusal, unrecognized
 * staged path, empty staged tree, pack metadata requirements) and the stager's
 * pack-id refusal were previously pinned only by git-excluded trace drivers;
 * the five-entry extraResources mapping in electron-builder.yml was pinned
 * nowhere, and a stale vacuous python pin (test_adr_0002_llm_profiles.py)
 * claimed the docs entry was absent while it silently stopped matching the
 * real `from: installer-resources/docs` line. This spec commits all of it.
 *
 * Every generator case runs the REAL script as a child process against a
 * synthetic staged tree in a temp dir; each named guard must exit 1 with its
 * specific message (not any nonzero exit), so deleting a guard or widening a
 * message fails this spec.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const GENERATOR = path.join(REPO_ROOT, 'desktop', 'scripts', 'build-installer-manifest.mjs');
const BUILDER = path.join(REPO_ROOT, 'desktop', 'electron-builder.yml');
const STAGER = path.join(REPO_ROOT, 'desktop', 'scripts', 'stage-installer-resources.mjs');

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    if (fs.existsSync(path.join(current, '.git'))) {
      throw new Error(`repo root not found above ${dir} (marker walk hit checkout root)`);
    }
    current = path.dirname(current);
  }
  throw new Error(`repo root not found above ${dir}`);
}

const runGenerator = (stage: string) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [GENERATOR, '--stage-dir', stage, '--out', path.join(stage, 'manifest.json')],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
      },
    );
  });

const makeStage = (): string => fs.mkdtempSync(path.join(import.meta.dirname!, 'stage-'));

const writeModelFile = (stage: string, rel: string[]): void => {
  const abs = path.join(stage, ...rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'payload\n');
};

describe('stager negative paths (issue #174 AC3)', () => {
  it('stager-negative-paths: a symlinked entry in the staged tree is refused by name', async () => {
    const stage = makeStage();
    try {
      writeModelFile(stage, ['models', 'llm-fast', 'm', 'a.txt']);
      const linkTarget = path.join(stage, 'models', 'llm-fast', 'm');
      const link = path.join(stage, 'models', 'llm-fast', 'link');
      fs.symlinkSync(linkTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
      const res = await runGenerator(stage);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('staged tree must not contain symlinks');
      expect(fs.existsSync(path.join(stage, 'manifest.json'))).toBe(false);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('stager-negative-paths: an unrecognized staged path is refused by name', async () => {
    const stage = makeStage();
    try {
      writeModelFile(stage, ['models', 'llm-fast', 'm', 'a.txt']);
      writeModelFile(stage, ['stray.txt']);
      const res = await runGenerator(stage);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('unrecognized staged path');
      expect(res.stderr).toContain('stray.txt');
      expect(fs.existsSync(path.join(stage, 'manifest.json'))).toBe(false);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('stager-negative-paths: an empty staged tree is refused by name', async () => {
    const stage = makeStage();
    try {
      const res = await runGenerator(stage);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('staged tree is empty');
      expect(fs.existsSync(path.join(stage, 'manifest.json'))).toBe(false);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('stager-negative-paths: a payload-bearing pack dir without pack.json is refused by name', async () => {
    const stage = makeStage();
    try {
      writeModelFile(stage, ['models', 'llm-fast', 'm', 'a.txt']);
      writeModelFile(stage, ['packs', 'bundled-docs', 'somepack-1.0.0', 'content.txt']);
      const res = await runGenerator(stage);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('has no readable pack.json');
      expect(fs.existsSync(path.join(stage, 'manifest.json'))).toBe(false);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('stager-negative-paths: a pack.json without an id is refused by name (generator AND stager guards)', async () => {
    const stage = makeStage();
    try {
      writeModelFile(stage, ['models', 'llm-fast', 'm', 'a.txt']);
      const packDir = path.join(stage, 'packs', 'bundled-docs', 'somepack-1.0.0');
      fs.mkdirSync(packDir, { recursive: true });
      fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({ version: '1.0.0' }));
      fs.writeFileSync(path.join(packDir, 'content.txt'), 'payload\n');
      const res = await runGenerator(stage);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('pack.json id is required');
      expect(fs.existsSync(path.join(stage, 'manifest.json'))).toBe(false);

      // The STAGER carries its own refusal for an idless pack fixture
      // (stagePacks) — pinned structurally: the guard exists and fails loud
      // (the full stager tree is exercised end-to-end by
      // e174-staging-isolation.test.ts's replica probe).
      const stagerSrc = fs.readFileSync(STAGER, 'utf8');
      expect(stagerSrc).toContain('has no id');
      expect(stagerSrc).toContain('pack fixture missing');
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('stager-negative-paths: the five-entry extraResources mapping is pinned exactly', () => {
    // Line-ending agnostic: the worktree file is CRLF under this box's
    // autocrlf while the committed blob is LF.
    const builder = fs.readFileSync(BUILDER, 'utf8').replace(/\r\n/g, '\n');
    const block = builder.slice(builder.indexOf('extraResources:'));
    const entries = [...block.matchAll(/- from: (.+)\n\s+to: (.+)/g)].map((m) => [
      m[1]!.trim(),
      m[2]!.trim(),
    ]);
    expect(entries).toEqual([
      ['renderer', 'web_ui'],
      ['installer-resources/models', 'models'],
      ['installer-resources/packs', 'packs'],
      ['installer-resources/docs', 'docs'],
      ['installer-resources/manifest.json', 'manifest.json'],
    ]);
    expect(entries).toHaveLength(5);
  });
});
