// Issue #155: GPU capability probe (Vulkan, vendor-neutral) with CPU fallback.
//
// The probe runs in a SEPARATE OS PROCESS on purpose. A Vulkan driver fault does
// not throw - it aborts - so an in-process try/catch cannot contain it, and a
// worker_threads Worker shares the address space and dies with it. The one
// precedent this repo has for isolating a native module that can abort
// (rerank-worker.ts, ONNX exit 134) is a thread, which is not enough here.
//
// The verdict is a value object; gpu-probe.json beside settings.json /
// external.json / first-run.json / updates.json is the persistence; this module
// is the isolation boundary. The load-time-safe read is tolerant in exactly the
// shape update-checker.ts:335-354 established: a missing, non-object or
// wrong-typed file yields null and logs nothing, and never throws.
//
// This module must stay electron-free (desktop/main/backend/types.ts:1-12 states
// the rule for its neighbours): nothing here imports electron.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What the probe concluded about this machine, and why. */
export interface GpuProbeVerdict {
  /** The backend that will actually be used. */
  backend: 'vulkan' | 'cpu';
  /** True only when a GPU backend loaded AND produced a sane generation. */
  ok: boolean;
  /** Human-readable, shown in Settings and returned by the API. Never empty. */
  reason: string;
  /** Adapter/device identity when the backend reported one, else null. */
  device?: string | null;
}

/**
 * The process-wide ACTIVE verdict. TWO writers, both deliberate: the backend
 * host (which runs the async probe and adopts its result) and the engine
 * itself (which downgrades the verdict when an automatic GPU load fails - it
 * cannot route that through the host, because the engine is constructed before
 * any host exists). One reader: the engine, through a sync seam, because the
 * verdict must be readable at model-load time. Both writes replace the whole
 * object on one thread, so there is no torn read. A null value means "never
 * probed", which the engine resolves to CPU.
 */
let activeVerdict: GpuProbeVerdict | null = null;

export function activeGpuVerdict(): GpuProbeVerdict | null {
  return activeVerdict;
}

export function setActiveGpuVerdict(verdict: GpuProbeVerdict | null): void {
  activeVerdict = verdict;
}

/** The sidecar name, used beside the other profile-dir sidecars. */
export const GPU_PROBE_SIDECAR = 'gpu-probe.json';

/** Default probe deadline. The first GPU call pays a one-off warmup, so this is
 *  generous; it is a ceiling that must contain a hang, not a performance target. */
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

/** Grace between SIGTERM and SIGKILL when the deadline expires. Mirrors the
 *  terminate-then-escalate shape proven in sidecar-manager.ts:245-252. */
const KILL_GRACE_MS = 2_000;

/** A verdict that always falls back to CPU, with a stated reason. */
function cpuVerdict(reason: string): GpuProbeVerdict {
  return { backend: 'cpu', ok: false, reason: reason === '' ? 'GPU probe did not report a reason' : reason, device: null };
}

/**
 * Read a persisted verdict. Missing, unparseable, non-object and
 * wrong-typed files all read as null; a missing verdict means "never probed",
 * which the engine resolves to CPU (an unprobed host behaves exactly as it did
 * before this feature).
 */
export function readGpuProbeVerdict(dir: string): GpuProbeVerdict | null {
  try {
    const raw = fs.readFileSync(path.join(dir, GPU_PROBE_SIDECAR), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.backend !== 'vulkan' && record.backend !== 'cpu') return null;
    if (typeof record.ok !== 'boolean') return null;
    if (typeof record.reason !== 'string' || record.reason === '') return null;
    const device = record.device;
    return {
      backend: record.backend,
      ok: record.ok,
      reason: record.reason,
      device: typeof device === 'string' ? device : null,
    };
  } catch {
    // Tolerant by design: a missing or corrupt sidecar is never fatal, and a
    // probe result is not worth a boot-time error (update-checker.ts:345-346).
    return null;
  }
}

/**
 * Persist a verdict atomically: `gpu-probe.json.<pid>.<rand>.tmp` in the SAME
 * directory, fsynced, then renamed onto the target (same-dir rename is atomic
 * on NTFS/ext4). The tmp file is unlinked on any failure. Identical idiom to
 * settings-store.ts:57-78.
 */
