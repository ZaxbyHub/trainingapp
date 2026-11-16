// gpu-probe-prebuilt-reason.test.ts — issue #350 (AC2): when node-llama-cpp's
// prebuilt genuinely cannot load, the probe child's failure report must carry
// the UNDERLYING nlc rejection text (the getLlama.js:462-472 console.error
// line "Failed to load a prebuilt ... Error: <cause>"), sanitized and
// bounded — not only the generic 'GPU probe: this host selected "false"'.
//
// FROZEN ACCEPTANCE SURFACE (trace 350-351-packaged-gpu-fuse-external-timeouts,
// check C2; authored arm's-length from the fix mechanism — this spec pins the
// OUTCOME on the child's emitted report, not how the child captures the text):
// the 'node-llama-cpp' import is stubbed so getLlama() console.errors the
// field-shaped prebuilt-rejection line with a SENTINEL cause and resolves an
// object whose .gpu === false (the CPU fallback shape). The child module is
// then imported AS THE PROCESS ENTRY (a faked utility-process parentPort plus
// a stubbed process.exit), so its real main()/fail() path runs against the
// stub. The single posted report must be ok:false / backend:'cpu' with a
// reason that CONTAINS the sentinel cause text.
//
// Review finding correctness-state-002 (critic-UPHELD MEDIUM): the stub now
// emits BOTH lines in UPSTREAM ORDER — the specific rejection FIRST and the
// generic "is not compatible with the current system" warning SECOND (that is
// the real getLlama.js sequence: testBindingBinary rejects at ~427, then
// console.warn at ~449-459). The first version of this spec stubbed ONLY the
// rejection line, so it passed while the shipped child kept the LAST captured
// line (the generic warning) and the actionable cause never reached the
// report. Row 1 below pins the corrected selection; row 2 pins the sanitizer
// and the bound with input that would otherwise pass vacuously (review
// finding tests-falsifiability-003: the old rows asserted the bound only
// against clean, short input, so deleting the sanitizers left them GREEN).
//
// RED at base (the base child discards the nlc console output; the report
// reason is only 'GPU probe: this host selected "false" ...'; AND the base
// parent's device-only branch rewrites any child reason to the generic
// 'GPU device query did not report a usable Vulkan adapter.' — the second
// case below pins that leg), GREEN after the fix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The nlc rejection cause sentinel — must survive into the report reason. */
const SENTINEL = 'GPU350-PREBUILT-SENTINEL-9C41';
/** The field-shaped console.error line getLlama emits when a prebuilt dies
 *  (verbatim shape from getLlama.js:462-472; observed live on this host,
 *  trace 02 R1/R3 and the AC1 host-capability probe). */
const NLC_REJECTION_LINE =
  `Failed to load a prebuilt binary for platform "win" "x64" with Vulkan support, ` +
  `falling back to using CPU. Error: Binding binary test failed to run a test process: ${SENTINEL}`;
/** The GENERIC warning getLlama emits AFTER the binding test fails
 *  (getLlama.js:449-459). It arrives LAST on the console, which is exactly why
 *  a plain last-line capture loses the specific cause. */
const NLC_GENERIC_WARN =
  'The prebuilt binary for platform "win" "x64" with Vulkan support is not compatible with the current system, falling back to using no GPU';

/** Mutable stub payload (vi.hoisted so the mock factory can read it). */
const stubState = vi.hoisted(() => ({ rejectionLine: '' as string, emitGenericWarn: true }));

vi.mock('node-llama-cpp', () => ({
  getLlama: async () => {
    // The REAL console.error must run: the fix is expected to observe exactly
    // this output (this spec deliberately does not mock the console).
    console.error(stubState.rejectionLine);
    if (stubState.emitGenericWarn) {
      console.warn(
        'The prebuilt binary for platform "win" "x64" with Vulkan support is not compatible with the current system, falling back to using no GPU',
      );
    }
    return {
      gpu: false,
      getGpuDeviceNames: async () => [],
      dispose: async () => undefined,
    };
  },
}));

const here = path.dirname(fileURLToPath(import.meta.url));

/** Drive the child module AS the process entry against the current stub and
 *  return the single posted report (the shared harness for both rows). */
