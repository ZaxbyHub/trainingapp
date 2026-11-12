// f6-global-setup-contract.test.ts — F-AC6 supplementary leg (impl-review r1):
// pins the LOUD-FAILURE shapes of the packtool-building globalSetup. C13 only
// exercises the dist-absent happy path; these legs prove the setup fails
// loudly naming packtool/node_modules when the deps are absent, that a missing
// post-build artifact propagates a loud error naming the output, and that a
// complete artifact short-circuits without a rebuild.
//
// The compiler leg mocks spawnSync (vi.hoisted, never a real tsc): a real
// ~1s compile inside a vitest worker perturbs parallel-suite scheduling enough
// to flip i320's tmpdir census race (full-suite A/B, 2026-11-11) — and the
// pinned contract is the ERROR CHANNEL, not the compiler.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const globalSetupPath = '../../test/global-setup.ts';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

describe('f6 global-setup contract (issue #282 F-AC6): loud failure shapes', () => {
  const ORIGINAL_SKIP_ENV = process.env.TRAININGAPP_SKIP_PACKTOOL_GLOBAL_SETUP;

  beforeEach(() => {
    // Env-independent spec (fix-reviewer r1 nit): the documented CI opt-out
    // (pr323 review PRR-001) must not flip these legs — globalSetup consults
    // the env at call time, so a caller-exported TRAININGAPP_SKIP_...
    // would otherwise fail leg 1. Cleared BEFORE each test; restored in
    // afterAll.
    delete process.env.TRAININGAPP_SKIP_PACKTOOL_GLOBAL_SETUP;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mocks.spawnSync.mockReset();
  });

  afterAll(() => {
    if (ORIGINAL_SKIP_ENV !== undefined) {
      process.env.TRAININGAPP_SKIP_PACKTOOL_GLOBAL_SETUP = ORIGINAL_SKIP_ENV;
    }
  });

  it('fails loudly naming packtool/node_modules when the deps are absent', async () => {
    const fsMock = {
      // Hide the deps AND the complete artifact: keep-if-complete precedes
      // the precondition, so both must be absent for the throw to be reachable.
      existsSync: vi.fn(() => false),
      rmSync: vi.fn(),
    };
    vi.doMock('node:fs', () => ({ default: fsMock, ...fsMock }));
    const { default: globalSetup } = await import(globalSetupPath);
    expect(() => globalSetup()).toThrowError(/PRECONDITION_MISSING packtool\/node_modules/);
    // The compiler is never invoked when the precondition fails.
    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });

  it('fails loudly naming packtool/node_modules/typescript when only typescript is absent', async () => {
    const fsMock = {
      existsSync: vi.fn(
        (p: string) => !String(p).includes('typescript') && !String(p).endsWith('cli.js'),
      ),
      rmSync: vi.fn(),
    };
    // cli.js must also be absent (keep-if-complete precedes the precondition).
    vi.doMock('node:fs', () => ({ default: fsMock, ...fsMock }));
    const { default: globalSetup } = await import(globalSetupPath);
    expect(() => globalSetup()).toThrowError(/PRECONDITION_MISSING packtool\/node_modules\/typescript/);
    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });

  it('fails loudly naming the artifact when the post-build cli.js check fails', async () => {
    // status-0 compile but the artifact check fails — pins the error channel
    // that names packtool/dist/cli.js and carries the compiler output.
    const fsMock = {
      existsSync: vi.fn((p: string) => !String(p).endsWith('cli.js')),
      rmSync: vi.fn(),
    };
    mocks.spawnSync.mockReturnValue({ status: 0, stderr: '', stdout: '' });
    vi.doMock('node:fs', () => ({ default: fsMock, ...fsMock }));
    vi.doMock('node:child_process', () => ({ default: { spawnSync: mocks.spawnSync }, spawnSync: mocks.spawnSync }));
    const { default: globalSetup } = await import(globalSetupPath);
    expect(() => globalSetup()).toThrowError(/packtool build failed \(status 0\)[\s\S]*packtool\/dist\/cli\.js/);
    // Deterministic-in-any-worktree: the stale artifact was removed first.
    expect(fsMock.rmSync).toHaveBeenCalled();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed compiler run with the compiler output', async () => {
    // Deps present, cli.js absent post-build (the rebuild path runs).
    const fsMock = {
      existsSync: vi.fn((p: string) => !String(p).endsWith('cli.js')),
      rmSync: vi.fn(),
    };
    mocks.spawnSync.mockReturnValue({ status: 1, stderr: 'error TS9999: simulated failure', stdout: '' });
    vi.doMock('node:fs', () => ({ default: fsMock, ...fsMock }));
    vi.doMock('node:child_process', () => ({ default: { spawnSync: mocks.spawnSync }, spawnSync: mocks.spawnSync }));
    const { default: globalSetup } = await import(globalSetupPath);
    expect(() => globalSetup()).toThrowError(/packtool build failed \(status 1\)[\s\S]*simulated failure/);
    expect(fsMock.rmSync).toHaveBeenCalled();
  });

  it('returns silently when a complete artifact already exists (no rebuild)', async () => {
    const fsMock = {
      // Everything present (deps + typescript + cli.js) -> early return.
      existsSync: vi.fn(() => true),
      rmSync: vi.fn(),
    };
    vi.doMock('node:fs', () => ({ default: fsMock, ...fsMock }));
    const { default: globalSetup } = await import(globalSetupPath);
    expect(() => globalSetup()).not.toThrow();
    // The stale-artifact removal (and therefore the rebuild) never happens.
    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });
});
