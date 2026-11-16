// packaged-vulkan-binding.test.ts — issue #350 (AC1, executable discriminating
// leg): the vendored node-llama-cpp binding test is EXECUTED with a full
// NATIVE OPERATION TRACE, through getLlama's own static import under the
// utility-process host, and against CALLABLE controlled failure-injection addons.
//
// FROZEN ACCEPTANCE SURFACE (trace 350-351-packaged-gpu-fuse-external-timeouts,
// check C1; revision 6 after plan critic r5 — r5 found: (F1) a loadBackends-only
// stub passes a getGpuType-transition-only proof, so the proof now requires the
// COMPLETE operation sequence with INIT COUNTS via a spy that patches the SHARED
// real addon instance (require-cache singleton — getLlama's own require records
// into the same log, making init #1 [test] and init #2 [Llama._create] both
// observable); (F2) the r5 fake addons were malformed (JSON.stringify emitted
// function SOURCES as string properties — rows passed on early TypeErrors), so
// the fakes now emit REAL callable methods and each row asserts exactly which
// operations were REACHED; (F3) hung-init containment executes in a DISPOSABLE
// CHILD under a real parent runner (kill observed), and a real post-init failure
// is followed by a healthy CPU getLlama in the same process; (F4) the remapped
// getLlama call runs INSIDE the utility host so the vendored IN-PROCESS branch
// is exercised through getLlama itself).
//
// RED at base (no vendor file -> import throws; no pin; no remap lines; no
// tap), GREEN after the fix. The full packaged boot incl. app.asar extraction
// and /status/models gpu.backend === "vulkan" is AC7 (NON-EXECUTABLE,
// HOST_ONLY); see 02-reproduction.md.
//
// HOST-ADAPTIVE DESIGN (review finding tests-falsifiability-001, critic-UPHELD
// HIGH; amendment v17): the two POSITIVE rows (groups A and B) originally
// hard-asserted a successful Vulkan selection, which no GPU-less runner can
// satisfy — the required CI job was red at head with 2/1913 failing while the
// vendored module behaved CORRECTLY (refused, CPU fallback). The rows now gate
// their positive expectations on vulkanHostCapable(), an INDEPENDENT probe that
// drives the real addon directly (never the vendored module — a signal taken
// from the code under test would make the rows prove themselves). On a
// GPU-less host the same rows assert the REFUSAL path (false + CPU fallback +
// the full native op sequence up to the mismatch), so the #350 core proof —
// getLlama reaches the REMAPPED vendored module — still executes in CI. The
// environment-independent rows (fake-addon groups C/D, the mismatch row, the
// poison row, the drift pin, the yml remap rows) are unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test, afterEach, afterAll } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..', '..'); // desktop/

const VENDOR_PATH = path.join(desktopRoot, 'vendor', 'node-llama-cpp', 'testBindingBinary.js');
const PRISTINE_PATH = path.join(desktopRoot, 'vendor', 'node-llama-cpp', 'PRISTINE.sha256');
const DIST_PATH = path.join(
  desktopRoot, 'node_modules', 'node-llama-cpp', 'dist', 'bindings', 'utils', 'testBindingBinary.js',
);
const VULKAN_BINS_ROOT = path.join(desktopRoot, 'node_modules', '@node-llama-cpp', 'win-x64-vulkan', 'bins');
const DIST_REL = 'node_modules/node-llama-cpp/dist/bindings/utils/testBindingBinary.js';
const VENDOR_DIR_REL = 'vendor/node-llama-cpp';
const VENDOR_DEST_REL = 'node_modules/node-llama-cpp/dist/bindings/utils';
const DIST_FILE_REL = 'testBindingBinary.js';

const requireHere = createRequire(import.meta.url);

/**
 * Review finding tests-falsifiability-002: the group-B row overwrites a file
 * inside the shared (gitignored) node_modules tree. Vitest's withTimeout
 * rejects its OUTER promise without cancelling the pending test body, so a hung
 * getLlama never reaches the in-test finally. This backup + afterEach is the
 * timeout-safe net: the dependency file is restored even when the test body is
 * abandoned (CI checks out fresh each run, but a local tree must not be left
 * with a wrapper where the upstream module belongs — the drift row would then
 * fail misleadingly on the NEXT run).
 */
let distBackup: string | null = null;
afterEach(() => {
  if (distBackup !== null) {
    fs.writeFileSync(DIST_PATH, distBackup, 'utf8');
    distBackup = null;
  }
});

