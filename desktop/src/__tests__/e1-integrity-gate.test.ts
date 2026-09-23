// e1-integrity-gate.test.ts — E1 acceptance checks for issue #84.
//
// Frozen check subject: C3 (desktop/main/integrity-check.ts decides
// pass/block/skip/report; a packaged build with a truncated required file is
// BLOCKED before backend start with the specific file + expected/actual
// sha256 named — never a generic message). Also pins the decision table rows
// (packaged-clean pass + derived modelDirs; packaged-absent block; dev-absent
// skip; dev-present report with the bridge unarmed) and the per-file
// hash-error naming. Provenance anchors — the frozen drivers
// .agents/issue-traces/84-package-models-integrity-manifest/repro/check-C3.sh
// replay this spec.
//
// Electron-free module (desktop/main/integrity-check.ts), plain node vitest.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveModelDirs, formatFailure, runStartupIntegrityCheck } from '../../main/integrity-check.js';

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

/** A resources-root-shaped stage with all four model groups + docs. */
function buildGateStage(stage: string): void {
  const files: [string, number][] = [
    ['models/embedding/dummy-emb/onnx/model.onnx', 64 * 1024],
    ['models/embedding/dummy-emb/tokenizer.json', 2048],
    ['models/reranker/dummy-rn/onnx/model_quantized.onnx', 32 * 1024],
    ['models/llm-quality/dummy-lq/model.gguf', 128 * 1024],
    ['models/llm-fast/dummy-lf/model.gguf', 64 * 1024],
    ['docs/licenses.md', 64],
  ];
  for (const [rel, size] of files) {
    const abs = path.join(stage, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, randomBytes(size));
  }
  execFileSync(process.execPath, [GENERATOR, '--stage-dir', stage, '--out', path.join(stage, 'manifest.json')], {
    stdio: 'pipe',
  });
}

