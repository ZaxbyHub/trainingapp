// e1-packaged-bootstrap-glue.test.ts — issue #131 item 4 (PRR-112 residual)
// frozen check: the packaged block/pass glue of the REAL bootstrap().
//
// Subject: desktop/main/index.ts's app.isPackaged === true branches —
// (i) BLOCK: no manifest at <resourcesPath>/manifest.json → named-failure
//     dialog.showErrorBox('TrainingApp cannot start', …) + app.quit() +
//     return-before-backend (no desktop:get-backend, no first-run handlers,
//     no window);
// (ii) PASS: a manifest that verifies clean → the packaged→runtime bridge
//     overrides a PRE-SET CONFLICTING TRAININGAPP_EMBEDDING_MODEL_DIR /
//     TRAININGAPP_RERANKER_MODEL_DIR with the verified packaged values (each
//     with the '[trainingapp-desktop] integrity: packaged manifest overrides
//     …' console.warn), and resolveNodeEngine receives overrides.models with
//     the verified quality/fast gguf paths;
// (iii) after block: no window/backend side effects.
//
// Harness proven by b3-bootstrap-wiring.test.ts: real bootstrap() against the
// electron stub (__resetElectronStub per test, app.emit('will-quit') cleanup).
// resolveManifestPath precedence: TRAININGAPP_DESKTOP_MANIFEST env FIRST, then
// <resourcesPath>/manifest.json for packaged builds — so every test DELETES
// that env var and assigns process.resourcesPath to a fixture tree.
// resolveNodeEngine is captured by vi.mock-ing desktop/main/backend/index.js
// with importOriginal and wrapping the real function in a call-through vi.fn
// (bootstrap imports it from there); TRAININGAPP_DESKTOP_ENGINE=stub keeps the
// wrapped engine construction weights-free while the overrides are recorded.
//
// RED at base — this spec is absent on the pre-fix tree (no committed test
// drove the packaged glue). GREEN after the fix commits it passing. The Phase
// 4.5 mutation probe mutates the glue (drop app.quit, invert the seam
// precedence, drop engineOverrides.models) and expects this spec to catch it.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, BrowserWindow, dialog, ipcMain, __resetElectronStub } from 'electron';

vi.mock('../../main/backend/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/backend/index.js')>();
  return {
    ...actual,
    resolveNodeEngine: vi.fn(
      (...args: Parameters<typeof actual.resolveNodeEngine>) => actual.resolveNodeEngine(...args),
    ),
  };
});

import { bootstrap } from '../../main/index';
import { resolveNodeEngine } from '../../main/backend/index.js';

const resolveNodeEngineMock = vi.mocked(resolveNodeEngine);

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATOR = path.join(desktopDir, 'scripts', 'build-installer-manifest.mjs');

const tempDirs: string[] = [];
const ENV_KEYS = [
  'TRAININGAPP_DESKTOP_MANIFEST',
  'TRAININGAPP_DESKTOP_STORE_PATH',
  'TRAININGAPP_DESKTOP_PACKS_DIR',
  'TRAININGAPP_DESKTOP_ENGINE',
  'TRAININGAPP_EMBEDDING_MODEL_DIR',
  'TRAININGAPP_RERANKER_MODEL_DIR',
] as const;
let savedEnv: Record<string, string | undefined>;
let savedResourcesPath: string | undefined;
let resourcesPathWasOwnProperty = false;

/** Electron-only property; plain node leaves it undefined and specs assign it. */
function setResourcesPath(dir: string): void {
  const proc = process as unknown as { resourcesPath?: string };
  resourcesPathWasOwnProperty = Object.prototype.hasOwnProperty.call(proc, 'resourcesPath');
  savedResourcesPath = proc.resourcesPath;
  proc.resourcesPath = dir;
}