/** Review finding test-infrastructure-002: every fixture directory this spec
 *  creates under os.tmpdir(), removed in afterAll (the original spec leaked
 *  them on every run). */
const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function urlPath(p: string): string {
  return pathToFileURL(p).href;
}

function bogusPath(tag: string): string {
  return path.join(os.tmpdir(), `not-a-binding-${tag}-${process.pid}.node`);
}

async function withUtilityHost<T>(fn: () => Promise<T>): Promise<T> {
  const versionsDesc = Object.getOwnPropertyDescriptor(process, 'versions') as PropertyDescriptor;
  const parentDesc = Object.getOwnPropertyDescriptor(process, 'parentPort');
  Object.defineProperty(process, 'versions', {
    value: { ...process.versions, electron: '45.2.1' },
    configurable: true,
  });
  Object.defineProperty(process, 'parentPort', {
    value: { postMessage: () => undefined, on: () => undefined },
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'versions', versionsDesc);
    if (parentDesc) Object.defineProperty(process, 'parentPort', parentDesc);
    else delete (process as unknown as { parentPort?: unknown }).parentPort;
  }
}

async function vendored(): Promise<{
  testBindingBinary: (b: string, e?: string, g?: unknown) => Promise<boolean>;
}> {
  expect(fs.existsSync(VENDOR_PATH), `desktop/vendor/node-llama-cpp/testBindingBinary.js must exist (${VENDOR_PATH})`).toBe(true);
  const mod = (await withUtilityHost(() => import(urlPath(VENDOR_PATH)))) as {
    testBindingBinary: (b: string, e?: string, g?: unknown) => Promise<boolean>;
  };
  expect(typeof mod.testBindingBinary, 'vendored module must export testBindingBinary').toBe('function');
  return mod;
}

function findVulkanBinding(): string {
  for (const leaf of fs.readdirSync(VULKAN_BINS_ROOT)) {
    const leafDir = path.join(VULKAN_BINS_ROOT, leaf);
    if (!fs.statSync(leafDir).isDirectory()) continue;
    for (const name of fs.readdirSync(leafDir)) {
      if (name.endsWith('.node')) return path.join(leafDir, name);
    }
  }
  throw new Error('no .node under ' + VULKAN_BINS_ROOT);
}

/**
 * Review finding tests-falsifiability-001 (swarm-pr-review run
 * pr-review-pr352-20261115, critic-UPHELD HIGH): the frozen AC1 positive rows
 * hard-asserted a successful Vulkan selection, which is IMPOSSIBLE on a
 * GPU-less runner (the CI windows-latest host) — there the vendored in-process
 * test correctly returns false and getLlama correctly falls back to CPU, so
 * the required "Electron shell" check was red at head with 2/1913 failing.
 *
 * This probe is the INDEPENDENT capability signal the positive rows now gate
 * on. It drives the REAL shipped addon directly and NEVER the vendored module:
 * a capability signal taken from the code under test would make the rows prove
 * themselves. A GPU-less host yields false, and the rows then assert the
 * REFUSAL path — which still exercises the remapped module through getLlama —
 * instead of skipping, so CI keeps the #350 core proof on every host.
 */
async function vulkanHostCapable(): Promise<boolean> {
  try {
    const bindingPath = findVulkanBinding();
    const binding = requireHere(bindingPath) as {
      setLoggerLogLevel?: (level: number) => void;
      loadBackends: (p?: string) => void;
      init: () => Promise<unknown>;
      getGpuType: () => unknown;
    };
    // The upstream ladder (testBindingBinary.js:314-323): the default
    // loadBackends() does not pick up the GPU backend on every host — the
    // binding's OWN directory does. Mirror that, then init, then read the
    // POST-init type, which is the same signal the vendored body's equality
    // check uses.
    binding.loadBackends();
    if (binding.getGpuType() !== 'vulkan') {
      binding.loadBackends(path.dirname(path.resolve(bindingPath)));
    }
    await binding.init();
    return binding.getGpuType() === 'vulkan';
  } catch {
    return false;
  }
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * r6-F1 resolution. The native addon's exports are non-enumerable/non-writable
 * (Object.keys finds nothing; property mutation is impossible), and getLlama
 * EVICTS the binding from require.cache before loading (getLlama.js:549-563),
 * so no shared-mutation spy can work. Instead:
 *   - FACADE PRE-SEED: require.cache[realPath] is seeded with a test-owned
 *     facade (prototype-linked to the real exports, own wrapped props for the
 *     known operation set) that records the VENDORED TEST's own call sequence
 *     into a shared log — proving the complete body ran natively, in order.
 *   - WRAPPER FILE (group B): the installed dist file is overwritten with a
 *     test-owned wrapper that re-exports the vendored testBindingBinary and
 *     counts invocations in globalThis.__tblCalls — surviving getLlama's cache
 *     eviction because it IS the file getLlama loads. gpu === 'vulkan' through
 *     that call is the EFFECT-PROOF of Llama._create's init #2 (the addon
 *     itself cannot be patched; disclosed residual).
 */