export function writeGpuProbeVerdict(dir: string, verdict: GpuProbeVerdict): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, GPU_PROBE_SIDECAR);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify({ v: 1, ...verdict }));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort
    }
  }
}

/**
 * llama.cpp #28648: an Arc 140V enumerates, loads, and then produces garbage
 * with layers on the GPU. Load success is therefore not a usable signal - the
 * sample the backend actually produced has to be judged. The parent re-judges
 * the child's sample itself (see runGpuProbe) rather than trusting the child's
 * own verdict, so a child that lies about a garbage generation still fails.
 */
export function probeOutputIsSane(sample: string): boolean {
  if (typeof sample !== 'string') return false;
  if (sample.trim() === '') return false;
  // A control-character-dense string is the signature of a mis-decode. Count
  // C0 controls plus DEL, excluding the whitespace controls a real answer uses.
  let controls = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) controls += 1;
  }
  if (controls > 0) return false;
  // At least one real word character: a run of punctuation or a lone glyph is
  // not an answer, and is what a corrupted decode tends to collapse to.
  return /[\p{L}\p{N}]/u.test(sample);
}

/** The compiled child entry, resolved from this module's own location exactly
 *  as reranker.ts:69-71 resolves rerank-worker.js. desktop/tsconfig.json sets
 *  rootDir "." and outDir "dist", so this lands at
 *  dist/main/backend/inference/gpu-probe-child.js for a compiled/dev run and at
 *  the same relative path inside app.asar for a packaged one. */
export function gpuProbeChildPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'gpu-probe-child.js');
}

export interface GpuProbeRunOptions {
  /**
   * The child command to spawn. Defaults to the PRODUCTION spawn: the current
   * executable with ELECTRON_RUN_AS_NODE=1, because in a packaged app the only
   * Node runtime present is the Electron binary - `node` is not shipped, so
   * hardcoding it passes in dev and fails in production. Override only in
   * tests. argv = [execPath, childPath, ...extraArgs].
   */
  command?: string[];
  /** Extra argv appended after the child script path (the model path). */
  args?: string[];
  /** Deadline; on expiry the child is SIGTERMed then SIGKILLed. */
  timeoutMs?: number;
  /** Injectable spawn, so tests never fork a real process. */
  spawnFn?: typeof spawn;
  /**
   * Called with the live child as soon as it is spawned, so the CALLER can
   * guarantee no probe outlives it (the host kills it in `stop()`). Without
   * this the child handle lives only inside this promise's closure and a
   * shutdown cannot reach it.
   */
  onChild?: (child: { kill: (signal?: NodeJS.Signals) => unknown }) => void;
  /** Called once the probe has settled. Lets a caller drop per-probe state
   *  (the host uses it to clear its shutdown-abandoned flag). */
  onSettled?: () => void;
}

interface ProbeChildReport {
  ok?: unknown;
  backend?: unknown;
  device?: unknown;
  sample?: unknown;
  reason?: unknown;
}

/**
 * Run the probe out of process and resolve a verdict. NEVER throws and never
 * rejects: every failure mode - spawn error, timeout, non-zero exit, signal
 * death, unparseable stdout - resolves to a CPU verdict carrying a reason. The
 * caller (the host) therefore has exactly one code path to handle.
 */
