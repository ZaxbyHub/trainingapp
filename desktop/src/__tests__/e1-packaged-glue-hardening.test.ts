// e1-packaged-glue-hardening.test.ts — swarm-pr-review follow-ups on PR #172
// (PRR-030/036). Complements the FROZEN glue + wiring specs (checkpoint-bound
// bytes) with the gaps the review confirmed: the completion handler must pass
// {fresh:true} to the wizard-manifest accessor (the TOCTOU call-site proof),
// the corrupt-manifest BLOCK dialog must name the failure, the >5-failures
// truncation must render, and engineOverrides.models must degrade correctly
// for a PARTIALLY staged manifest. New file on purpose — never edit the frozen
// spec files.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, dialog, ipcMain, __resetElectronStub } from 'electron';

const hoisted = vi.hoisted(() => ({
  createWizardManifest: vi.fn(),
  wizardManifest: vi.fn(),
}));

vi.mock('../../main/first-run/wizard-manifest.js', () => ({
  createWizardManifest: hoisted.createWizardManifest,
}));

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

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Full valid four-group stage (the PASS-path fixture). */
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

/** Hand-written manifest over N existing files, which are then DELETED so
 *  verification reports exactly N failures. */
function buildFailingStage(stage: string, count: number): void {
  const models = [];
  for (let i = 0; i < count; i++) {
    const rel = `models/embedding/dummy-${i}/tokenizer.json`;
    const abs = path.join(stage, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const bytes = randomBytes(1024);
    fs.writeFileSync(abs, bytes);
    models.push({
      id: `dummy-${i}`,
      group: 'embedding',
      files: [{ path: rel, required: true, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }],
    });
    fs.rmSync(abs);
  }
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ version: '1', models }));
}

/** Only the quality group staged (partial manifest). */
function buildPartialStage(stage: string): void {
  const rel = 'models/llm-quality/dummy-lq/model.gguf';
  const abs = path.join(stage, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const bytes = randomBytes(64 * 1024);
  fs.writeFileSync(abs, bytes);
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
    version: '1',
    models: [{
      id: 'dummy-lq',
      group: 'llm-quality',
      files: [{ path: rel, required: true, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }],
    }],
  }));
}

const SENTINEL = { staged: false, manifestPath: null, manifest: null, verify: null, loadError: null } as const;

beforeEach(() => {
  __resetElectronStub();
  hoisted.createWizardManifest.mockReset();
  hoisted.wizardManifest.mockReset();
  hoisted.createWizardManifest.mockReturnValue({ wizardManifest: hoisted.wizardManifest });
  hoisted.wizardManifest.mockReturnValue(SENTINEL);
  resolveNodeEngineMock.mockClear();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const iso = makeTempDir('131-hard-iso-');
  process.env.TRAININGAPP_DESKTOP_STORE_PATH = path.join(iso, 'profiles', 'default', 'store.sqlite');
  process.env.TRAININGAPP_DESKTOP_PACKS_DIR = path.join(iso, 'packs');
  process.env.TRAININGAPP_DESKTOP_ENGINE = 'stub';
});

afterEach(async () => {
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

describe('e1 packaged glue hardening (PR #172 review)', () => {
  it('PRR-030: the completion handler passes {fresh:true} to the wizard-manifest accessor (TOCTOU call-site proof)', async () => {
    const stage = makeTempDir('131-hard-complete-');
    buildGateStage(stage);
    setResourcesPath(stage);
    app.isPackaged = true;
    bootstrap();
    await waitFor(() => registeredChannels().includes('desktop:first-run:complete'), 'complete handler registered');
    const complete = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'desktop:first-run:complete',
    )?.[1] as (payload: unknown) => Promise<{ ok: boolean }>;
    // The sentinel makes completion itself fail closed at the manifest gate —
    // we assert the CALL SITE, not the outcome.
    // ipcMain.handle handlers receive (event, payload).
    await complete(null, { selectedProfile: 'fast', acknowledgedLicenses: true });
    const freshCalls = hoisted.wizardManifest.mock.calls.filter(
      (c) => (c[0] as { fresh?: boolean } | undefined)?.fresh === true,
    );
    expect(freshCalls.length).toBeGreaterThan(0);
  });

  it('PRR-036a: a corrupt packaged manifest blocks with a dialog that NAMES the failure', async () => {
    const stage = makeTempDir('131-hard-corrupt-');
    fs.writeFileSync(path.join(stage, 'manifest.json'), '{ not json');
    setResourcesPath(stage);
    app.isPackaged = true;
    bootstrap();
    await waitFor(() => (dialog.showErrorBox as ReturnType<typeof vi.fn>).mock.calls.length > 0, 'dialog shown');
    const call = (dialog.showErrorBox as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, string];
    expect(call[0]).toBe('TrainingApp cannot start');
    expect(call[1]).toContain(path.join(stage, 'manifest.json'));
    expect(call[1]).toContain('manifest-unreadable');
    expect(app.quit).toHaveBeenCalled();
  });

  it('PRR-036b: more than five verify failures truncate the dialog body with "…and N more"', async () => {
    const stage = makeTempDir('131-hard-trunc-');
    buildFailingStage(stage, 6);
    setResourcesPath(stage);
    app.isPackaged = true;
    bootstrap();
    await waitFor(() => (dialog.showErrorBox as ReturnType<typeof vi.fn>).mock.calls.length > 0, 'dialog shown');
    const call = (dialog.showErrorBox as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, string];
    expect(call[1]).toContain('and 1 more');
    // issue #176 AC3: a >1-failure dialog must LIST the failing paths and
    // reasons, not just the truncation suffix. The six failures are the six
    // manifest entries whose files buildFailingStage removed (manifest paths
    // are forward-slash), so the first five (pre-truncation) must appear by
    // path — a mutant that blanked the per-failure lines while keeping the
    // suffix fails here.
    for (let i = 0; i < 5; i++) {
      expect(
        call[1],
        `dialog names failing path ${i} of the six staged failures`,
      ).toContain(`models/embedding/dummy-${i}/tokenizer.json`);
    }
  });

  it('PRR-036c: a partially staged manifest degrades engineOverrides.models correctly (quality only, fast absent)', async () => {
    const stage = makeTempDir('131-hard-partial-');
    buildPartialStage(stage);
    setResourcesPath(stage);
    app.isPackaged = true;
    bootstrap();
    await waitFor(() => resolveNodeEngineMock.mock.calls.length > 0, 'resolveNodeEngine called');
    const overrides = resolveNodeEngineMock.mock.calls[0]?.[1];
    expect(overrides?.models?.quality).toBe(path.join(stage, 'models', 'llm-quality', 'dummy-lq', 'model.gguf'));
    expect(overrides?.models?.fast).toBeUndefined();
    await waitFor(() => registeredChannels().includes('desktop:get-backend'), 'backend started');
  });
});