const FACADE_OPS = ['setLoggerLogLevel', 'loadBackends', 'getGpuType', 'init', 'getGpuVramInfo', 'getGpuDeviceInfo', 'getSystemMemoryInfo', 'ensureGpuDeviceIsSupported'];

function seedFacade(realBindingPath: string, log: string[]): () => void {
  const real = requireHere(realBindingPath) as Record<string, unknown>;
  const facade = Object.create(real) as Record<string, unknown>;
  for (const name of FACADE_OPS) {
    const value = real[name];
    if (typeof value !== 'function') continue;
    // r7-F1: the inherited native property is NON-WRITABLE, so plain assignment
    // silently no-ops in sloppy mode (or throws in strict mode). defineProperty
    // on the facade creates an OWN shadowing property that records the call.
    Object.defineProperty(facade, name, {
      value: (...args: unknown[]) => {
        log.push(name);
        return (value as (...a: unknown[]) => unknown)(...args);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
    if (!Object.prototype.hasOwnProperty.call(facade, name)) {
      throw new Error(`facade wrapper for ${name} is not an own property (defineProperty failed)`);
    }
  }
  // Proof the instrumentation is live BEFORE the vendored body runs: one known
  // call through the facade must land in the log.
  (facade.getGpuType as () => unknown)();
  if (!log.includes('getGpuType')) {
    throw new Error('facade instrumentation failed to record a known call');
  }
  log.length = 0; // start the measured window clean
  const resolved = requireHere.resolve(realBindingPath);
  const prior = requireHere.cache[resolved];
  requireHere.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: facade,
  } as unknown as NonNullable<(typeof requireHere.cache)[string]>;
  return () => {
    if (prior) requireHere.cache[resolved] = prior;
    else delete requireHere.cache[resolved];
  };
}

/** The test-owned wrapper installed at the dist path in group B: counts
 *  testBindingBinary invocations (survives cache eviction; it IS the file). */
function writeWrapperFile(vendorPath: string): string {
  const src = `
import { testBindingBinary as impl } from ${JSON.stringify(urlPath(vendorPath))};
// r7-F2: counts INVOCATIONS ONLY (no module-evaluation increment — an
// evaluate-without-call must leave the counter at 0 and fail the row).
globalThis.__tblCalls = 0;
const wrapped = (...args) => {
  globalThis.__tblCalls = (globalThis.__tblCalls ?? 0) + 1;
  return impl(...args);
};
export { wrapped as testBindingBinary };
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbl-wrapper-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'testBindingBinary.wrapper.mjs');
  fs.writeFileSync(file, src, 'utf8');
  return file;
}

const OPS_HEAD_EXPECTED = ['loadBackends', 'getGpuType', 'init', 'getGpuVramInfo', 'getGpuDeviceInfo', 'getSystemMemoryInfo'];

/**
 * r6-F2: generate a CONTROLLED fake addon with the upstream call SHAPES —
 * sync methods everywhere EXCEPT init (upstream awaits init; calls
 * ensureGpuDeviceIsSupported() synchronously, so an async support fake would
 * produce an unhandled rejection and the body would continue). Every method
 * appends its name to globalThis.__fakeAddonOps; rows assert WHICH OPS WERE
 * REACHED and that no unhandled rejection fired during the row.
 */
function writeFakeAddon(overrides: Record<string, string>): { path: string; ops: () => string[] } {
  const m = (name: string, impl: string): string =>
    `${name}() { globalThis.__fakeAddonOps.push(${JSON.stringify(name)}); ${impl} }`;
  const src = `
globalThis.__fakeAddonOps = [];
module.exports = {
  ${m('setLoggerLogLevel')}
  ,${m('loadBackends', overrides.loadBackends ?? '')}
  ,getGpuType() { globalThis.__fakeAddonOps.push('getGpuType'); return ${overrides.getGpuType ?? `'vulkan'`}; }
  ,async init() { globalThis.__fakeAddonOps.push('init'); ${overrides.init ?? ''} }
  ,${m('getGpuVramInfo', overrides.getGpuVramInfo ?? '')}
  ,${m('getGpuDeviceInfo', overrides.getGpuDeviceInfo ?? '')}
  ,${m('getSystemMemoryInfo', overrides.getSystemMemoryInfo ?? '')}
  ,${m('ensureGpuDeviceIsSupported', overrides.ensureGpuDeviceIsSupported ?? '')}
};
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-addon-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'fake-addon.cjs');
  fs.writeFileSync(file, src, 'utf8');
  return { path: file, ops: () => (globalThis.__fakeAddonOps as unknown as string[]) ?? [] };
}

/** Track unhandledRejection during a row (r6-F2: an async support fake would
 *  fire one and the body would continue — the row must be rejection-clean). */
async function withNoUnhandledRejection<T>(fn: () => Promise<T>): Promise<{ result: T; rejections: string[] }> {
  const rejections: string[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', onRejection);
  try {
    return { result: await fn(), rejections };
  } finally {
    process.off('unhandledRejection', onRejection);
  }
}

async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = origErr;
  }
}