function restoreResourcesPath(): void {
  const proc = process as unknown as { resourcesPath?: string };
  if (resourcesPathWasOwnProperty) proc.resourcesPath = savedResourcesPath;
  else delete proc.resourcesPath;
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function registeredChannels(): string[] {
  return (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
}

/** A resources-root-shaped stage with all four model groups + docs (e1 shape). */
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

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  __resetElectronStub();
  resolveNodeEngineMock.mockClear();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Same isolation seams the committed suites use (store + packs under tmp,
  // stub engine so the wrapped resolveNodeEngine stays weights-free).
  const iso = makeTempDir('131-glue-iso-');
  process.env.TRAININGAPP_DESKTOP_STORE_PATH = path.join(iso, 'profiles', 'default', 'store.sqlite');
  process.env.TRAININGAPP_DESKTOP_PACKS_DIR = path.join(iso, 'packs');
  process.env.TRAININGAPP_DESKTOP_ENGINE = 'stub';
});

afterEach(async () => {
  // Stop THIS test's host (b3 pattern): the beforeEach stub reset wipes the
  // will-quit listener without firing it.
  app.emit('will-quit');
  await new Promise((resolve) => setTimeout(resolve, 80));
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  restoreResourcesPath();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('e1 packaged bootstrap glue (issue #131 item 4)', () => {
  it('BLOCK: packaged + no manifest at <resourcesPath>/manifest.json → error box titled TrainingApp cannot start, quit, and NO backend', async () => {
    const stage = makeTempDir('131-glue-block-'); // empty dir: manifest missing
    setResourcesPath(stage);
    app.isPackaged = true;
    bootstrap();
    await waitFor(() => (dialog.showErrorBox as ReturnType<typeof vi.fn>).mock.calls.length > 0, 'dialog.showErrorBox called');
    const call = (dialog.showErrorBox as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, string];
    expect(call[0]).toBe('TrainingApp cannot start');
    expect(call[1]).toContain('failed integrity verification');
    expect(app.quit).toHaveBeenCalled();
    // No backend / first-run / window side effects after the block.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const channels = registeredChannels();
    expect(channels).not.toContain('desktop:get-backend');
    expect(channels).not.toContain('desktop:first-run:status');
    expect(channels).not.toContain('desktop:first-run:complete');
    expect(BrowserWindow.getAllWindows()).toHaveLength(0);
    expect(resolveNodeEngineMock).not.toHaveBeenCalled();
  });

  it('PASS: verified manifest overrides pre-set conflicting env seams (with the warn) and feeds engineOverrides.models', async () => {
    const stage = makeTempDir('131-glue-pass-');
    buildGateStage(stage);
    setResourcesPath(stage);
    app.isPackaged = true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Pre-set CONFLICTING values: a naive precedence would keep these.
    process.env.TRAININGAPP_EMBEDDING_MODEL_DIR = path.join(stage, 'conflicting-embedder');
    process.env.TRAININGAPP_RERANKER_MODEL_DIR = path.join(stage, 'conflicting-reranker');
    bootstrap();
    const embedderDir = path.join(stage, 'models', 'embedding', 'dummy-emb');
    await waitFor(() => process.env.TRAININGAPP_EMBEDDING_MODEL_DIR === embedderDir, 'embedder seam overridden by the packaged value');
    expect(process.env.TRAININGAPP_RERANKER_MODEL_DIR).toBe(path.join(stage, 'models', 'reranker', 'dummy-rn'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('packaged manifest overrides TRAININGAPP_EMBEDDING_MODEL_DIR'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('packaged manifest overrides TRAININGAPP_RERANKER_MODEL_DIR'));
    await waitFor(() => resolveNodeEngineMock.mock.calls.length > 0, 'resolveNodeEngine called');
    const overrides = resolveNodeEngineMock.mock.calls[0]?.[1];
    expect(overrides?.models?.quality).toBe(path.join(stage, 'models', 'llm-quality', 'dummy-lq', 'model.gguf'));
    expect(overrides?.models?.fast).toBe(path.join(stage, 'models', 'llm-fast', 'dummy-lf', 'model.gguf'));
    // The glue proceeded past the gate: the guarded backend started.
    await waitFor(() => registeredChannels().includes('desktop:get-backend'), 'desktop:get-backend registered');
  });
});