async function runChildEntry(): Promise<{ report: Record<string, unknown>; reason: string }> {
  const modelPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-reason-')), 'probe.gguf');
  fs.writeFileSync(modelPath, 'x');

  const reports: Array<Record<string, unknown>> = [];
  const exitCodes: number[] = [];
  const postMessage = (message: unknown): void => {
    reports.push(message as Record<string, unknown>);
  };
  // Fake the utility-process parent port so emit() posts to us (parentPort
  // is checked FIRST, before process.send, so the vitest worker's own IPC
  // channel can never intercept the report).
  Object.defineProperty(process, 'parentPort', { value: { postMessage }, configurable: true });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as never);
  const originalArgv = process.argv;
  process.argv = [
    process.argv[0] as string,
    path.resolve(here, '..', '..', 'main', 'backend', 'inference', 'gpu-probe-child.ts'),
    modelPath,
  ];

  try {
    // Importing the module IS the process entry (isProcessEntry(): the
    // faked parentPort), so the production self-run drives main().
    await import('../../main/backend/inference/gpu-probe-child');
    const deadline = Date.now() + 5_000;
    while (reports.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(reports.length, 'the child must post exactly one report (got ' + reports.length + ')').toBe(1);
    const report = reports[0];
    // The failure-report contract shape is preserved.
    expect(report.ok).toBe(false);
    expect(report.backend).toBe('cpu');
    expect(typeof report.reason).toBe('string');
    expect(exitCodes).toContain(0);
    return { report, reason: report.reason as string };
  } finally {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    delete (process as unknown as { parentPort?: unknown }).parentPort;
    fs.rmSync(path.dirname(modelPath), { recursive: true, force: true });
  }
}

describe('#350 AC2: the probe child surfaces the real nlc prebuilt rejection', () => {
  it('the child report reason carries the nlc rejection cause, not only "selected false"', async () => {
    stubState.rejectionLine = NLC_REJECTION_LINE;
    stubState.emitGenericWarn = true;
    vi.resetModules();
    const { reason } = await runChildEntry();
    // THE AC2 contract: the underlying nlc rejection text survives — even
    // though the generic "is not compatible" warning is logged AFTER it
    // (upstream order), which a last-line capture would have kept instead.
    expect(reason, `reason must carry the nlc rejection cause ${SENTINEL}; got: ${reason}`).toContain(SENTINEL);
    // Sanitized: no control characters ride into the verdict.
    expect(reason).not.toMatch(/[\x00-\x1f\x7f]/);
    // Bounded: the reason stays a bounded string, not a raw unbounded dump.
    expect(reason.length).toBeLessThan(8_192);
  });

  it('a control-character-laden, oversized rejection is sanitized and tail-bounded', async () => {
    // Review finding tests-falsifiability-003: the old bound row asserted only
    // against clean, short input, so deleting the sanitizers left it GREEN.
    // This row's input would fail BOTH checks if the strip/slice were removed.
    stubState.rejectionLine =
      `Failed to load a prebuilt binary for platform "win" "x64" with Vulkan support, ` +
      `falling back to using CPU. Error: ${'B'.repeat(600)}\u0000\u001b[31m${SENTINEL}`;
    stubState.emitGenericWarn = false;
    vi.resetModules();
    const { reason } = await runChildEntry();
    expect(reason).not.toMatch(/[\x00-\x1f\x7f]/);
    // Tail-bounded: a 600-char run cannot ride through whole.
    expect(reason, `the cause must be truncated (got ${reason.length} chars): ${reason}`).not.toContain('B'.repeat(501));
    // ...and the tail (where the cause sits) survives the truncation.
    expect(reason).toContain(SENTINEL);
  });
});