describe('#350 AC1 group B (FIRST: before any nlc-sibling import — the getLlama.js STATIC import of testBindingBinary.js binds at first module load, so the overwrite must precede every earlier group lazy Llama.js/config.js import): the remapped module IS what getLlama executes, under the utility host (in-process branch)', () => {
  test('overwrite the installed dist file with the test-owned wrapper; getLlama (utility host) runs the remapped vendored test; invocation counted', async () => {
    expect(fs.existsSync(VENDOR_PATH), 'vendor file must exist').toBe(true);
    expect(fs.existsSync(DIST_PATH), 'installed nlc dist testBindingBinary must exist').toBe(true);
    const binding = findVulkanBinding();
    const wrapperFile = writeWrapperFile(VENDOR_PATH);
    const wrapperBytes = fs.readFileSync(wrapperFile, 'utf8');
    const backup = fs.readFileSync(DIST_PATH, 'utf8');
    // Independent host capability (review tests-falsifiability-001) — computed
    // before the overwrite so a probe failure can never leave the shared
    // dependency tree modified.
    const capable = await vulkanHostCapable();
    globalThis.__tblCalls = 0;
    // Timeout-safe restore net (review tests-falsifiability-002): vitest's
    // withTimeout rejects its OUTER promise without cancelling the pending
    // test body, so a hung getLlama never reaches the in-test finally. The
    // afterEach below restores from this backup in that case.
    distBackup = backup;
    let llama: { gpu: unknown; dispose: () => Promise<void> } | null = null;
    try {
      // THE PACKAGER'S REMAP, performed in dev — but with the TEST-OWNED
      // wrapper (which itself forwards to the vendored file) so the invocation
      // counter survives getLlama's require.cache eviction (r6-F1).
      fs.writeFileSync(DIST_PATH, wrapperBytes, 'utf8');
      const nlc = await import('node-llama-cpp');
      // r5-F4: the getLlama call runs INSIDE the utility-process host, so the
      // vendored file's in-process branch (runningInElectron && parentPort) is
      // the path getLlama's own test call takes — no fork, same process.
      llama = (await withUtilityHost(() => nlc.getLlama({ gpu: { type: 'auto', exclude: ['cuda'] }, build: 'never' }))) as never;
      // UNCONDITIONAL — the #350 core proof, host-independent: getLlama's OWN
      // binding-test call reached the REMAPPED vendored module through the
      // wrapper (the counter survives getLlama's require-cache eviction
      // because the wrapper IS the file getLlama loads). On a GPU-less host
      // the vendored in-process leg runs, refuses, and getLlama falls back to
      // CPU — the CI stderr captured at the review head proved exactly this
      // chain ("Failed to load a prebuilt ... Expected: vulkan, got: false"),
      // so this assertion holds on every host.
      expect(
        (globalThis.__tblCalls ?? 0) >= 1,
        'the wrapper invocation counter must record getLlama reaching the vendored test (cache-eviction survivor)',
      ).toBe(true);
      // Host-dependent EFFECT: a Vulkan-capable host must select vulkan
      // (init #2 EFFECT-PROOF — gpu==='vulkan' requires Llama._create's own
      // _init to have succeeded on the real addon, non-patchable residual); a
      // GPU-less host must fall back to CPU — never hang, never crash.
      expect(
        (llama as { gpu: unknown }).gpu,
        capable
          ? 'getLlama running the WRAPPER->vendored test must still select vulkan'
          : 'on a host without a Vulkan device the remapped vendored test must refuse and getLlama must fall back to CPU',
      ).toBe(capable ? 'vulkan' : false);
    } finally {
      fs.writeFileSync(DIST_PATH, backup, 'utf8'); // restore pristine bytes
      distBackup = null;
      if (llama) await llama.dispose().catch(() => undefined);
    }
  }, 300_000);
});

