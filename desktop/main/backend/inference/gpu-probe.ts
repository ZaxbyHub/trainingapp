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
import { StringDecoder } from 'node:string_decoder';
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
  /**
   * #156: decode throughput the probe measured on the active backend
   * (tokens/second of the fast model), when the probe produced one. OPTIONAL
   * so v1 sidecar records written before the field existed — and every CPU
   * failure shape, which measures nothing — stay valid; the reader adopts it
   * only when the record carries a finite number.
   */
  measured?: number | null;
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

/**
 * Issue #246 (AC4/AC6): the boot admission gate. One gate object per host
 * lifecycle generation. The host's boot-admission flight arms a gate at
 * start() and resolves the object it CAPTURED on every terminal path (a
 * stale flight from a previous lifecycle can only resolve its own, already
 * settled, object — it can never release a newer generation's admission).
 * The engine awaits `gpuVerdictGate()` before selecting a backend while the
 * gate is armed, so no load can construct from a pre-validation verdict.
 */
export interface GpuVerdictGate {
  promise: Promise<void>;
  resolve(): void;
}

let armedGate: GpuVerdictGate | null = null;

export function armGpuVerdictGate(): GpuVerdictGate {
  let resolveGate: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const gate: GpuVerdictGate = {
    promise,
    // Resolving DE-ARMS the gate when it is still the current generation's:
    // `gpuVerdictGate()` must read null once admission is settled (the
    // documented contract), so later loads take the no-suspension fast path —
    // a resolved-but-still-armed gate would keep suspending every query on a
    // microtask before profile capture (the b4 settings-race shape). A stale
    // generation's late resolve touches only its own object.
    resolve: () => {
      resolveGate();
      if (armedGate === gate) armedGate = null;
    },
  };
  armedGate = gate;
  return gate;
}

/** The currently armed gate's promise, or null when admission is settled. */
export function gpuVerdictGate(): Promise<void> | null {
  return armedGate !== null ? armedGate.promise : null;
}

/**
 * Reset the module lifecycle state for a new host start: drop the previous
 * lifecycle's verdict (it was validated for THAT lifecycle — issue #246
 * R3-3: a retained verdict must never bypass revalidation after a restart)
 * and arm a fresh gate for the boot-admission flight, which captures and
 * later resolves the RETURNED object.
 */
export function resetGpuVerdictLifecycle(): GpuVerdictGate {
  activeVerdict = null;
  return armGpuVerdictGate();
}

/** The sidecar name, used beside the other profile-dir sidecars. */
export const GPU_PROBE_SIDECAR = 'gpu-probe.json';
/** The sidecar schema this build writes AND understands. A record with any other
 *  `v` is ignored rather than adopted (PR #159 review PRR-022). */
export const GPU_PROBE_VERDICT_VERSION = 1;

/** Default probe deadline. The first GPU call pays a one-off warmup, so this is
 *  generous; it is a ceiling that must contain a hang, not a performance target. */
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

/** Grace between SIGTERM and SIGKILL when the deadline expires. Mirrors the
 *  terminate-then-escalate shape proven in sidecar-manager.ts:245-252. */
const KILL_GRACE_MS = 2_000;

/** A verdict that always falls back to CPU, with a stated reason. Issue #251
 *  (AC1): `device` carries the adapter identity when the failure path knows it
 *  (a child-reported device on a parsed report), so the persisted CPU verdict
 *  survives the #246 staleness reader and the boot stops re-probing. Shapes
 *  with no resolvable in-process identity (spawn/timeout/exit/parse failures)
 *  pass nothing and stay device-less — the parent must not import
 *  node-llama-cpp to enumerate adapters itself. */
function cpuVerdict(reason: string, device: string | null = null): GpuProbeVerdict {
  return { backend: 'cpu', ok: false, reason: reason === '' ? 'GPU probe did not report a reason' : reason, device };
}

/**
 * Read a persisted verdict. Missing, unparseable, non-object and
 * wrong-typed files all read as null; a missing verdict means "never probed",
 * which the engine resolves to CPU (an unprobed host behaves exactly as it did
 * before this feature).
 *
 * Issue #246 (AC4): a record is STALE — reads as null — when it carries no
 * device (a negative verdict must not outlive the machine state it described;
 * such records re-probe) or when `currentDevice` names the adapter this boot
 * actually sees and the record disagrees. Callers without adapter knowledge
 * omit `currentDevice` and still adopt device-bearing records.
 */