export async function runGpuProbe(opts: GpuProbeRunOptions = {}): Promise<GpuProbeVerdict> {
  const command = opts.command ?? [process.execPath, gpuProbeChildPath()];
  const spawnFn = opts.spawnFn ?? spawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return await new Promise<GpuProbeVerdict>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;

    const finish = (verdict: GpuProbeVerdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // Clear the escalation ONLY when we did not just arm it. The deadline
      // callback arms `escalate` and then calls finish() in the same tick, so an
      // unconditional clear cancelled it ~0 ms after arming it and SIGKILL could
      // never fire - dead code behind a comment claiming sidecar-manager parity.
      if (escalate !== undefined && !armed) clearTimeout(escalate);
      opts.onSettled?.();
      resolve(verdict);
    };

    // The SIGKILL escalation is armed ONLY when the deadline fires, never at
    // t=0. Arming it up front capped the EFFECTIVE timeout at KILL_GRACE_MS
    // (2 s) while the documented default is DEFAULT_PROBE_TIMEOUT_MS (60 s):
    // any child still loading its GGUF past 2 s was killed and reported as a
    // failed device.
    //
    // Ordering note: unlike sidecar-manager.ts:244-249, this resolves the
    // promise from inside the deadline callback, so `finish` must NOT clear the
    // timer it just armed - otherwise SIGKILL is unreachable. `armed` records
    // which case we are in.
    let escalate: NodeJS.Timeout | undefined;
    let armed = false;
    const deadline = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      armed = true;
      escalate = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS);
      escalate.unref?.();
      finish(cpuVerdict(`GPU probe timed out after ${timeoutMs} ms and was terminated.`));
    }, timeoutMs);
    deadline.unref?.();

    try {
      const executable = command[0];
      if (typeof executable !== 'string' || executable === '') {
        finish(cpuVerdict('GPU probe was given no executable to run.'));
        return;
      }
      child = spawnFn(executable, [...command.slice(1), ...(opts.args ?? [])], {
        // ELECTRON_RUN_AS_NODE is what makes the Electron binary execute the
        // script as Node instead of starting a browser process.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      finish(cpuVerdict(`GPU probe could not be started: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    // Hand the live child to the caller before any listener can fire, so a
    // shutdown racing this spawn still has something to kill.
    opts.onChild?.(child);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 1_000_000) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        finish(cpuVerdict('GPU probe produced more output than the probe contract allows.'));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64_000) stderr = stderr.slice(0, 64_000);
    });
    child.on('error', (err: Error) => {
      finish(cpuVerdict(`GPU probe process error: ${err.message}`));
    });
    // An unhandled 'error' on a stream throws in the embedding process. Attach
    // a listener so a mid-transfer stream failure becomes a CPU verdict.
    child.stdout?.on('error', (err: Error) => {
      finish(cpuVerdict(`GPU probe output stream error: ${err.message}`));
    });
    child.stderr?.on('error', () => {
      // stderr is diagnostic only; never let its failure decide the verdict.
    });
    child.on('close', (code: number | null, signal: string | null) => {
      if (code !== 0) {
        const how = signal !== null ? `signal ${signal}` : `exit code ${code}`;
        const detail = stderr.trim().split('\n').slice(-1)[0] ?? '';
        finish(cpuVerdict(`GPU probe did not complete cleanly (${how})${detail === '' ? '' : `: ${detail}`}`));
        return;
      }
      let report: ProbeChildReport;
      try {
        // The child contract is exactly one JSON object on stdout; take the
        // last non-empty line so incidental native logging cannot break it.
        const lines = stdout.split('\n').filter((line) => line.trim() !== '');
        report = JSON.parse(lines[lines.length - 1] ?? '') as ProbeChildReport;
      } catch {
        finish(cpuVerdict('GPU probe did not return a readable report.'));
        return;
      }
      if (report.ok !== true) {
        const reason = typeof report.reason === 'string' && report.reason !== '' ? report.reason : 'GPU probe reported the device is not usable.';
        finish({ backend: 'cpu', ok: false, reason, device: typeof report.device === 'string' ? report.device : null });
        return;
      }
      // Defence in depth: the child's own `ok` is NOT taken at face value. A
      // backend that loads but generates garbage (llama.cpp #28648) is rejected
      // here, in the parent, even if the child said otherwise.
      const sample = typeof report.sample === 'string' ? report.sample : '';
      if (!probeOutputIsSane(sample)) {
        finish(cpuVerdict('GPU probe: the device loaded but produced unusable output, so GPU acceleration was rejected.'));
        return;
      }
      if (report.backend !== 'vulkan') {
        finish(cpuVerdict(`GPU probe: the device selected an unexpected backend (${String(report.backend)}), so GPU acceleration was rejected.`));
        return;
      }
      finish({
        backend: 'vulkan',
        ok: true,
        reason: 'GPU probe: Vulkan loaded and produced a sane generation.',
        device: typeof report.device === 'string' ? report.device : null,
      });
    });
  });
}

/** Terminate an in-flight probe child. Exported so host shutdown can guarantee
 *  no probe outlives the backend host (sidecar-manager.ts:245-252 shape). */
export function terminateProbeChild(child: { kill: (signal?: NodeJS.Signals) => unknown } | null): void {
  if (child === null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
}