describe('#350 AC1 group A: the complete native operation sequence via the facade (r6-F1/F4)', () => {
  test('the vendored test performs the FULL ordered sequence (final getGpuType read +, on a capable host, the support check), with exactly one init', async () => {
    const mod = await vendored();
    const binding = findVulkanBinding();
    const log: string[] = [];
    // Independent host capability (review tests-falsifiability-001): computed
    // BEFORE the facade is installed so the probe's own native calls never
    // land in the measured ops log (the "exactly one init" row counts only
    // calls the facade recorded).
    const capable = await vulkanHostCapable();
    const restore = seedFacade(binding, log);
    try {
      // NOTE: group B legitimately runs this same real addon first, so the
      // getGpuType() before-state is order-fragile and NOT asserted — the
      // facade ops log (below) is the proof the TEST itself drove the sequence.
      const addon = requireHere(binding) as { getGpuType: () => unknown };
      const ok = await withUtilityHost(() => mod.testBindingBinary(binding, undefined, 'vulkan'));
      // Both outcomes are the CORRECT contract and both prove the body ran:
      // a Vulkan-capable host must be ACCEPTED; a GPU-less host (the CI
      // windows-latest runner) must be REFUSED — never crash, never hang.
      expect(
        ok,
        capable
          ? 'the vendored in-process test must accept the shipped vulkan prebuilt'
          : 'on a host without a Vulkan device the vendored in-process test must refuse (return false), not crash or hang',
      ).toBe(capable);
      // r6-F4: the COMPLETE upstream sequence, in order, INCLUDING the final
      // getGpuType equality read and — on a capable host — the support check.
      // A GPU-less host throws the mismatch BEFORE ensureGpuDeviceIsSupported,
      // so that op is expected only when the host can actually run the binary.
      const expected = capable
        ? ['loadBackends', 'getGpuType', 'init', 'getGpuVramInfo', 'getGpuDeviceInfo', 'getSystemMemoryInfo', 'getGpuType', 'ensureGpuDeviceIsSupported']
        : ['loadBackends', 'getGpuType', 'init', 'getGpuVramInfo', 'getGpuDeviceInfo', 'getSystemMemoryInfo', 'getGpuType'];
      let cursor = 0;
      for (const op of expected) {
        const at = log.indexOf(op, cursor);
        expect(at, `native op '${op}' must be recorded in order (log=${JSON.stringify(log)})`).toBeGreaterThanOrEqual(0);
        cursor = at + 1;
      }
      expect(
        log.filter((op) => op === 'init').length,
        `exactly one init in the direct-test log (log=${JSON.stringify(log)})`,
      ).toBe(1);
      if (capable) {
        expect(String(addon.getGpuType()), 'after the test the addon reports vulkan').toBe('vulkan');
      }
    } finally {
      restore();
    }
  }, 180_000);
});

