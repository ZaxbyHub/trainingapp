// gpu-probe-prebuilt-reason.test.ts — issue #350 (AC2): when node-llama-cpp's
// prebuilt genuinely cannot load, the probe child's failure report must carry
// the UNDERLYING nlc rejection text (the getLlama.js:462-472 console.error
// line "Failed to load a prebuilt binary ... Error: <cause>"), sanitized and
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

vi.mock('node-llama-cpp', () => ({
  getLlama: async () => {
    // The REAL console.error must run: the fix is expected to observe exactly
    // this output (this spec deliberately does not mock the console).
    console.error(NLC_REJECTION_LINE);
    return {
      gpu: false,
      getGpuDeviceNames: async () => [],
      dispose: async () => undefined,
    };
  },
}));

const here = path.dirname(fileURLToPath(import.meta.url));

describe('#350 AC2: the probe child surfaces the real nlc prebuilt rejection', () => {
  it('the child report reason carries the nlc rejection cause, not only "selected false"', async () => {
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
      const report = reports[0] as { ok?: unknown; backend?: unknown; reason?: unknown };
      // The failure-report contract shape is preserved.
      expect(report.ok).toBe(false);
      expect(report.backend).toBe('cpu');
      expect(typeof report.reason).toBe('string');
      const reason = report.reason as string;
      // THE AC2 contract: the underlying nlc rejection text survives.
      expect(reason, `reason must carry the nlc rejection cause ${SENTINEL}; got: ${reason}`).toContain(SENTINEL);
      // Sanitized: no control characters ride into the verdict.
      expect(reason).not.toMatch(/[\x00-\x1f\x7f]/);
      // Bounded: the reason stays a bounded string, not a raw unbounded dump.
      expect(reason.length).toBeLessThan(8_192);
      expect(exitCodes).toContain(0);
    } finally {
      process.argv = originalArgv;
      exitSpy.mockRestore();
      delete (process as unknown as { parentPort?: unknown }).parentPort;
      fs.rmSync(path.dirname(modelPath), { recursive: true, force: true });
    }
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
});

afterEach(() => {
  vi.restoreAllMocks();
});