describe('#350 AC2: the probe PARENT surfaces the real rejection reason', () => {
  it('the device-only verdict reason carries the child report reason (sentinel), not the generic rewrite', async () => {
    // Import AFTER the node-llama-cpp mock is in place is irrelevant here (the
    // parent never touches nlc); the parent runs our fake child.
    const { runGpuProbe } = await import('../../main/backend/inference/gpu-probe');
    const child = new EventEmitter() as EventEmitter & {
      kill: (signal?: string) => boolean;
      stdout: null;
      stderr: null;
      pid: number;
    };
    child.stdout = null;
    child.stderr = null;
    child.pid = 4242;
    child.kill = () => true;
    const forkFn = vi.fn(() => child as never);

    const run = runGpuProbe({
      modulePath: path.resolve(here, 'gpu-probe-child.js'),
      args: ['--device-only'],
      deviceOnly: true,
      timeoutMs: 5_000,
      forkFn,
    });
    // One report on the device-only contract ({ok, backend, device}) whose
    // reason is the AC2 sentinel line; then a clean exit 0.
    child.emit('message', {
      ok: false,
      backend: 'cpu',
      device: null,
      reason: `GPU probe: this host selected "false" rather than a usable Vulkan device. Cause: ${NLC_REJECTION_LINE}`,
    });
    child.emit('exit', 0, null);

    const verdict = await run;
    expect(verdict.ok).toBe(false);
    expect(verdict.backend).toBe('cpu');
    const reason = verdict.reason;
    expect(
      reason,
      `parent device-only verdict must carry the child reason sentinel ${SENTINEL}; got: ${reason}`,
    ).toContain(SENTINEL);
    // Sanitized + bounded like the child contract.
    expect(reason).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(reason.length).toBeLessThan(8_192);
  });

  it('a hostile child reason (control characters, oversized) is sanitized and tail-bounded by the parent sink', async () => {
    // Review finding tests-falsifiability-003 (parent leg): the parent's
    // sanitize+bound must discriminate — this input fails if either is removed.
    const { runGpuProbe } = await import('../../main/backend/inference/gpu-probe');
    const child = new EventEmitter() as EventEmitter & {
      kill: (signal?: string) => boolean;
      stdout: null;
      stderr: null;
      pid: number;
    };
    child.stdout = null;
    child.stderr = null;
    child.pid = 4243;
    child.kill = () => true;
    const forkFn = vi.fn(() => child as never);

    const run = runGpuProbe({
      modulePath: path.resolve(here, 'gpu-probe-child.js'),
      args: ['--device-only'],
      deviceOnly: true,
      timeoutMs: 5_000,
      forkFn,
    });
    child.emit('message', {
      ok: false,
      backend: 'cpu',
      device: null,
      reason: `GPU device query failed: ${'C'.repeat(600)}\u0000${SENTINEL}`,
    });
    child.emit('exit', 0, null);

    const verdict = await run;
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(verdict.reason, `the parent sink must truncate (got ${verdict.reason.length} chars)`).not.toContain('C'.repeat(501));
    expect(verdict.reason).toContain(SENTINEL);
  });

  it('the full-probe (non-device-only) verdict reason is sanitized and bounded too', async () => {
    // Review finding security-trust-002: the full-probe branch used to take the
    // child reason VERBATIM while the device-only branch sanitized it. Both
    // sinks now apply the same treatment.
    const { runGpuProbe } = await import('../../main/backend/inference/gpu-probe');
    const child = new EventEmitter() as EventEmitter & {
      kill: (signal?: string) => boolean;
      stdout: null;
      stderr: null;
      pid: number;
    };
    child.stdout = null;
    child.stderr = null;
    child.pid = 4244;
    child.kill = () => true;
    const forkFn = vi.fn(() => child as never);

    const run = runGpuProbe({
      modulePath: path.resolve(here, 'gpu-probe-child.js'),
      args: [path.join(os.tmpdir(), 'probe.gguf')],
      deviceOnly: false,
      timeoutMs: 5_000,
      forkFn,
    });
    child.emit('message', {
      ok: false,
      backend: 'cpu',
      device: null,
      reason: `GPU probe: the device is not usable. ${'D'.repeat(600)}\u0000${SENTINEL}`,
    });
    child.emit('exit', 0, null);

    const verdict = await run;
    expect(verdict.ok).toBe(false);
    expect(verdict.backend).toBe('cpu');
    expect(verdict.reason).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(verdict.reason, `the full-probe sink must truncate (got ${verdict.reason.length} chars)`).not.toContain('D'.repeat(501));
    expect(verdict.reason).toContain(SENTINEL);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
