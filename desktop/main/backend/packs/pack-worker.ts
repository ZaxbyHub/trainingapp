// pack-worker.ts — the pack-extraction RUNNER (issue #320 AC3).
//
// Moves untrusted pack-zip EXTRACTION (JSZip over attacker-supplied upload
// bytes) out of the Electron main process into a child OS process, using the
// same launcher seam the GPU probe (#289) and the workbook parser (#319)
// ship: a registered utilityProcess launcher inside Electron, a node
// child_process fork outside it, and REFUSAL — never an in-process fallback —
// inside Electron with nothing registered. The child module is
// pack-extract-child.ts, compiled beside this one (dist sibling), with a .ts
// fallback for source-tree runs (vitest / headless dev server) where Node 24
// strips types natively.
//
// Contract (frozen by desktop/src/__tests__/i320-pack-extract-out-of-main.test.ts):
//   - PARENT-OWNED per-call workspace: fs.mkdtempSync(<tmp>/pack-extract-)
//     holding input.zip (the parent writes the received bytes) and out/ (the
//     parent creates it; the child extracts into it). On success out/ is
//     MOVED into a FRESH mkdtemp dir (<tmp>/pack-install-) that is returned
//     (the caller owns its cleanup, exactly as before the migration); on
//     success AND every failure path the whole workspace is removed.
//   - launcher invoked as
//       launcher(childPath, [absZipPath, absOutDir, filename, limitsJson])
//   - exactly ONE report over IPC: {ok:true, dir} | {ok:false, code, error};
//     the runner settles ON EXIT, never on the message alone. A success
//     report is adopted ONLY when report.dir === the out dir passed as
//     args[1] — a LITERAL string comparison with no normalization; any other
//     dir is a malformed report and the foreign tree is never touched.
//   - a report-derived failure rejects with PackManagerError(error) — the
//     child's final message verbatim (report codes are diagnostic-only and
//     never surfaced); every runner-fabricated rejection (launch refusal or
//     throw, crash/no report, malformed or oversize report, deadline,
//     termination, staging failure) is a plain Error with the
//     `pack worker: ` prefix.
//   - deadline: kill(), then kill() again after the 2 s grace (the node
//     launcher maps the first kill to SIGTERM and later kills to SIGKILL).
//   - terminatePackWorkers() (wired into the backend host's stop()) kills
//     every live child and rejects every in-flight extraction.
//
// Options-free production surface (C3 R24-1/R25-1): extractPackZipOutOfProcess
// takes EXACTLY three parameters and delegates with the literal {} — extra
// call arguments are inert. The test-control options (timeoutMs, childPath)
// enter ONLY through extractPackZipWithOptions, which no production module
// calls. Both delegate to the UNEXPORTED core runPackExtraction.
import { fork as nodeFork, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { PackManagerError } from '../store/pack-manager.js';
import {
  DEFAULT_PACKS_MAX_COMPRESSION_RATIO,
  DEFAULT_PACKS_MAX_ENTRIES,
  DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES,
  type PackSecurityLimits,
} from './pack-archive-rules.js';
import { PACK_WORKER_ERROR_PREFIX } from './pack-extract-child.js';

/** Grace between the first deadline kill and the escalation kill. */
const KILL_GRACE_MS = 2_000;
/** Default deadline: a ceiling that must contain a hang, not a perf target. */
export const DEFAULT_PACK_TIMEOUT_MS = 120_000;
/** Serialized-report ceiling (chars). An oversize report also kills the child. */
const MAX_REPORT_CHARS = 16 * 1024 * 1024;
/** A clean exit can be observed before the report is dispatched (separate
 *  IPC channels); wait this long for it before concluding no report came. */
const EXIT_REPORT_GRACE_MS = 500;
/** Workspace / adoption directory prefixes (frozen by the C3 spec). */
const WORKSPACE_PREFIX = 'pack-extract-';
const ADOPTED_PREFIX = 'pack-install-';
const WORKSPACE_INPUT = 'input.zip';
const WORKSPACE_OUT = 'out';

/** The child handle surface shared by Electron's UtilityProcess and Node's
 *  forked ChildProcess (the XlsxWorkerChild shape). kill() takes NO signal;
 *  launcher implementations decide what a repeat kill means. */
export interface PackWorkerChild {
  on(event: 'message', cb: (message: unknown) => void): unknown;
  on(event: 'exit', cb: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', cb: (...args: unknown[]) => void): unknown;
  kill(): unknown;
  readonly pid?: number | undefined;
  readonly stderr?: NodeJS.ReadableStream | null;
}

export type PackWorkerForkFn = (modulePath: string, args: string[]) => PackWorkerChild;

/** Test-control options (reachable ONLY through extractPackZipWithOptions). */
export interface PackExtractOptions {
  /** Deadline in ms; on expiry the child is killed (then escalated). */
  timeoutMs?: number;
  /** Override the child module path (tests / fixture children). */
  childPath?: string;
}

/** Plain-node launcher: fork with an IPC channel; stdout discarded (the
 *  report rides IPC), stderr piped for the failure detail, execArgv cleared
 *  so host loader flags never leak in. First kill() → SIGTERM; any later
 *  kill() → SIGKILL. A `.ts` childPath (the source-tree fallback) is launched
 *  as a plain `node <file.ts>` spawn with the same stdio shape — the ipc fd
 *  gives the child process.send, exactly like fork does. */
export function nodeForkPackWorker(modulePath: string, args: string[]): PackWorkerChild {
  const stdio: Array<'ignore' | 'pipe' | 'ipc'> = ['ignore', 'ignore', 'pipe', 'ipc'];
  const child = modulePath.toLowerCase().endsWith('.ts')
    ? // execArgv is honored at runtime but absent from this @types/node's
      // SpawnOptions — the cast keeps the loader-flags clearing explicit.
      nodeSpawn(process.execPath, [modulePath, ...args], { stdio, execArgv: [] } as Parameters<typeof nodeSpawn>[2])
    : nodeFork(modulePath, args, { stdio, execArgv: [] });
  let kills = 0;
  return {
    get pid() {
      return child.pid;
    },
    get stderr() {
      return child.stderr;
    },
    on(event: string, cb: (...args: never[]) => void) {
      return child.on(event as 'message' | 'exit' | 'error', cb as never);
    },
    kill() {
      kills += 1;
      try {
        child.kill(kills <= 1 ? 'SIGTERM' : 'SIGKILL');
      } catch {
        // already gone
      }
      return true;
    },
  } as PackWorkerChild;
}

let registeredForkFn: PackWorkerForkFn | null = null;

/** Register the launcher used inside Electron (the electron-aware entry calls
 *  this at app ready with a utilityProcess adapter); null restores default. */
export function setPackWorkerForkFn(fn: PackWorkerForkFn | null): void {
  registeredForkFn = fn;
}

/** Resolution order: registered override → node fork outside Electron → null
 *  (refuse) inside Electron with nothing registered. */
export function resolvePackWorkerForkFn(
  insideElectron: boolean = typeof process.versions.electron === 'string',
): PackWorkerForkFn | null {
  if (registeredForkFn !== null) return registeredForkFn;
  return insideElectron ? null : nodeForkPackWorker;
}

/** The compiled child entry beside this module; falls back to the .ts sibling
 *  when no compiled file exists (source-tree runs). A packaged app always
 *  finds the compiled .js sibling. */
export function packWorkerChildPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(here, 'pack-extract-child.js');
  if (fs.existsSync(compiled)) return compiled;
  return path.join(here, 'pack-extract-child.ts');
}

/** Live children, so host shutdown can terminate every in-flight extraction. */
const liveChildren = new Set<{
  child: PackWorkerChild;
  terminated: boolean;
  reject: (err: Error) => void;
}>();

/** Kill every live extraction child and reject its in-flight extraction.
 *  Wired into the backend host's stop() so no pack child outlives the host. */
export function terminatePackWorkers(): void {
  for (const entry of liveChildren) {
    entry.terminated = true;
    try {
      entry.child.kill();
    } catch {
      // already gone
    }
    entry.reject(new Error(`${PACK_WORKER_ERROR_PREFIX}terminated by host shutdown`));
  }
  liveChildren.clear();
}

/**
 * PRODUCTION entry (options-free): extract `zipBytes` in an isolated child
 * under the RESOLVED `limits` and return the fresh directory holding the
 * extracted tree. The caller owns its cleanup.
 */
export async function extractPackZipOutOfProcess(
  zipBytes: Uint8Array,
  filename: string,
  limits: PackSecurityLimits,
): Promise<string> {
  return runPackExtraction(zipBytes, filename, limits, {});
}

/**
 * TEST-CONTROL entry: the same extraction with the deadline / child-path
 * controls. Takes the bridge's OPTIONAL limits shape and resolves it the way
 * extractPackZip does (explicit fields beat the TRAININGAPP_PACKS_* env seam
 * beat the defaults). No production module calls this.
 */
export async function extractPackZipWithOptions(
  zipBytes: Uint8Array,
  filename: string,
  limits?: Partial<PackSecurityLimits>,
  opts?: PackExtractOptions,
): Promise<string> {
  return runPackExtraction(zipBytes, filename, resolveExtractionLimits(process.env, limits), opts);
}

// --------------------------------------------------------------------- //
// limits resolution for the options variant (the bridge's resolvePackLimits
// semantics; pack-extract.ts owns the production resolution and is not
// imported here — the runner must not gain an edge into that module)
// --------------------------------------------------------------------- //

function envNumber(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  parse: (raw: string) => number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = parse(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`[pack-extract] ignoring invalid ${key}=${raw}; using the default ${fallback}`);
    return fallback;
  }
  return value;
}

