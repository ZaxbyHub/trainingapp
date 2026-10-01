// universal-provider-settings-overhaul (AC10): the desktop airgap flag rides
// the installer resources manifest. build-installer-manifest.mjs writes
// `airgap: true|false` (--airgap or TRAININGAPP_INSTALLER_AIRGAP=1), the
// startup integrity gate returns the verified manifest, and main/index.ts
// feeds `integrity.manifest?.airgap === true` into the engine's
// externalProvider.airgap. A missing field reads as false.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runStartupIntegrityCheck } from '../../main/integrity-check.js';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATOR = path.join(desktopDir, 'scripts', 'build-installer-manifest.mjs');
const MAIN_SOURCE = path.join(desktopDir, 'main', 'index.ts');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function stage(args: string[], env: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-airgap-'));
  tempDirs.push(dir);
  for (const [rel, size] of [
    ['models/embedding/e/onnx/model.onnx', 1024],
    ['models/llm-fast/f/model.gguf', 2048],
  ] as const) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, randomBytes(size));
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  if (env.TRAININGAPP_INSTALLER_AIRGAP === undefined) delete childEnv.TRAININGAPP_INSTALLER_AIRGAP;
  execFileSync(process.execPath, [GENERATOR, '--stage-dir', dir, '--out', path.join(dir, 'manifest.json'), ...args], {
    stdio: 'pipe',
    env: childEnv,
  });
  return dir;
}

const manifestOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { airgap?: unknown };

describe('airgap flag in the installer resources manifest', () => {
  it('defaults to false (always written)', () => {
    expect(manifestOf(stage([])).airgap).toBe(false);
  });

  it('--airgap and TRAININGAPP_INSTALLER_AIRGAP=1 both write true', () => {
    expect(manifestOf(stage(['--airgap'])).airgap).toBe(true);
    expect(manifestOf(stage([], { TRAININGAPP_INSTALLER_AIRGAP: '1' })).airgap).toBe(true);
  });

  it('the startup integrity gate returns the verified manifest carrying the flag', () => {
    const dir = stage(['--airgap']);
    const result = runStartupIntegrityCheck({ isPackaged: true, resourcesPath: dir, env: {} });
    expect(result.decision).toBe('pass');
    expect(result.manifest?.airgap).toBe(true);
  });

  it('main/index.ts wires the manifest flag and a safeStorage secret store into the engine', () => {
    const source = fs.readFileSync(MAIN_SOURCE, 'utf8');
    expect(source).toContain('integrity.manifest?.airgap === true');
    expect(source).toMatch(/createSafeStorageSecretStore\(\{\s*safeStorage,/);
    expect(source).toContain("'secrets.bin'");
  });
});