describe('e1 startup integrity gate (issue #84, frozen check C3)', () => {
  it('packaged + truncated required file: block, naming path + expected/actual sha256', () => {
    const stage = makeTempDir('e1-gate-truncate-');
    buildGateStage(stage);
    const victim = path.join(stage, 'models', 'llm-quality', 'dummy-lq', 'model.gguf');
    const original = fs.readFileSync(victim);
    // Truncate: hash and size both drift from the manifest record.
    fs.writeFileSync(victim, original.subarray(0, original.length - 1024));
    const result = runStartupIntegrityCheck({ isPackaged: true, resourcesPath: stage, env: {} });
    expect(result.decision).toBe('block');
    const failure = result.failures.find((f) => f.path === 'models/llm-quality/dummy-lq/model.gguf');
    expect(failure).toBeDefined();
    expect(['hash-mismatch', 'size-mismatch']).toContain(failure?.reason);
    expect(failure?.expected).toMatch(/^sha256 [0-9a-f]{64}$/);
    expect(failure?.actual).toMatch(/^(sha256 [0-9a-f]{64}|\d+ bytes)$/);
    expect(formatFailure(failure as never)).toContain('models/llm-quality/dummy-lq/model.gguf');
  });

  it('packaged + clean stage: pass with modelDirs derived for the bridge', () => {
    const stage = makeTempDir('e1-gate-clean-');
    buildGateStage(stage);
    const result = runStartupIntegrityCheck({ isPackaged: true, resourcesPath: stage, env: {} });
    expect(result.decision).toBe('pass');
    expect(result.failures).toEqual([]);
    expect(result.modelDirs.engineQuality).toBe(path.join(stage, 'models', 'llm-quality', 'dummy-lq', 'model.gguf'));
    expect(result.modelDirs.engineFast).toBe(path.join(stage, 'models', 'llm-fast', 'dummy-lf', 'model.gguf'));
    expect(result.modelDirs.embedder).toBe(path.join(stage, 'models', 'embedding', 'dummy-emb'));
    expect(result.modelDirs.reranker).toBe(path.join(stage, 'models', 'reranker', 'dummy-rn'));
  });

  it('packaged + absent manifest: block with a named failure (fail closed)', () => {
    const stage = makeTempDir('e1-gate-absent-');
    fs.mkdirSync(stage, { recursive: true });
    const result = runStartupIntegrityCheck({ isPackaged: true, resourcesPath: stage, env: {} });
    expect(result.decision).toBe('block');
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]?.reason).toBe('manifest-unreadable');
    expect(result.failures[0]?.path.length).toBeGreaterThan(0);
  });

  it('dev + absent manifest: skip (staged:false degrade is by design)', () => {
    const stage = makeTempDir('e1-gate-dev-');
    fs.mkdirSync(stage, { recursive: true });
    const result = runStartupIntegrityCheck({ isPackaged: false, repoRoot: stage, env: {} });
    expect(result.decision).toBe('skip');
    expect(result.failures).toEqual([]);
    expect(result.manifest).toBeNull();
  });

  it('dev + manifest present: report (never quit), bridge stays unarmed', () => {
    const stage = makeTempDir('e1-gate-report-');
    buildGateStage(stage);
    const result = runStartupIntegrityCheck({ isPackaged: false, repoRoot: stage, env: { TRAININGAPP_DESKTOP_MANIFEST: path.join(stage, 'manifest.json') } });
    expect(result.decision).toBe('report');
    expect(result.modelDirs).toEqual({});
  });

  it('dev + manifest present with a corrupted file: report with the file named, never block', () => {
    const stage = makeTempDir('e1-gate-report-bad-');
    buildGateStage(stage);
    const victim = path.join(stage, 'models', 'embedding', 'dummy-emb', 'tokenizer.json');
    fs.writeFileSync(victim, randomBytes(4096));
    const result = runStartupIntegrityCheck({ isPackaged: false, repoRoot: stage, env: { TRAININGAPP_DESKTOP_MANIFEST: path.join(stage, 'manifest.json') } });
    expect(result.decision).toBe('report');
    const failure = result.failures.find((f) => f.path === 'models/embedding/dummy-emb/tokenizer.json');
    expect(failure?.reason).toBe('hash-mismatch');
  });

  it('an unreadable required file is a per-file failure, not a generic manifest error', () => {
    const stage = makeTempDir('e1-gate-unreadable-');
    buildGateStage(stage);
    const victim = path.join(stage, 'models', 'reranker', 'dummy-rn', 'onnx', 'model_quantized.onnx');
    fs.rmSync(victim);
    // A DIRECTORY at the file's path makes the hashing open/read fail.
    fs.mkdirSync(victim);
    const result = runStartupIntegrityCheck({ isPackaged: true, resourcesPath: stage, env: {} });
    expect(result.decision).toBe('block');
    const failure = result.failures.find((f) => f.path === 'models/reranker/dummy-rn/onnx/model_quantized.onnx');
    expect(failure).toBeDefined();
    expect(failure?.reason).toBe('unreadable');
    expect(failure?.actual).toContain('model_quantized.onnx');
  });

  it('deriveModelDirs leaves groups the manifest did not stage undefined', () => {
    const stage = makeTempDir('e1-gate-derive-');
    fs.mkdirSync(path.join(stage, 'models', 'llm-quality', 'only-lq'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'models', 'llm-quality', 'only-lq', 'model.gguf'), randomBytes(1024));
    const dirs = deriveModelDirs(stage, {
      version: '1',
      models: [
        {
          id: 'only-lq',
          group: 'llm-quality',
          files: [{ path: 'models/llm-quality/only-lq/model.gguf', required: true, sha256: 'a'.repeat(64), sizeBytes: 1024 }],
        },
      ],
    });
    expect(dirs.engineQuality).toBe(path.join(stage, 'models', 'llm-quality', 'only-lq', 'model.gguf'));
    expect(dirs.engineFast).toBeUndefined();
    expect(dirs.embedder).toBeUndefined();
    expect(dirs.reranker).toBeUndefined();
  });
});