function resolveExtractionLimits(
  env: Record<string, string | undefined>,
  limits?: Partial<PackSecurityLimits>,
): PackSecurityLimits {
  return {
    maxUncompressedBytes:
      limits?.maxUncompressedBytes ??
      envNumber(env, 'TRAININGAPP_PACKS_MAX_UNCOMPRESSED_BYTES', DEFAULT_PACKS_MAX_UNCOMPRESSED_BYTES, (raw) => Number.parseInt(raw, 10)),
    maxEntries:
      limits?.maxEntries ??
      envNumber(env, 'TRAININGAPP_PACKS_MAX_ENTRIES', DEFAULT_PACKS_MAX_ENTRIES, (raw) => Number.parseInt(raw, 10)),
    maxCompressionRatio:
      limits?.maxCompressionRatio ??
      envNumber(env, 'TRAININGAPP_PACKS_MAX_COMPRESSION_RATIO', DEFAULT_PACKS_MAX_COMPRESSION_RATIO, (raw) => Number.parseFloat(raw)),
  };
}

// --------------------------------------------------------------------- //
// the options-aware core (UNEXPORTED)
// --------------------------------------------------------------------- //

/** Remove the workspace; a still-dying child can briefly hold a handle on
 *  Windows, so failures retry in the background (best effort). */
