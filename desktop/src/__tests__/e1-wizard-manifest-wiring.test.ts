// e1-wizard-manifest-wiring.test.ts — issue #131 item 3 call-site proof
// (plan-critic Round 1, R2): the extracted wizard-manifest factory must be
// WIRED into the real bootstrap(), not merely exist.
//
// RED at base, GREEN after the fix: at base the module
// desktop/main/first-run/wizard-manifest.ts does not exist and index.ts has
// no reference to createWizardManifest, so this spec fails (unresolvable
// mock target and/or createWizardManifest never called). After the fix,
// bootstrap() consults the factory, and the status path returns the MOCKED
// sentinel (staged:false) even though the fixture resources manifest on disk
// verifies clean — proving index.ts's desktop:first-run:status flows through
// the factory's wizardManifest() rather than any surviving inline closure.
//
// Mutation probe (Phase 4.5): keep the factory module but wire index.ts back
// to the old inline verifyManifest closure (or never call the factory) —
// createWizardManifest is then never called and status reports the real
// fixture's staged:true, failing both assertions below.
//
// Harness cribbed from e1-packaged-bootstrap-glue.test.ts (real bootstrap()
// against the electron stub, fixture stage built by the real manifest
// generator, isPackaged=true + process.resourcesPath assignment, isolation
// seams for store/packs/engine).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, ipcMain, __resetElectronStub } from 'electron';

const hoisted = vi.hoisted(() => ({
  createWizardManifest: vi.fn(),
  wizardManifest: vi.fn(),
}));

vi.mock('../../main/first-run/wizard-manifest.js', () => ({
  createWizardManifest: hoisted.createWizardManifest,
}));

import { bootstrap } from '../../main/index';

const SENTINEL = {
  staged: false,
  manifestPath: null,
  manifest: null,
  verify: null,
  loadError: null,
} as const;

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
  hoisted.createWizardManifest.mockReset();
  hoisted.wizardManifest.mockReset();
  // The factory is consulted at bootstrap; its wizardManifest() returns the
  // sentinel so the status path CANNOT coincide with the real fixture result.
  hoisted.createWizardManifest.mockReturnValue({ wizardManifest: hoisted.wizardManifest });
  hoisted.wizardManifest.mockReturnValue(SENTINEL);
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const iso = makeTempDir('131-wiring-iso-');
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

describe('e1 wizard-manifest factory wiring (issue #131 item 3)', () => {
  it('bootstrap() constructs the factory and the first-run status path consults its wizardManifest()', async () => {
    const stage = makeTempDir('131-wiring-pass-');
    buildGateStage(stage); // real manifest that verifies clean on disk
    setResourcesPath(stage);
    app.isPackaged = true;
    bootstrap();

    // Call-site proof: index.ts built its wizard accessor from the factory.
    await waitFor(() => hoisted.createWizardManifest.mock.calls.length > 0, 'createWizardManifest called');
    const options = hoisted.createWizardManifest.mock.calls[0]?.[0] as
      | { isPackaged?: boolean; userDataPath?: string }
      | undefined;
    expect(options?.isPackaged).toBe(true);
    expect(typeof options?.userDataPath).toBe('string');

    // The glue passed the integrity gate, so desktop:first-run:status exists.
    await waitFor(() => registeredChannels().includes('desktop:first-run:status'), 'status handler registered');
    const handle = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'desktop:first-run:status',
    )?.[1] as () => Promise<{ manifest: { staged: boolean } }>;
    const status = await handle();

    // The sentinel (staged:false) wins over the real clean fixture manifest
    // (staged:true) — only reachable if the status path consults the mocked
    // factory's wizardManifest() instead of an inline closure.
    expect(hoisted.wizardManifest.mock.calls.length).toBeGreaterThan(0);
    expect(status.manifest.staged).toBe(false);
  });
});
