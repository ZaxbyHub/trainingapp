/**
 * harness-runner-contract-a.test.ts — issue #216 AC5 (frozen check C5), part A:
 * the four desktop/web_ui harness runners. Part B covers the bench drivers.
 *
 * Each runner is import-safe (importing it executes nothing — the packaged-
 * smoke entry-guard pattern) and pins its critical contract with injected
 * dependencies where the contract needs them. One test per runner, each named
 * `runner-contract: <key>` exactly as the frozen check enumerates.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveVersionArgv,
  validatePackVersion,
  main as knowledgePackMain,
} from '../../../desktop/scripts/build-knowledge-pack.mjs';
import {
  verifyPreloadFormat,
  main as verifyPreloadMain,
} from '../../../desktop/scripts/verify-preload-format.mjs';
import {
  airgapSteps,
  runStep,
  main as airgapMain,
} from '../../../web_ui/scripts/build-airgap.mjs';
import {
  createSmokeServer,
  checkIndexHtml,
  run as smokeRun,
  MIME_TYPES,
} from '../../../web_ui/scripts/smoke-coop-coep.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(dir: string): string {
  let current = dir;
  for (let i = 0; i < 32; i += 1) {
    if (fs.existsSync(path.join(current, 'contracts', 'api.openapi.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the repo root (marker contracts/api.openapi.yaml not found)');
}

const REPO_ROOT = findRepoRoot(THIS_DIR);

function readRel(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');
}

describe('harness runner contracts A (issue #216 AC5)', () => {
  it('runner-contract: build-knowledge-pack is import-safe with a validated version contract', () => {
    // Import safety: reaching this line means the import ran no build steps
    // (the entry guard held); the seams are real exports.
    expect(typeof knowledgePackMain).toBe('function');
    expect(resolveVersionArgv([])).toBe('1.0.0');
    expect(() => validatePackVersion('1.0.0')).not.toThrow();
    expect(() => validatePackVersion('../..')).toThrow(/semver/);
    expect(() => validatePackVersion('not-a-version')).toThrow(/semver/);
    const source = readRel('desktop/scripts/build-knowledge-pack.mjs');
    expect(source).toMatch(/if \(isMain\(import\.meta\.url\)\)/);
  });

  it('runner-contract: verify-preload-format pins the CommonJS sandbox preload shape', () => {
    expect(typeof verifyPreloadMain).toBe('function');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-preload-'));
    try {
      // OK fixture: CommonJS content requiring electron.
      fs.writeFileSync(path.join(tmp, 'index.cjs'), "const { contextBridge } = require('electron');\nmodule.exports = { contextBridge };\n");
      expect(verifyPreloadFormat(tmp)).toEqual([]);

      // ESM syntax in the preload must be rejected (PRR95-001).
      fs.writeFileSync(path.join(tmp, 'index.cjs'), "import { contextBridge } from 'electron';\nconst electron = require('electron');\n");
      const esmErrors = verifyPreloadFormat(tmp);
      expect(esmErrors.length).toBe(1);
      expect(esmErrors[0]).toContain('ESM syntax');

      // Missing index.cjs (with a stray index.js) must name the rename hint.
      fs.rmSync(path.join(tmp, 'index.cjs'));
      fs.writeFileSync(path.join(tmp, 'index.js'), "const electron = require('electron');\n");
      const missingErrors = verifyPreloadFormat(tmp);
      expect(missingErrors.length).toBe(1);
      expect(missingErrors[0]).toContain('missing');
    } finally {
      // PR #220 review PRR-014: never leak the fixture on an assertion failure.
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runner-contract: build-airgap runs exactly the airgap plan with VITE_AIRGAP=1 and an injected spawn seam', () => {
    expect(typeof airgapMain).toBe('function');
    const steps = airgapSteps({ npm: 'npm', node: 'node' });
    expect(steps.map((s) => s.label)).toEqual(['prepare-models', 'build', 'validate-build --airgap']);
    // The load-bearing difference vs build:offline: the validate step carries --airgap.
    expect(steps[2].args).toEqual(['node', 'scripts/validate-build.mjs', '--airgap']);

    const seen: Array<{ cmd: string; args: string[]; env: Record<string, string>; cwd: unknown; stdio: unknown }> = [];
    const spawnSyncImpl = ((cmd: string, args: string[], opts: { env: Record<string, string>; cwd: unknown; stdio: unknown }) => {
      seen.push({ cmd, args, env: opts.env, cwd: opts.cwd, stdio: opts.stdio });
      return { status: 0, error: null };
    }) as unknown as typeof import('node:child_process').spawnSync;
    const code = airgapMain({ spawnSyncImpl, log: () => {}, logError: () => {} });
    expect(code).toBe(0);
    expect(seen.length).toBe(3);
    for (const call of seen) {
      expect(call.env.VITE_AIRGAP).toBe('1');
      // PR #220 review PRR-011 + final-critic: the plan's load-bearing spawn
      // options are asserted, not assumed (cwd must be the web_ui dir, stdio
      // must stream).
      expect(String(call.cwd), 'airgap steps must run in the web_ui directory').toMatch(/[\\/]web_ui$/);
      expect(call.stdio).toBe('inherit');
    }

    // Chain-stop (PRR-011): a failing step must abort the chain — routed
    // through airgapMain (not runStep), so deleting the early return kills
    // this test.
    const failFirst = ((cmd: string, args: string[]) => {
      seen.push({ cmd, args, env: {}, cwd: undefined, stdio: undefined });
      return { status: 7, error: null };
    }) as unknown as typeof import('node:child_process').spawnSync;
    const before = seen.length;
    const failedCode = airgapMain({ spawnSyncImpl: failFirst, log: () => {}, logError: () => {} });
    expect(failedCode, 'the failing step must propagate its exit code').toBe(7);
    expect(seen.length - before, 'the chain must stop at the failing step').toBe(1);

    // runStep itself still maps a nonzero spawn to its exit code.
    const failing = ((cmd: string, args: string[]) => {
      seen.push({ cmd, args, env: {}, cwd: undefined, stdio: undefined });
      return { status: 7, error: null };
    }) as unknown as typeof import('node:child_process').spawnSync;
    const stepCode = runStep(steps[0], { env: { VITE_AIRGAP: '1' }, spawnSyncImpl: failing, logError: () => {} });
    expect(stepCode).toBe(7);
  });

  it('runner-contract: smoke-coop-coep serves COOP/COEP from a fixture dist and rejects an unchunked index', async () => {
    expect(typeof smokeRun).toBe('function');
    expect(MIME_TYPES['.html']).toContain('text/html');
    expect(checkIndexHtml('<script src="/assets/index-abc.js"></script>')).toBeNull();
    expect(checkIndexHtml('<html></html>')).toContain('assets');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-coop-'));
    try {
      fs.mkdirSync(path.join(tmp, 'assets'));
      fs.writeFileSync(path.join(tmp, 'index.html'), '<script src="/assets/index-abc.js"></script>');
      fs.writeFileSync(path.join(tmp, 'assets', 'index-abc.js'), 'console.log(1);\n');

      const code = await smokeRun({ distDir: tmp, port: 4700 + Math.floor(Math.random() * 200), log: () => {}, logError: () => {} });
      expect(code).toBe(0);

      // A missing index.html fails loud with exit 1.
      const missingCode = await smokeRun({ distDir: path.join(tmp, 'nope'), port: 4900 + Math.floor(Math.random() * 200), log: () => {}, logError: () => {} });
      expect(missingCode).toBe(1);
    } finally {
      // PR #220 review PRR-014: never leak the fixture on an assertion failure.
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // The readiness fetch stays bounded (issue #216 AC2) on the fetch( line.
    const source = readRel('web_ui/scripts/smoke-coop-coep.mjs');
    const fetchLines = source.split(/\r?\n/).filter((l) => /\bfetch(Impl)?\(/.test(l) && l.includes('await'));
    expect(fetchLines.length).toBeGreaterThan(0);
    for (const line of fetchLines) {
      expect(line, `unbounded fetch line: ${line}`).toMatch(/AbortSignal|signal:/);
    }
    // createSmokeServer is a real exported seam.
    expect(typeof createSmokeServer).toBe('function');
    // PRR-005 regression pin (final-critic): the entry guard must canonicalize
    // BOTH sides with realpathSync — a resolve()-based guard silently no-ops
    // through a Windows junction (false-green CLI). Alias-tolerant shape match.
    const guardSource = readRel('web_ui/scripts/smoke-coop-coep.mjs');
    expect(guardSource, 'entry guard must realpath both sides').toMatch(
      /ealpathSync\(process\.argv\[1\]\) === [A-Za-z]*ealpathSync\(fileURLToPath/,
    );
  });
});
