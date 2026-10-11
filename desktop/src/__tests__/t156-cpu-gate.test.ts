// t156-cpu-gate.test.ts — issue #156 (frozen check C5 runs this suite).
//
// Pins the CPU gate on the AUTO profile (approved plan section 7, F2-7):
// quality is a GPU tier (it takes ~2x the 1.2B models' time on CPU per the
// benchmark recorded in ADR-0002), so:
//   - auto + a PROBED verdict with backend === 'cpu' resolves fast (even on a
//     huge-RAM machine);
//   - auto + verdict ABSENT (null) keeps the RAM rule unchanged (6 GiB
//     boundary) — the gate must not fire on a never-probed machine;
//   - auto + a vulkan verdict keeps the RAM rule too;
//   - explicit 'quality' on a CPU verdict stays quality (operator decides).
//
// Also pins the GpuProbeVerdict `measured` field (#156): OPTIONAL decode
// tok/s of the fast model on the active backend; the sidecar reader tolerates
// its absence in v1 records and adopts it only when it is a finite number.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GPU_PROBE_SIDECAR,
  readGpuProbeVerdict,
  runGpuProbe,
  writeGpuProbeVerdict,
  type GpuProbeRunOptions,
} from '../../main/backend/inference/gpu-probe.js';
import { LlamaEngine, type LlamaEngineBackend } from '../../main/backend/inference/llama-engine.js';

const GB = 1024 ** 3;

const CPU_VERDICT = { backend: 'cpu' as const, ok: false, reason: 'stub probe: no usable gpu on this host', device: null };
const GPU_OK = { backend: 'vulkan' as const, ok: true, reason: 'stub probe: gpu usable', device: 'stub-gpu-0' };

/** Stub backend so no model ever loads (the t155 pattern). */
function stubBackend(): LlamaEngineBackend {
  return {
    async generate() {
      return { answer: 'ok', cancelled: false };
    },
    async dispose() {},
  };
}

function stageModels(): { quality: string; fast: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't156-cpu-gate-'));
  const quality = path.join(dir, 'quality.gguf');
  const fast = path.join(dir, 'fast.gguf');
  fs.writeFileSync(quality, 'x');
  fs.writeFileSync(fast, 'x');
  return { quality, fast, dir };
}

/** Engine on the gpuVerdictFn seam with an injected free-RAM figure. */
function makeEngine(opts: {
  profile: 'auto' | 'quality' | 'fast';
  verdict: typeof CPU_VERDICT | typeof GPU_OK | null;
  freeGb: number;
}): LlamaEngine {
  const models = stageModels();
  return new LlamaEngine({
    profile: opts.profile,
    freeMemBytes: () => opts.freeGb * GB,
    cpuCount: () => 8,
    models: { quality: models.quality, fast: models.fast },
    gpuVerdict: () => opts.verdict,
    llamaFactory: async () => stubBackend(),
  });
}

describe('#156 effectiveProfile: quality is a GPU tier', () => {
  it('auto + a CPU probe verdict resolves fast even with abundant free RAM', () => {
    // 32 GiB free would pick quality under the RAM rule; the CPU gate wins.
    const engine = makeEngine({ profile: 'auto', verdict: CPU_VERDICT, freeGb: 32 });
    expect(engine.effectiveProfile()).toBe('fast');
    expect(engine.modelStatus().profile).toBe('fast');
  });

  it('auto + verdict ABSENT keeps the RAM rule: big free RAM still selects quality', () => {
    expect(makeEngine({ profile: 'auto', verdict: null, freeGb: 8 }).effectiveProfile()).toBe('quality');
    // The inclusive 6 GiB boundary is unchanged.
    expect(makeEngine({ profile: 'auto', verdict: null, freeGb: 6 }).effectiveProfile()).toBe('quality');
    expect(makeEngine({ profile: 'auto', verdict: null, freeGb: 6 - 0.001 }).effectiveProfile()).toBe('fast');
  });

  it('auto + a VULKAN verdict keeps the RAM rule (the gate fires only on cpu verdicts)', () => {
    expect(makeEngine({ profile: 'auto', verdict: GPU_OK, freeGb: 8 }).effectiveProfile()).toBe('quality');
    expect(makeEngine({ profile: 'auto', verdict: GPU_OK, freeGb: 4 }).effectiveProfile()).toBe('fast');
  });

  it("an explicit 'quality' setting is unaffected by a CPU verdict (the operator decides)", () => {
    expect(makeEngine({ profile: 'quality', verdict: CPU_VERDICT, freeGb: 32 }).effectiveProfile()).toBe('quality');
    // Symmetric: an explicit fast stays fast regardless of the verdict.
    expect(makeEngine({ profile: 'fast', verdict: GPU_OK, freeGb: 32 }).effectiveProfile()).toBe('fast');
  });
});

