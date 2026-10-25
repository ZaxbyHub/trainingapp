// gpu-probe-device-identity.test.ts — issue #251 (AC5): the ADAPTER identity
// survives every probe failure shape and converges the boot flight.
//
// FROZEN ACCEPTANCE SURFACE (the frozen drivers run
// `npm --prefix desktop test -- src/__tests__/gpu-probe-device-identity.test.ts
//  -t <row>`):
//   persist-device (3 rows) — the PARENT probe keeps the child-reported
//       adapter on the two full-probe rejection shapes (non-sane sample,
//       unexpected backend), and the CHILD's post-getLlama fail paths carry
//       the module-scoped capture (source pin).
//   converge (1 row) — END-TO-END two-lifecycle boot flight: a device-bearing
//       CPU verdict persists on boot 1 and boot 2 ADOPTS it after only the
//       device-only query (no second full probe).
//
// SEAMS — real vs injected (binding test-author resolution):
//   REAL: the full gpu-probe.ts parent parse path (runGpuProbe ->
//       runGpuProbeCore's report contract, probeOutputIsSane, cpuVerdict's
//       device threading), readGpuProbeVerdict/writeGpuProbeVerdict sidecar
//       I/O, the module holder + gate lifecycle, and the host's whole boot
//       chain (runBootAdmission -> startGpuProbe -> publishVerdict ->
//       adoptGpuVerdict -> writeGpuProbeVerdict).
//   INJECTED (all through production options/fields, never by replacing the
//       logic under test):
//     - `spawnFn` — the production GpuProbeRunOptions seam documented as
//       "Injectable spawn, so tests never fork a real process" (t155 idiom).
//       The fake child emits exactly one JSON stdout line and exits 0, which
//       is the whole child contract the parent parses.
//     - `probeRun` (host instance field) — a wrapper that DELEGATES to the
//       REAL runGpuProbe, adding only spawnFn + a spawn counter; the host's
//       registration/abandonment/pruning logic all runs.
//     - `deviceQueryRun` (host instance field) — answers the current-adapter
//       question for boot 2 (the gpu-admission-recovery R-D precedent).
//     - `llamaFactory` (engine option) — a fake backend so warmup never loads
//       native code; rigEnv pins the hash embedder + rerank off (PRR-001).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GPU_PROBE_SIDECAR,
  activeGpuVerdict,
  armGpuVerdictGate,
  probeOutputIsSane,
  readGpuProbeVerdict,
  runGpuProbe,
  setActiveGpuVerdict,
  type GpuDeviceQueryResult,
  type GpuProbeRunOptions,
} from '../../main/backend/inference/gpu-probe.js';
import {
  LlamaEngine,
  type LlamaEngineBackend,
} from '../../main/backend/inference/llama-engine.js';
import { NodeBackendHost } from '../../main/backend/index.js';

const GB = 1024 ** 3;

/** The fake child's report for the non-sane-sample shape: the child claims a
 *  working vulkan device, the parent's own sanity check disagrees (the
 *  llama.cpp #28648 mis-decode defence), and the child-reported adapter must
 *  still survive into the CPU verdict. An EMPTY sample is genuinely non-sane
 *  (probeOutputIsSane rejects it) — each row re-guards the fixture. */
const NON_SANE_REPORT = JSON.stringify({ ok: true, backend: 'vulkan', device: 'gpu-x', sample: '' });

/**
 * RIG ISOLATION (PRR-001): rerank OFF + the deterministic HASH embedder — the
 * pattern the other gpu host specs use, so the host never binds a real
 * OnnxEmbedder to CI's LFS-pointer weights.
 */
function rigEnv(): { TRAININGAPP_RETRIEVAL_RERANK: string; TRAININGAPP_DESKTOP_EMBEDDER: string } {
  return { TRAININGAPP_RETRIEVAL_RERANK: 'false', TRAININGAPP_DESKTOP_EMBEDDER: 'hash' };
}

/** A spawn stand-in (the production `spawnFn` seam) whose child answers the
 *  probe contract: exactly one JSON line on stdout, then a clean exit 0. */
