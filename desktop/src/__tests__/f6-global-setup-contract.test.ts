// f6-global-setup-contract.test.ts — F-AC6 supplementary leg (impl-review r1):
// pins the LOUD-FAILURE shapes of the packtool-building globalSetup. C13 only
// exercises the dist-absent happy path; these legs prove the setup fails
// loudly naming packtool/node_modules when the deps are absent, that a missing
// post-build artifact propagates the compiler output as a loud error, and that
// a complete artifact short-circuits without a rebuild.
import { afterEach, describe, expect, it, vi } from 'vitest';

const globalSetupPath = '../../test/global-setup.ts';

describe('f6 global-setup contract (issue #282 F-AC6): loud failure shapes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('fails loudly naming packtool/node_modules when the deps are absent', async () => {
    const fsMock = {
      existsSync: vi.fn((p: string) => !String(p).includes('node_modules')),
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
      existsSync: vi.fn((p: string) => !String(p).includes('typescript')),
      rmSync: vi.fn(),
    };
    vi.doMock('node:fs', () => ({ default: fsMock, ...fsMock }));
    const { default: globalSetup } = await import(globalSetupPath);
    expect(() => globalSetup()).toThrowError(/PRECONDITION_MISSING packtool\/node_modules\/typescript/);
    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });

  it('fails loudly naming the artifact when the post-build cli.js check fails', async () => {
    // Real compiler (a status-0 build), but the artifact check is forced to
    // fail — pins the error channel that names packtool/dist/cli.js and
    // carries the compiler output, without mocking node:child_process.
    const fsMock = {
      existsSync: vi.fn((p: string) => !String(p).endsWith('cli.js')),
      rmSync: vi.fn((p: unknown) => {
        void p;
      }),
    };
    vi.doMock('node:fs', () => ({ default: fsMock, ...fsMock }));
    const { default: globalSetup } = await import(globalSetupPath);
    expect(() => globalSetup()).toThrowError(/packtool build failed \(status 0\)|packtool\/dist\/cli\.js/);
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
