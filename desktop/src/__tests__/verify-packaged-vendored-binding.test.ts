// verify-packaged-vendored-binding.test.ts — issue #350 (review finding
// dependencies-build-release-001): the packaged-bytes gate must extract the
// remapped testBindingBinary.js from app.asar and byte-compare it with the
// repo's vendored copy.
//
// The synthetic archives here are written by @electron/asar itself (the
// independent oracle for the header layout), so the dependency-free reader in
// the script is cross-validated against the format's own implementation: a
// mis-parsed header would make the byte-match row fail. @electron/asar is only
// transitively hoisted into node_modules, so these rows skip VISIBLY when it
// is absent (the CI job always has it — electron-builder depends on it).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..', '..');
const SCRIPT = path.join(desktopRoot, 'scripts', 'verify-packaged-vendored-binding.mjs');
const VENDOR = path.join(desktopRoot, 'vendor', 'node-llama-cpp', 'testBindingBinary.js');
const ENTRY = 'node_modules/node-llama-cpp/dist/bindings/utils/testBindingBinary.js';

const require = createRequire(import.meta.url);
type AsarModule = {
  createPackage: (src: string, dest: string) => Promise<void>;
  extractFile: (asar: string, file: string) => Buffer;
};
let asar: AsarModule | null = null;
try {
  asar = require('@electron/asar') as AsarModule;
} catch {
  asar = null;
}

const hasAsar = asar !== null;

/** Write a synthetic asar (via the independent oracle) containing `files`. */
async function buildAsar(files: Record<string, Buffer | null>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendored-binding-gate-'));
  const src = path.join(root, 'src');
  for (const [rel, bytes] of Object.entries(files)) {
    const full = path.join(src, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (bytes !== null) fs.writeFileSync(full, bytes);
  }
  const asarPath = path.join(root, 'app.asar');
  // @electron/asar 3.x: createPackage is async and packs the whole tree.
  await (asar as AsarModule).createPackage(src, asarPath);
  return asarPath;
}

function runGate(asarPath: string): { code: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, asarPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: typeof e.status === 'number' ? e.status : -1,
      output: `${String(e.stdout ?? '')}${String(e.stderr ?? '')}`,
    };
  }
}

describe('the packaged vendored-binding gate (issue #350 / review dependencies-build-release-001)', () => {
  it.skipIf(!hasAsar)('PASSES when the packaged entry byte-matches the vendored copy', async () => {
    const asarPath = await buildAsar({ [ENTRY]: fs.readFileSync(VENDOR) });
    const { code, output } = runGate(asarPath);
    expect(code, `gate must pass (output: ${output})`).toBe(0);
    expect(output).toContain('byte-matches the repo copy');
  });

  it.skipIf(!hasAsar)('FAILS when the packaged entry differs from the vendored copy', async () => {
    const drifted = Buffer.from(fs.readFileSync(VENDOR).toString('utf8').replace('IN-PROCESS', 'TAMPERED'), 'utf8');
    expect(drifted.equals(fs.readFileSync(VENDOR))).toBe(false);
    const asarPath = await buildAsar({ [ENTRY]: drifted });
    const { code, output } = runGate(asarPath);
    expect(code, 'a byte difference must fail the gate').toBe(1);
    expect(output).toContain('differ from the vendored copy');
  });

  it.skipIf(!hasAsar)('FAILS when the remapped entry is ABSENT from the archive (the silent-remap case)', async () => {
    // The defect class the gate exists for: electron-builder silently drops a
    // single-file FileSet `from`, so the patched module never ships. A missing
    // entry must fail loudly, not pass.
    const asarPath = await buildAsar({ 'package.json': Buffer.from('{"name":"x"}') });
    const { code, output } = runGate(asarPath);
    expect(code, 'a missing remapped entry must fail the gate').toBe(1);
    expect(output).toContain('is missing from');
  });

  it.skipIf(!hasAsar)('FAILS when the archive itself does not exist', () => {
    const { code, output } = runGate(path.join(os.tmpdir(), 'no-such-app-asar-here.app.asar'));
    expect(code).toBe(1);
    expect(output).toContain('not found');
  });

  it.skipIf(!hasAsar)('the reader agrees with @electron/asar on the synthetic archive (format cross-check)', async () => {
    const asarPath = await buildAsar({ [ENTRY]: fs.readFileSync(VENDOR) });
    // The oracle's own extractFile expects the archive's native key form
    // (backslashes on Windows); the script's reader normalizes both sides.
    const oracleKey = ENTRY.split('/').join(path.sep);
    const oracleBytes = (asar as AsarModule).extractFile(asarPath, oracleKey);
    expect(oracleBytes.equals(fs.readFileSync(VENDOR)), 'oracle extraction must match the vendored bytes').toBe(true);
    // The gate passing on this archive proves the script's own reader produced
    // the same bytes from the same header.
    expect(runGate(asarPath).code).toBe(0);
  });
});