function removeWorkspace(work: string): void {
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (err) {
    console.error(
      `[pack-worker] could not remove the extraction workspace ${work}: ${err instanceof Error ? err.message : String(err)}; retrying in the background`,
    );
    let attempts = 0;
    const retry = (): void => {
      attempts += 1;
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {
        if (attempts < 10) setTimeout(retry, 500).unref?.();
      }
    };
    setTimeout(retry, 500).unref?.();
  }
}

/** Move every top-level entry of `from` into the existing directory `to`
 *  (same volume: both live under os.tmpdir(); EXDEV falls back to a copy). */
function moveTree(from: string, to: string): void {
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name);
    const target = path.join(to, name);
    try {
      fs.renameSync(source, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      fs.cpSync(source, target, { recursive: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
  }
}

async function runPackExtraction(
  zipBytes: Uint8Array,
  filename: string,
  limits: PackSecurityLimits,
  opts: PackExtractOptions = {},
): Promise<string> {
  const forkFn = resolvePackWorkerForkFn();
  if (forkFn === null) {
    throw new Error(
      `${PACK_WORKER_ERROR_PREFIX}no utility-process launcher registered in this Electron process; refusing to extract a pack archive in the main process`,
    );
  }
  const childPath = opts.childPath ?? packWorkerChildPath();
  // A non-positive timeoutMs would leave the deadline unarmed and a hung
  // child unwedgeable — clamp to the default instead of trusting it.
  const requestedTimeoutMs = opts.timeoutMs ?? DEFAULT_PACK_TIMEOUT_MS;
  const timeoutMs = requestedTimeoutMs > 0 ? requestedTimeoutMs : DEFAULT_PACK_TIMEOUT_MS;

  let work: string;
  try {
    work = fs.mkdtempSync(path.join(os.tmpdir(), WORKSPACE_PREFIX));
  } catch (err) {
    throw new Error(
      `${PACK_WORKER_ERROR_PREFIX}could not create the extraction workspace: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const zipPath = path.join(work, WORKSPACE_INPUT);
    const outDir = path.join(work, WORKSPACE_OUT);
    try {
      fs.writeFileSync(zipPath, zipBytes);
      fs.mkdirSync(outDir);
    } catch (err) {
      throw new Error(
        `${PACK_WORKER_ERROR_PREFIX}could not stage the pack archive for extraction: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // A child that outlives the settle (deadline / termination while it
    // ignores the first kill) could still write under <work>/out after the
    // workspace removal below; its eventual exit re-runs the removal.
    await runChild(forkFn, childPath, [zipPath, outDir, filename, JSON.stringify(limits)], outDir, timeoutMs, () =>
      removeWorkspace(work),
    );
    // Adoption: the validated out dir's tree moves into a FRESH directory
    // the caller owns; the workspace itself is removed below.
    const adopted = fs.mkdtempSync(path.join(os.tmpdir(), ADOPTED_PREFIX));
    try {
      moveTree(outDir, adopted);
    } catch (err) {
      fs.rmSync(adopted, { recursive: true, force: true });
      throw new Error(
        `${PACK_WORKER_ERROR_PREFIX}could not adopt the extracted pack: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return adopted;
  } finally {
    removeWorkspace(work);
  }
}

interface ChildReport {
  ok?: unknown;
  dir?: unknown;
  code?: unknown;
  error?: unknown;
}

/** Launch one child and settle on its exit: resolves when the child
 *  reported success naming exactly `outDir`; rejects otherwise. */
function runChild(
  forkFn: PackWorkerForkFn,
  childPath: string,
  args: string[],
  outDir: string,
  timeoutMs: number,
  onLateExit: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let child: PackWorkerChild;
    let report: ChildReport | null = null;
    let duplicateReport = false;
    let stderr = '';
    const decoder = new StringDecoder('utf8');
    let exitGrace: NodeJS.Timeout | undefined;
    let escalate: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let exited = false;
    let lastExit: number | null = null;
    let lastSignal: NodeJS.Signals | null = null;
    // Kills are counted so the settle path never double-fires: the deadline
    // path issues its own kill + escalation kill (the escalation survives
    // settle), and every other settle path reaps a still-live child once.
    let killsIssued = 0;
    const issueKill = (): void => {
      killsIssued += 1;
      try {
        child.kill();
      } catch {
        // already gone
      }
    };

    const finish = (err: Error | null, finishOpts?: { fromDeadline?: boolean }): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (exitGrace !== undefined) clearTimeout(exitGrace);
      if (finishOpts?.fromDeadline !== true && escalate !== undefined) clearTimeout(escalate);
      // A child that has not exited yet STAYS in liveChildren so a concurrent
      // terminatePackWorkers() can still reap it; the exit handler removes it.
      if (exited) liveChildren.delete(entry);
      if (!exited && killsIssued === 0 && !entry.terminated) {
        issueKill();
      }
      if (err !== null) reject(err);
      else resolve();
    };

    const entry = {
      child: null as unknown as PackWorkerChild,
      terminated: false,
      reject: (err: Error): void => finish(err),
    };
    liveChildren.add(entry);

    const stderrTail = (): string => {
      const detail = stderr.trim().split('\n').slice(-1)[0] ?? '';
      return detail === '' ? '' : `: ${detail}`;
    };

    const malformed = (why: string): Error =>
      new Error(`${PACK_WORKER_ERROR_PREFIX}the pack extraction child sent a malformed report (${why})`);

    const evaluate = (): void => {
      if (settled) return;
      if (duplicateReport) {
        finish(malformed('more than one report'));
        return;
      }
      if (report !== null && report.ok === true) {
        // EXACT STRING IDENTITY with the out dir passed as args[1] — no
        // normalization of either side; anything else is never adopted.
        if (typeof report.dir === 'string' && report.dir === outDir) {
          finish(null);
          return;
        }
        finish(malformed('the success report does not name the extraction output directory'));
        return;
      }
      if (report !== null && report.ok === false) {
        const { code, error } = report;
        if (typeof code !== 'string' || code === '' || typeof error !== 'string' || error === '') {
          finish(malformed('the failure report carries no code or no error'));
          return;
        }
        // PRR-015 (review round 2): strict 1/true per the repo envBool
        // convention - explicit-off spellings must not enable the log.
        const debug = process.env.TRAININGAPP_PACK_WORKER_DEBUG === '1' || process.env.TRAININGAPP_PACK_WORKER_DEBUG === 'true';
        if (debug) {
          // Diagnostic-only: the code is logged, never surfaced.
          console.error(`[pack-worker] child refusal code=${code}`);
        }
        finish(new PackManagerError(error));
        return;
      }
      // No usable report: name the death cause (a signal is a different
      // failure class from a clean protocol violation).
      const how =
        lastSignal !== null ? `signal ${lastSignal}`
        : lastExit !== null && lastExit !== 0 ? `exit code ${lastExit}`
        : 'no report';
      finish(new Error(`${PACK_WORKER_ERROR_PREFIX}the pack extraction child did not complete cleanly (${how})${stderrTail()}`));
    };

    try {
      child = forkFn(childPath, args);
    } catch (err) {
      // No child exists to kill: mark it exited so finish() does not reap.
      exited = true;
      liveChildren.delete(entry);
      finish(
        new Error(
          `${PACK_WORKER_ERROR_PREFIX}could not start the pack extraction child: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    entry.child = child;

    deadline = setTimeout(() => {
      if (settled) return;
      issueKill();
      escalate = setTimeout(() => {
        if (!exited) issueKill();
      }, KILL_GRACE_MS);
      escalate.unref?.();
      finish(new Error(`${PACK_WORKER_ERROR_PREFIX}extraction timed out after ${timeoutMs} ms and the child was terminated`), {
        fromDeadline: true,
      });
    }, timeoutMs);
    deadline.unref?.();

    child.on('message', (message: unknown) => {
      if (settled) return;
      let size = Number.POSITIVE_INFINITY;
      try {
        size = JSON.stringify(message)?.length ?? 0;
      } catch {
        // unserializable: treated as oversize below
      }
      if (size > MAX_REPORT_CHARS) {
        // finish() issues the single reap.
        finish(new Error(`${PACK_WORKER_ERROR_PREFIX}the pack extraction child produced more output than the report contract allows`));
        return;
      }
      if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
        const m = message as ChildReport;
        if (m.ok !== true && m.ok !== false) return; // not a report; ignore
        if (report !== null) {
          duplicateReport = true;
          return;
        }
        report = { ok: m.ok, dir: m.dir, code: m.code, error: m.error };
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += decoder.write(chunk);
      // Keep the TAIL — the crash reason is at the end of the stream.
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.stderr?.on('error', () => {
      // stderr is diagnostic only; never let its failure decide the result.
    });

    child.on('error', (...errorArgs: unknown[]) => {
      // A spawn failure emits error+close and NEVER exit: treat it as
      // terminal for the live set the same way the exit handler does.
      exited = true;
      liveChildren.delete(entry);
      const [first, second] = errorArgs;
      const type = typeof first === 'string' ? first : first instanceof Error ? first.message : String(first);
      const detail = typeof second === 'string' && second !== '' ? `${type} at ${second}` : type;
      finish(new Error(`${PACK_WORKER_ERROR_PREFIX}pack extraction process error: ${detail}`));
    });

    child.on('exit', (code: number | null, signal?: NodeJS.Signals | null) => {
      exited = true;
      lastExit = typeof code === 'number' ? code : null;
      lastSignal = signal ?? null;
      liveChildren.delete(entry);
      if (escalate !== undefined) clearTimeout(escalate);
      if (settled) {
        onLateExit();
        return;
      }
      // The report and exit notifications travel separate channels and the
      // child exits non-zero on every failure, so the grace covers failure
      // exits too — a failure report landing after the exit event must not
      // be discarded.
      if ((signal ?? null) === null && report === null) {
        exitGrace = setTimeout(evaluate, EXIT_REPORT_GRACE_MS);
        exitGrace.unref?.();
        return;
      }
      evaluate();
    });
  });
}