describe('#350 AC1 group C: controlled failure injection through the vendored body (callable fakes, ops-reached asserted)', () => {
  test('init-throw fake: FALSE + field-shaped console.error line; ops stop AT init (no later probes run)', async () => {
    const mod = await vendored();
    const fake = writeFakeAddon({
      init: `throw new Error('injected init failure');`,
    });
    const { result, lines } = await captureErrors(() =>
      withUtilityHost(() => mod.testBindingBinary(fake.path, undefined, 'vulkan')),
    );
    expect(result, 'an init throw must resolve FALSE, never escape').toBe(false);
    expect(lines.some((l) => /Failed to load a prebuilt/.test(l)), 'rejection must ride the console.error channel').toBe(true);
    const ops = fake.ops();
    expect(ops, `ops must show the body ran up to init (got ${JSON.stringify(ops)})`).toContain('init');
    expect(ops, `no probe may run after the init throw (got ${JSON.stringify(ops)})`).not.toContain('getGpuVramInfo');
  }, 60_000);

  test('support-check throw fake (SYNC throw, upstream call shape): FALSE; ops through the memory probe, support check LAST, no unhandled rejection', async () => {
    const mod = await vendored();
    const fake = writeFakeAddon({
      ensureGpuDeviceIsSupported: `throw new Error('unsupported device injected');`,
    });
    const { result, rejections } = await withNoUnhandledRejection(() =>
      captureErrors(() =>
        withUtilityHost(() => mod.testBindingBinary(fake.path, undefined, 'vulkan')),
      ),
    );
    expect(result.result, 'a support-check throw must resolve FALSE, never escape').toBe(false);
    expect(result.lines.some((l) => /Failed to load a prebuilt/.test(l)), 'rejection must ride the console.error channel').toBe(true);
    const ops = fake.ops();
    for (const reached of ['loadBackends', 'init', 'getGpuVramInfo', 'getGpuDeviceInfo']) {
      expect(ops, `op '${reached}' must have run before the support check (got ${JSON.stringify(ops)})`).toContain(reached);
    }
    expect(ops[ops.length - 1], `the support check must be the LAST op reached (got ${JSON.stringify(ops)})`).toBe('ensureGpuDeviceIsSupported');
    expect(rejections, `no unhandled rejection may fire (got ${JSON.stringify(rejections)})`).toEqual([]);
  }, 60_000);

  test('GPU-type mismatch (real binary as cuda): FALSE, then a healthy CPU getLlama in the SAME process', async () => {
    const mod = await vendored();
    const nlc = await import('node-llama-cpp');
    const binding = findVulkanBinding();
    const { result } = await captureErrors(() =>
      withUtilityHost(() => mod.testBindingBinary(binding, undefined, 'cuda')),
    );
    expect(result, 'a gpu-type mismatch must be rejected, not crash').toBe(false);
    // r5-F3: real post-init failure followed by healthy CPU load, same process.
    const llama = (await nlc.getLlama({ gpu: false, build: 'never' })) as never as {
      gpu: unknown; dispose: () => Promise<void>;
    };
    try {
      expect(llama.gpu, 'CPU load after a real mismatch rejection must work').toBe(false);
    } finally {
      await llama.dispose().catch(() => undefined);
    }
  }, 240_000);

  test('post-init GPU-type transition fake: requesting the PRE-init type must be REJECTED (stale-comparison mutant fails)', async () => {
    const mod = await vendored();
    // getGpuType returns 'cuda' BEFORE init flips it to 'vulkan' (r7-F3; the
    // override is an EXPRESSION — the generator supplies the return — r8-F1).
    // The upstream body reads getGpuType for the ladder, then init, then
    // re-reads getGpuType for the equality check: requested 'cuda' vs post-init
    // 'vulkan' must THROW "Binary GPU type mismatch" -> FALSE. A stale
    // implementation that compares the PRE-init first read ('cuda' === 'cuda')
    // would return TRUE and fail this row.
    globalThis.__transitionFlipped = false;
    const fake = writeFakeAddon({
      getGpuType: `globalThis.__transitionFlipped ? 'vulkan' : 'cuda'`,
      init: `globalThis.__transitionFlipped = true;`,
    });
    const { result, lines } = await captureErrors(() =>
      withUtilityHost(() => mod.testBindingBinary(fake.path, undefined, 'cuda')),
    );
    expect(result, 'a pre-init/post-init GPU transition must reject the stale pre-init request (r7-F3)').toBe(false);
    // r8-F1: the mismatch must be the SPECIFIC upstream error (a require-time
    // syntax failure of a malformed fake must NOT satisfy this row).
    expect(
      lines.some((l) => /Binary GPU type mismatch/.test(l)),
      `the rejection must be the upstream mismatch error, not a require failure (lines=${JSON.stringify(lines)})`,
    ).toBe(true);
    // Ops-reached: the body must have run THROUGH the final getGpuType read
    // (pre-init read, init, final read) and stopped before the support check
    // (the mismatch throw precedes ensureGpuDeviceIsSupported upstream).
    const ops = fake.ops();
    expect(ops, `ops must reach init (got ${JSON.stringify(ops)})`).toContain('init');
    expect(ops.filter((op) => op === 'getGpuType').length, `getGpuType must be read at least twice (ladder + final; got ${JSON.stringify(ops)})`).toBeGreaterThanOrEqual(2);
    expect(ops, `the support check must not run after the mismatch throw (got ${JSON.stringify(ops)})`).not.toContain('ensureGpuDeviceIsSupported');
  }, 60_000);

  test('bogus binding path: FALSE + field-shaped console.error line (require failure channel)', async () => {
    const mod = await vendored();
    const { result, lines } = await captureErrors(() =>
      withUtilityHost(() => mod.testBindingBinary(bogusPath('reject'), undefined, 'vulkan')),
    );
    expect(result, 'a bogus binding path must be REJECTED by the in-process test, not crash the host').toBe(false);
    expect(lines.some((l) => /Failed to load a prebuilt/.test(l)), 'rejection must ride the console.error channel').toBe(true);
  }, 60_000);
});