function fakeSpawnReply(reply: string): NonNullable<GpuProbeRunOptions['spawnFn']> {
  return ((_file: string, _args: string[], _opts: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter | null;
      stderr: EventEmitter | null;
      kill: (signal?: string) => boolean;
      killed: boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    setImmediate(() => {
      child.stdout?.emit('data', Buffer.from(reply));
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as NonNullable<GpuProbeRunOptions['spawnFn']>;
}

function stageModels(): { quality: string; fast: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-identity-models-'));
  const quality = path.join(dir, 'quality.gguf');
  const fast = path.join(dir, 'fast.gguf');
  fs.writeFileSync(quality, 'x');
  fs.writeFileSync(fast, 'x');
  return { quality, fast, dir };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function until(cond: () => boolean, timeoutMs: number, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`timed out waiting for: ${what}`);
}

/** Deterministic backend so engine warmup constructs instantly and never loads
 *  native code (the gpu-test-coordination fakeFactory, reduced to this spec's
 *  needs: no row here generates). */
const fakeLlamaFactory = async (): Promise<LlamaEngineBackend> => ({
  generate: async () => ({ answer: 'ok', cancelled: false }),
  dispose: async () => undefined,
});

const cleanups: Array<() => void> = [];
const activeStops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of activeStops.splice(0)) await stop().catch(() => undefined);
  while (cleanups.length > 0) cleanups.pop()?.();
  setActiveGpuVerdict(null);
  // Drain any still-armed module gate (armed + immediately settled is the safe
  // idle state; the sibling gpu host specs do the same).
  armGpuVerdictGate().resolve();
});

describe('issue #251: the adapter identity survives probe failure and boot admission', () => {
  it('persist-device: parent keeps the child-reported adapter on a non-sane sample (gpu-probe.ts)', async () => {
    const sample = '';
    expect(probeOutputIsSane(sample), 'fixture guard: the sample must be genuinely non-sane').toBe(false);
    // The REAL parent full-probe path with a fake child (the production
    // spawnFn seam): the child says ok/vulkan, the parent's own sanity check
    // rejects the sample, and the child-reported device must survive.
    const verdict = await runGpuProbe({ spawnFn: fakeSpawnReply(NON_SANE_REPORT) });
    expect(verdict.backend).toBe('cpu');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason, 'the non-sane-sample rejection branch is the one taken').toContain('unusable output');
    expect(verdict.device, 'the child-reported adapter identity survives the parent rejection').toBe('gpu-x');
  });

  it('persist-device: parent keeps the child-reported adapter on an unexpected backend (gpu-probe.ts)', async () => {
    const sample = 'OK';
    expect(probeOutputIsSane(sample), 'fixture guard: the sample itself must be sane (backend is the rejector)').toBe(true);
    const report = JSON.stringify({ ok: true, backend: 'cpu', device: 'gpu-x', sample });
    const verdict = await runGpuProbe({ spawnFn: fakeSpawnReply(report) });
    expect(verdict.backend).toBe('cpu');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason, 'the unexpected-backend rejection branch is the one taken').toContain('unexpected backend');
    expect(verdict.device, 'the child-reported adapter identity survives the parent rejection').toBe('gpu-x');
  });

  it('persist-device: child fail paths carry the captured adapter (gpu-probe-child.ts source pin)', () => {
    // Sanctioned SOURCE pin: the plan's entry guard (isProcessEntry) means
    // main() cannot be driven in-process, and the disposable replay worktree
    // has no compiled dist child to spawn — so the pin reads the SOURCE and
    // asserts the capture's structure: ordering by index and occurrence
    // counts, so a RENAME of the capture variable fails while formatting
    // changes do not. `//` line comments are stripped before matching; the
    // file's string/regex literals contain no `//` (verified: no URLs), so the
    // strip cannot eat code.
    const childSourcePath = fileURLToPath(
      new URL('../../main/backend/inference/gpu-probe-child.ts', import.meta.url),
    );
    const stripped = fs.readFileSync(childSourcePath, 'utf8').replace(/\/\/.*$/gm, '');
    const idx = (needle: string): number => stripped.indexOf(needle);
    const search = (re: RegExp): number => stripped.search(re);
    const count = (re: RegExp): number => (stripped.match(re) ?? []).length;

    // (a) the module-scoped capture exists, is declared exactly once at module
    // scope (before main), and is taken immediately after the getLlama
    // try/catch and BEFORE the wrong-backend decision.
    expect(stripped, 'the module-scoped capture variable is declared').toMatch(
      /let\s+probeAdapterDevice\s*:\s*string\s*\|\s*null\s*=\s*null\s*;/,
    );
    expect(
      count(/(?:let|const|var)\s+probeAdapterDevice\b/g),
      'exactly ONE declaration of the capture — a second, function-local one would shadow the module scope',
    ).toBe(1);
    expect(stripped, 'the capture helper exists').toMatch(/async\s+function\s+captureAdapterDevice\s*\(/);
    expect(count(/await\s+captureAdapterDevice\s*\(/g), 'the capture helper is invoked exactly once').toBe(1);

    const idxGetLlamaCall = search(/getLlama\(PROBE_LLAMA_OPTIONS\)/);
    const idxCaptureCall = search(/await\s+captureAdapterDevice\(llama\)/);
    const idxVulkanCheck = idx("selected !== 'vulkan'");
    expect(idxGetLlamaCall, 'fixture guard: the getLlama call site is present').toBeGreaterThanOrEqual(0);
    expect(idxCaptureCall, 'fixture guard: the capture call site is present').toBeGreaterThanOrEqual(0);
    expect(idxVulkanCheck, 'fixture guard: the vulkan decision is present').toBeGreaterThanOrEqual(0);
    expect(
      idxGetLlamaCall,
      'the capture runs AFTER the getLlama attempt (it needs the live llama instance)',
    ).toBeLessThan(idxCaptureCall);
    expect(
      idxCaptureCall,
      'the capture runs BEFORE the wrong-backend decision (the first fail site that needs the device)',
    ).toBeLessThan(idxVulkanCheck);
    expect(
      stripped.slice(idxGetLlamaCall, idxCaptureCall).split('fail(').length - 1,
      'between getLlama and the capture only the getLlama catch handler fails (pre-capture, device-less by design)',
    ).toBe(1);
    expect(
      stripped.slice(idxCaptureCall, idxVulkanCheck),
      'no failure decision intervenes between the capture and the vulkan check',
    ).not.toContain('fail(');

    // (b) every POST-CAPTURE fail site — wrong backend, model-load failure,
    // generation failure, and the process-level crash handler — passes the
    // capture variable as the device argument.
    expect(
      count(/,\s*probeAdapterDevice\s*\)/g),
      'exactly the four post-capture fail sites carry the capture argument (the pre-capture shapes stay device-less)',
    ).toBe(4);
    const postCaptureSites: Array<{ label: string; anchor: string }> = [
      { label: 'wrong-backend fail', anchor: 'rather than a usable Vulkan device' },
      { label: 'model-load-failure fail', anchor: 'could not load the probe model' },
      { label: 'generation-failure fail', anchor: 'failed to generate' },
      { label: 'process-level crash handler fail', anchor: 'GPU probe crashed' },
    ];
    for (const site of postCaptureSites) {
      const anchorIdx = idx(site.anchor);
      expect(anchorIdx, `fixture guard: the ${site.label} anchor is present`).toBeGreaterThanOrEqual(0);
      expect(anchorIdx, `the ${site.label} site sits after the capture`).toBeGreaterThan(idxCaptureCall);
      expect(
        stripped.slice(Math.max(0, anchorIdx - 120), anchorIdx),
        `the ${site.label} anchor sits inside a fail( call`,
      ).toContain('fail(');
      const argMatch = /,\s*probeAdapterDevice\s*\)/.exec(stripped.slice(anchorIdx));
      const argIdx = anchorIdx + (argMatch?.index ?? Number.MAX_SAFE_INTEGER);
      expect(
        stripped.slice(anchorIdx, argIdx),
        `the ${site.label} call passes the capture variable as ITS device argument (no statement may end in between)`,
      ).not.toContain(';');
    }

    // (c) the success report reuses the SAME capture — a single lookup, no
    // second getGpuDeviceNames() after the capture point. (The device-only
    // mode keeps its OWN lookup by contract — it never loads a model and
    // never reports a sample — so the sanctioned total is exactly two: the
    // capture helper and runDeviceOnly.)
    const idxDeviceAssign = search(/const\s+device\s*=\s*probeAdapterDevice\s*;/);
    const idxSuccessEmit = search(/emit\(\{\s*ok:\s*true,\s*backend:\s*'vulkan',\s*device,/);
    expect(idxDeviceAssign, 'the success report reads the capture variable').toBeGreaterThanOrEqual(0);
    expect(idxSuccessEmit, 'fixture guard: the success emit is present').toBeGreaterThanOrEqual(0);
    expect(idxDeviceAssign, 'the device the success report emits is read after the capture').toBeGreaterThan(
      idxCaptureCall,
    );
    expect(idxDeviceAssign).toBeLessThan(idxSuccessEmit);
    expect(
      stripped.slice(idxCaptureCall, idxSuccessEmit),
      'no second adapter lookup between the capture and the success report',
    ).not.toContain('getGpuDeviceNames');
    expect(
      count(/getGpuDeviceNames\s*\(\s*\)/g),
      'exactly two adapter lookups in the file: the capture helper and the device-only mode',
    ).toBe(2);
  });

  it('converge: a device-bearing CPU verdict persists on boot 1 and boot 2 adopts without a full probe', async () => {
    // Real vs injected for this row (details in the file header): the boot
    // chain, the parent probe parse, and the sidecar write/read are REAL; the
    // child PROCESS is the production spawnFn seam, the boot-2 adapter answer
    // comes from the production deviceQueryRun field, and warmup constructs a
    // fake backend through the production llamaFactory option.
    const profileDir = tempDir('gpu-identity-converge-');
    cleanups.push(() => fs.rmSync(profileDir, { recursive: true, force: true }));
    const models = stageModels();
    cleanups.push(() => fs.rmSync(models.dir, { recursive: true, force: true }));
    const storePath = path.join(profileDir, 'store.sqlite');
    const counts = { fullProbes: 0, deviceQueries: 0 };
    const probeRunWrapper = (probeOpts: GpuProbeRunOptions) => {
      // Count FULL-probe spawns only: this seam is reached exclusively from
      // startGpuProbe (the boot 2 device-only query goes through
      // deviceQueryRun instead, counted separately).
      counts.fullProbes += 1;
      return runGpuProbe({ ...probeOpts, spawnFn: fakeSpawnReply(NON_SANE_REPORT) });
    };
    const deviceQueryRunStub = (): Promise<GpuDeviceQueryResult> => {
      counts.deviceQueries += 1;
      return Promise.resolve({ status: 'device', device: 'gpu-x' });
    };
    const makeEngine = (): LlamaEngine =>
      new LlamaEngine({
        profile: 'fast',
        freeMemBytes: () => 8 * GB,
        cpuCount: () => 8,
        models: { quality: models.quality, fast: models.fast },
        llamaFactory: fakeLlamaFactory,
      });
    const makeHost = (engine: LlamaEngine): NodeBackendHost => {
      const host = new NodeBackendHost({
        engine,
        token: 'gpu-identity-token',
        env: rigEnv(),
        storePath,
      } as never);
      const h = host as unknown as {
        probeRun: unknown;
        deviceQueryRun: unknown;
        start: () => Promise<unknown>;
        stop: () => Promise<void>;
      };
      h.probeRun = probeRunWrapper;
      h.deviceQueryRun = deviceQueryRunStub;
      activeStops.push(() => h.stop().catch(() => undefined));
      return host;
    };

    // Boot 1: no stored verdict, so the REAL runBootAdmission takes the
    // stored === null branch and runs the full probe through the REAL
    // runGpuProbe parent path. The fake child claims ok/vulkan with a
    // non-sane sample, so the parent rejects it into a CPU verdict that must
    // carry device 'gpu-x' — persisted by the REAL adoptGpuVerdict /
    // writeGpuProbeVerdict chain.
    const host1 = makeHost(makeEngine());
    await (host1 as unknown as { start: () => Promise<unknown> }).start();
    await until(
      () => activeGpuVerdict()?.backend === 'cpu' && activeGpuVerdict()?.device === 'gpu-x',
      5000,
      'boot 1 to adopt the device-bearing CPU verdict',
    );
    expect(counts.fullProbes, 'boot 1 ran exactly one full probe').toBe(1);
    expect(counts.deviceQueries, 'boot 1 never reaches the device-only query (stored was null)').toBe(0);
    // The PERSISTENCE claim, read from the sidecar itself: the record on disk
    // carries the adapter identity (not just the in-memory verdict).
    const record = JSON.parse(
      fs.readFileSync(path.join(profileDir, GPU_PROBE_SIDECAR), 'utf8'),
    ) as Record<string, unknown>;
    expect(record.v).toBe(1);
    expect(record.backend).toBe('cpu');
    expect(record.ok).toBe(false);
    expect(record.device, 'the sidecar record carries device gpu-x').toBe('gpu-x');
    const persisted = readGpuProbeVerdict(profileDir);
    expect(persisted, 'the written record survives the (staleness-aware) reader').not.toBeNull();
    await (host1 as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);

    // Boot 2: a FRESH host + engine on the same profile dir. start()'s
    // lifecycle reset drops the holder, so the boot flight must re-resolve
    // the verdict: the persisted record is device-bearing, so the flight
    // performs ONLY the device-only query, sees the same adapter, and adopts
    // the stored verdict. A device-less record (the pre-#251 shape) would
    // read as never-probed here and re-run the FULL probe.
    const host2 = makeHost(makeEngine());
    await (host2 as unknown as { start: () => Promise<unknown> }).start();
    await until(() => counts.deviceQueries >= 1, 5000, 'boot 2 to run its device-only query');
    await until(() => activeGpuVerdict() !== null, 5000, 'boot 2 to re-adopt the stored verdict');
    expect(
      activeGpuVerdict(),
      'the stored record is ADOPTED: the host verdict IS the persisted CPU verdict',
    ).toEqual(persisted);
    expect(
      counts.fullProbes,
      'NO second full probe across both boots — boot 2 performed only the device-only query',
    ).toBe(1);
    expect(counts.deviceQueries, 'boot 2 performed exactly one device-only query').toBe(1);
    await (host2 as unknown as { stop: () => Promise<void> }).stop().catch(() => undefined);
  }, 30_000);
});