export function readGpuProbeVerdict(dir: string, currentDevice?: string | null): GpuProbeVerdict | null {
  try {
    const raw = fs.readFileSync(path.join(dir, GPU_PROBE_SIDECAR), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    // PR #159 review PRR-022: the writer stamps `v: 1` but the reader ignored
    // it, so the tag was decorative - a future record with the same field names
    // but different semantics would be adopted as authoritative, and a
    // non-adopted verdict would skip the boot probe. Only v1 is understood; an
    // unknown version reads as "not probed", which is the safe direction.
    if (record.v !== GPU_PROBE_VERDICT_VERSION) return null;
    if (record.backend !== 'vulkan' && record.backend !== 'cpu') return null;
    if (typeof record.ok !== 'boolean') return null;
    if (typeof record.reason !== 'string' || record.reason === '') return null;
    const device = record.device;
    const deviceText = typeof device === 'string' ? device : null;
    // issue #246 AC4: no device on record means the verdict cannot be bound
    // to this machine's adapter — treat it as never probed so the boot probe
    // re-establishes it.
    if (deviceText === null || deviceText === '') return null;
    if (typeof currentDevice === 'string' && currentDevice !== '' && currentDevice !== deviceText) return null;
    // #156: `measured` is OPTIONAL within v1 — a record written before the
    // field existed (or by a failure shape that measures nothing) reads back
    // without it, and only a finite number is adopted, never a coerced string
    // or NaN. This mirrors the tolerance rule update-checker established: an
    // unknown-shaped value degrades to "absent", never to a throw.
    const measured = record.measured;
    return {
      backend: record.backend,
      ok: record.ok,
      reason: record.reason,
      device: deviceText,
      ...(typeof measured === 'number' && Number.isFinite(measured) ? { measured } : {}),
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
    fs.writeSync(fd, JSON.stringify({ v: GPU_PROBE_VERDICT_VERSION, ...verdict }));
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
   * (the host uses it to clear its shutdown-abandoned flag). */
  onSettled?: () => void;
  /**
   * Issue #246 (AC4): run the child in `--device-only` mode — getLlama +
   * getGpuDeviceNames, no model load, a report with NO sample. The parsing
   * below skips the sample-sanity contract for this mode. Internal seam used
   * by runGpuDeviceQuery; full probes never set it.
   */
  deviceOnly?: boolean;
}

interface ProbeChildReport {
  ok?: unknown;
  backend?: unknown;
  device?: unknown;
  sample?: unknown;
  reason?: unknown;
  /** #156: decode tok/s the child measured, when it ran a full generation. */
  measured?: unknown;
}

/**
 * Run the probe out of process and resolve a verdict. NEVER throws and never
 * rejects: every failure mode - spawn error, timeout, non-zero exit, signal
 * death, unparseable stdout - resolves to a CPU verdict carrying a reason. The
 * caller (the host) therefore has exactly one code path to handle.
 *
 * Core contract (issue #246 AC4): in deviceOnly mode an EXTERNAL signal death
 * resolves `null` (mapped to 'cancelled' by runGpuDeviceQuery) — the internal
 * deadline always resolves its own timeout verdict before any close event can
 * arrive, so an unsettled signal close is provably someone else's kill.
 */
async function runGpuProbeCore(opts: GpuProbeRunOptions = {}): Promise<GpuProbeVerdict | null> {
  const command = opts.command ?? [process.execPath, gpuProbeChildPath()];
  const spawnFn = opts.spawnFn ?? spawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return await new Promise<GpuProbeVerdict | null>((resolve) => {
    let settled = false;
    let stdout = '';
    const decoder = new StringDecoder('utf8');
    let stderr = '';
    const decoder2 = new StringDecoder('utf8');
    let child: ReturnType<typeof spawn>;

    const finish = (verdict: GpuProbeVerdict | null): void => {
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
      // StringDecoder: a driver-reported adapter name is load-bearing across
      // processes (persisted, then compared byte-for-byte at the next boot's
      // admission flight), so a multi-byte sequence split at a chunk boundary
      // must not decode to U+FFFD in one child and not the other.
      stdout += decoder.write(chunk);
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
      stderr += decoder2.write(chunk);
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
      // Issue #246 (AC4): a signal death reaching an UNSETTLED device-only
      // query is an external kill (our own deadline settles first) — the
      // host's stop(), not a machine property. Full probes keep the historic
      // cpu-verdict classification for signal deaths.
      if (signal !== null && opts.deviceOnly === true) {
        finish(null);
        return;
      }
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
      // issue #246 (AC4): the device-only leg has its OWN report contract —
      // {ok, device, backend} with no sample — so the full-probe sample
      // sanity and backend checks below never apply to it.
      if (opts.deviceOnly === true) {
        const dev = typeof report.device === 'string' && report.device !== '' ? report.device : null;
        if (report.ok === true && report.backend === 'vulkan' && dev !== null) {
          finish({ backend: 'vulkan', ok: true, reason: 'GPU device query identified the adapter.', device: dev });
        } else {
          finish(cpuVerdict('GPU device query did not report a usable Vulkan adapter.'));
        }
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
      // Issue #251 (AC1): the child-reported adapter identity survives into
      // the CPU verdict — a failed probe on a KNOWN adapter persists a
      // device-bearing record the #246 boot flight can validate, instead of a
      // device-less one that re-probes every boot.
      const reportDevice = typeof report.device === 'string' && report.device !== '' ? report.device : null;
      const sample = typeof report.sample === 'string' ? report.sample : '';
      if (!probeOutputIsSane(sample)) {
        finish(cpuVerdict('GPU probe: the device loaded but produced unusable output, so GPU acceleration was rejected.', reportDevice));
        return;
      }
      if (report.backend !== 'vulkan') {
        finish(cpuVerdict(`GPU probe: the device selected an unexpected backend (${String(report.backend)}), so GPU acceleration was rejected.`, reportDevice));
        return;
      }
      finish({
        backend: 'vulkan',
        ok: true,
        reason: 'GPU probe: Vulkan loaded and produced a sane generation.',
        device: typeof report.device === 'string' ? report.device : null,
        // #156: the child's measured decode tok/s rides along when it
        // reported a finite number; a CPU/failed probe measures nothing.
        ...(typeof report.measured === 'number' && Number.isFinite(report.measured)
          ? { measured: report.measured }
          : {}),
      });
    });
  });
}

/**
 * The full-probe surface (never deviceOnly): keeps the historical NEVER-null
 * contract — every failure mode resolves a CPU verdict with a reason, so the
 * host has exactly one code path to handle.
 */
export async function runGpuProbe(opts: GpuProbeRunOptions = {}): Promise<GpuProbeVerdict> {
  const verdict = await runGpuProbeCore(opts);
  // null is producible only in deviceOnly mode (an external kill), which no
  // full-probe caller sets.
  return verdict ?? cpuVerdict('GPU probe was terminated before it could report.');
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

/**
 * Issue #246 (AC4): the result of a boot-time device-only query.
 *  - 'device': the child named the current Vulkan adapter.
 *  - 'unknown': every failure shape (ok:false, empty device list, non-vulkan
 *    backend, malformed stdout, spawn error, timeout) — callers fail OPEN
 *    (adopt the stored verdict) because the comparison only rejects on
 *    positive evidence of mismatch.
 *  - 'cancelled': OUR OWN shutdown killed the query (the runGpuProbe
 *    abandonedByHost pattern, extended here) — the caller adopts nothing.
 */
export type GpuDeviceQueryResult = { status: 'device'; device: string } | { status: 'unknown' } | { status: 'cancelled' };

export interface GpuDeviceRunOptions extends GpuProbeRunOptions {
  /** The host's abandoned-children set; a settled child present in it means
   * host shutdown killed this query — resolve 'cancelled', never fail-open. */
  abandonedChildren?: ReadonlySet<unknown>;
}

/**
 * Ask (out of process, no model load) which Vulkan adapter this machine has
 * right now. Never throws; see GpuDeviceQueryResult for the outcomes.
 *
 * Cancelled has two provable shapes: the caller's abandoned-children set
 * contains the settled child (the host's stop() kill), or the child died BY
 * SIGNAL while the query was still unsettled — an external kill, because the
 * internal deadline resolves timeout-unknown itself before any close event
 * can arrive.
 */
export async function runGpuDeviceQuery(opts: GpuDeviceRunOptions = {}): Promise<GpuDeviceQueryResult> {
  let child: { kill: (signal?: NodeJS.Signals) => unknown } | null = null;
  // 4.5-review PRR-003: abandonment must be captured INSIDE onSettled, BEFORE
  // delegating — the caller's own onSettled prunes the child from its set
  // (index.ts), so a post-await has() read the pruned set and could never be
  // true (the check was dead; 'cancelled' rested solely on signal death).
  let settledChildWasAbandoned = false;
  const verdict = await runGpuProbeCore({
    ...opts,
    deviceOnly: true,
    args: ['--device-only'],
    onChild: (spawned) => {
      child = spawned;
      opts.onChild?.(spawned);
    },
    onSettled: () => {
      settledChildWasAbandoned =
        child !== null && opts.abandonedChildren?.has(child) === true;
      opts.onSettled?.();
    },
  });
  if (verdict === null || settledChildWasAbandoned) return { status: 'cancelled' };
  if (verdict.ok && verdict.backend === 'vulkan' && typeof verdict.device === 'string' && verdict.device !== '') {
    return { status: 'device', device: verdict.device };
  }
  return { status: 'unknown' };
}