// ---------------------------------------------------------------------------
// GpuProbeVerdict.measured (#156): optional decode tok/s; the reader is
// backward-compatible within v1 (mirrors the t155 sidecar patterns).
// ---------------------------------------------------------------------------

function tempSidecarDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a RAW sidecar record (hand-rolled JSON, not the writer) so the reader
 *  is tested against records the current build did not produce. */
function writeRawVerdict(dir: string, record: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, GPU_PROBE_SIDECAR), JSON.stringify(record), 'utf8');
}

describe('#156 gpu-probe verdict: the optional `measured` field', () => {
  it('a v1 record WITHOUT the field reads back valid and measured-free (backward-compatible within v1)', () => {
    const dir = tempSidecarDir('t156-measured-absent-');
    try {
      writeGpuProbeVerdict(dir, GPU_OK);
      const verdict = readGpuProbeVerdict(dir);
      expect(verdict).not.toBeNull();
      expect(verdict?.backend).toBe('vulkan');
      expect(verdict?.measured).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the reader ADOPTS a finite measured from a v1 record that carries one', () => {
    const dir = tempSidecarDir('t156-measured-present-');
    try {
      writeRawVerdict(dir, { v: 1, backend: 'vulkan', ok: true, reason: 'probed', device: 'd', measured: 41.7 });
      const verdict = readGpuProbeVerdict(dir);
      expect(verdict?.measured).toBe(41.7);
      expect(verdict?.backend).toBe('vulkan');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-number measured (string / null / boolean) is ignored, never adopted or fatal', () => {
    const dir = tempSidecarDir('t156-measured-garbage-');
    try {
      for (const bad of ['fast', null, false]) {
        writeRawVerdict(dir, { v: 1, backend: 'cpu', ok: false, reason: 'r', device: null, measured: bad });
        const verdict = readGpuProbeVerdict(dir);
        expect(verdict, `measured:${JSON.stringify(bad)} must not break the read`).not.toBeNull();
        expect(verdict?.measured).toBeUndefined();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a measured-bearing verdict round-trips through the writer and the reader', () => {
    const dir = tempSidecarDir('t156-measured-roundtrip-');
    try {
      writeGpuProbeVerdict(dir, { ...GPU_OK, measured: 12.5 });
      const verdict = readGpuProbeVerdict(dir);
      expect(verdict?.measured).toBe(12.5);
      expect(verdict?.device).toBe('stub-gpu-0');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A spawn stand-in (the t155 fakeSpawn pattern) answering one JSON report. */
function fakeSpawn(reply: Record<string, unknown>) {
  const spawnFn = ((_file: string, _args: string[], _opts: { env?: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter | null;
      stderr: EventEmitter | null;
      kill: (signal?: string) => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout?.emit('data', Buffer.from(JSON.stringify(reply)));
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as NonNullable<GpuProbeRunOptions['spawnFn']>;
  return { spawnFn };
}

describe('#156 gpu-probe run: the child-measured tok/s rides the verdict', () => {
  it('a successful child report carrying measured surfaces it on the verdict', async () => {
    const { spawnFn } = fakeSpawn({ ok: true, backend: 'vulkan', device: 'd', sample: 'OK', measured: 38.4 });
    const verdict = await runGpuProbe({ spawnFn });
    expect(verdict.ok).toBe(true);
    expect(verdict.backend).toBe('vulkan');
    expect(verdict.measured).toBe(38.4);
  });

  it('a report without measured resolves a valid verdict with no measured', async () => {
    const { spawnFn } = fakeSpawn({ ok: true, backend: 'vulkan', device: 'd', sample: 'OK' });
    const verdict = await runGpuProbe({ spawnFn });
    expect(verdict.ok).toBe(true);
    expect(verdict.measured).toBeUndefined();
  });

  it('a garbage (non-number) child measured is dropped, not adopted', async () => {
    const { spawnFn } = fakeSpawn({ ok: true, backend: 'vulkan', device: 'd', sample: 'OK', measured: 'lots' });
    const verdict = await runGpuProbe({ spawnFn });
    expect(verdict.ok).toBe(true);
    expect(verdict.measured).toBeUndefined();
  });
});