describe('#350 AC1 group D: hung-init containment executes in a DISPOSABLE CHILD (r6-F3)', () => {
  test('a utility-host child running the vendored test against a hung fake addon is TERMINATED by the parent (signal observed, never settles)', async () => {
    const mod = await vendored();
    const fake = writeFakeAddon({
      init: `return new Promise(() => {});`,
    });
    // r6-F3: the child installs the UTILITY HOST itself (process.versions.electron
    // + parentPort) BEFORE importing the vendored module, so the child takes the
    // same in-process branch getLlama/probe take — not the upstream fork branch.
    let childSrc = `
      Object.defineProperty(process, 'versions', { value: { ...process.versions, electron: '45.2.1' }, configurable: true });
      Object.defineProperty(process, 'parentPort', { value: { postMessage: () => undefined, on: () => undefined }, configurable: true });
      import(${JSON.stringify(urlPath(VENDOR_PATH))}).then((m) =>
        m.testBindingBinary(${JSON.stringify(fake.path)}, undefined, 'vulkan'),
      ).then(
        (r) => { console.log('SETTLED:' + String(r)); process.exit(0); },
        (e) => { console.log('REJECTED:' + String(e && e.message)); process.exit(1); },
      );
    `;
    const childFile = path.join(path.dirname(fake.path), 'hung-driver.mjs');
    // CHECK_WRONG (implementation-discovered): the child ALSO needs a ref'd
    // keep-alive handle — a pending promise does NOT keep the Node event loop
    // alive, so without one the child drains and exits 0 in ~350ms, before any
    // kill could land (this row could never go GREEN as frozen). A REAL hung
    // probe process holds open handles (parentPort listener, IPC), so the
    // keep-alive is the faithful hung-process model; the settle paths clear it
    // so process.exit still works.
    childSrc = `const childDriverKeepAlive = setInterval(() => {}, 3600_000);
${childSrc}`;
    childSrc = childSrc.replace(
      "(r) => { console.log('SETTLED:' + String(r)); process.exit(0); },",
      "(r) => { clearInterval(childDriverKeepAlive); console.log('SETTLED:' + String(r)); process.exit(0); },",
    );
    childSrc = childSrc.replace(
      "(e) => { console.log('REJECTED:' + String(e && e.message)); process.exit(1); },",
      "(e) => { clearInterval(childDriverKeepAlive); console.log('REJECTED:' + String(e && e.message)); process.exit(1); },",
    );
    fs.writeFileSync(childFile, childSrc, 'utf8');
    const child = spawn(process.execPath, [childFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    // gpu-probe.ts's contract: arm a run timeout, kill the disposable child,
    // observe the termination as a SIGNAL (not a clean exit), and classify the
    // non-settle as a cpu verdict. Tight 3s bound here.
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const killer = setTimeout(() => { child.kill(); }, 3_000);
      child.on('exit', (code, signal) => {
        clearTimeout(killer);
        resolve({ code, signal });
      });
    });
    expect(outcome.signal, `the child must be TERMINATED by signal (got code=${outcome.code} signal=${outcome.signal})`).toBe('SIGTERM');
    expect(outcome.code, 'no clean exit (a hung test is never a pass)').toBeNull();
    expect(stdout, `the child must never settle the test (stdout=${JSON.stringify(stdout)})`).not.toContain('SETTLED:true');
  }, 60_000);
});

describe('#350 AC1: same-process double-init safety (executed with the spy)', () => {
  test('a failed in-process test does not poison the later CPU getLlama', async () => {
    const mod = await vendored();
    const nlc = await import('node-llama-cpp');
    const result = await withUtilityHost(() => mod.testBindingBinary(bogusPath('poison'), undefined, 'vulkan'));
    expect(result, 'precondition: bogus path rejected').toBe(false);
    const llama = (await nlc.getLlama({ gpu: false, build: 'never' })) as never as {
      gpu: unknown; dispose: () => Promise<void>;
    };
    try {
      expect(llama.gpu, 'CPU load after a failed vulkan in-process test must work').toBe(false);
    } finally {
      await llama.dispose().catch(() => undefined);
    }
  }, 240_000);
});

describe('#350 AC1: the drift pin matches the ACTUAL installed bytes', () => {
  test('PRISTINE.sha256 equals the sha256 of the installed dist file and names the installed version', () => {
    expect(fs.existsSync(PRISTINE_PATH), 'desktop/vendor/node-llama-cpp/PRISTINE.sha256 must exist').toBe(true);
    const pin = fs.readFileSync(PRISTINE_PATH, 'utf8');
    const pinnedHash = (pin.match(/\b[0-9a-f]{64}\b/) ?? [])[0];
    expect(pinnedHash, 'pin must record a 64-hex sha256').toBeTruthy();
    expect(fs.existsSync(DIST_PATH), 'installed nlc dist file must exist').toBe(true);
    expect(
      sha256(DIST_PATH),
      'drift: installed testBindingBinary.js bytes differ from the PRISTINE.sha256 pin — re-pin and re-verify the vendored patch on any nlc bump. If a group-B run was interrupted mid-overwrite, restore the pristine tree first: npm --prefix desktop ci',
    ).toBe(pinnedHash);
    const pkgVersion: string = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, 'node_modules', 'node-llama-cpp', 'package.json'), 'utf8'),
    ).version;
    expect(pin, `pin must record the installed nlc version (${pkgVersion})`).toContain(pkgVersion);
  });
});

describe('#350 AC1: electron-builder remaps the vendored file with EXACT paths', () => {
  test('files excludes the original dist path and maps vendor -> dist (structured exact-string lines)', () => {
    const yml = fs.readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
    const lines = yml.split(/\r?\n/).map((l) => l.trim());
    const exclusion = `- '!**/${DIST_REL}'`;
    const fromLine = `- from: ${VENDOR_DIR_REL}`;
    const toLine = `to: ${VENDOR_DEST_REL}`;
    const filterLine = `- ${DIST_FILE_REL}`;
    expect(lines, `files must exclude the exact original dist path (${exclusion})`).toContain(exclusion);
    expect(lines, `files must map the exact vendor path (${fromLine})`).toContain(fromLine);
    expect(lines, `the mapping destination must be the exact dist path (${toLine})`).toContain(toLine);
    expect(lines, `the one-file filter must name the exact dist file (${filterLine})`).toContain(filterLine);
    expect(yml, 'runAsNode fuse must remain false (AC3 co-invariant)').toMatch(/runAsNode:\s*false/);
  });
});

describe('#350 AC1: the probe child brackets its getLlama call with a console tap (C2 owns the end-to-end)', () => {
  test('gpu-probe-child.ts installs and restores a console tap around the getLlama call', () => {
    const src = fs.readFileSync(path.join(desktopRoot, 'main', 'backend', 'inference', 'gpu-probe-child.ts'), 'utf8');
    const tapIdx = src.search(/console\s*\.\s*error\s*=/);
    expect(tapIdx, 'the child must install a console.error tap').toBeGreaterThanOrEqual(0);
    const callIdx = src.indexOf('getLlama(');
    expect(callIdx, 'the child must call getLlama').toBeGreaterThanOrEqual(0);
    const restoreIdx = src.search(/console\s*\.\s*error\s*=\s*(orig|saved|previous)/);
    expect(restoreIdx, 'the tap must be restored (saved original reassigned)').toBeGreaterThanOrEqual(0);
    const finallyIdx = src.indexOf('finally');
    expect(finallyIdx, 'restoration must sit in a finally block').toBeGreaterThanOrEqual(0);
    expect(tapIdx < callIdx, 'tap installed before the getLlama call').toBe(true);
    expect(restoreIdx > callIdx || finallyIdx > callIdx, 'restore happens after the call region').toBe(true);
  });
});
