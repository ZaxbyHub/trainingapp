// xlsx-worker.ts — the workbook-parse RUNNER (issue #319 AC1).
//
// Moves the untrusted-workbook parse out of the Electron main process into a
// child OS process, using the same launcher seam PR #289 shipped for the GPU
// probe (registered utilityProcess launcher inside Electron, node
// child_process.fork outside it, refusal — never an in-process fallback —
// inside Electron with no launcher registered). The child module is
// xlsx-worker-child.ts, compiled beside this one (dist sibling), with a .ts
// fallback for source-tree runs (vitest / headless dev server) where Node 24
// strips types natively; a packaged app ships only the compiled .js sibling.
//
// Contract (frozen by desktop/src/__tests__/i289-xlsx-parse-isolation.test.ts):
//   - launcher invoked as `launcher(childPath, [absWorkbookPath, ...optionalCap])`
//   - exactly ONE report over IPC: {ok:true,text} | {ok:false,error}, and the
//     runner settles ON EXIT, not on the message (gpu-probe lifecycle rule)
//   - every rejection carries the `xlsx worker: ` prefix (child provenance)
//   - deadline: kill(), then kill() again after the grace (the launcher maps
//     the first kill to SIGTERM and later kills to SIGKILL; Electron's
//     utilityProcess.kill() takes no signal and is already forceful)
//   - a hung/crashed child can never wedge the caller: the deadline always
//     settles, and terminateXlsxWorkers() (wired into the backend host's
//     stop()) rejects every in-flight extraction and kills every live child.
import { fork as nodeFork, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { XLSX_WORKER_ERROR_PREFIX } from './xlsx-worker-child.js';

/** Grace between the first deadline kill and the escalation kill. */
const KILL_GRACE_MS = 2_000;
/** Default deadline: a ceiling that must contain a hang, not a perf target. */
export const DEFAULT_XLSX_TIMEOUT_MS = 120_000;
/** Serialized-report ceiling (chars). An oversize report also kills the child. */
const MAX_REPORT_CHARS = 16 * 1024 * 1024;
/** A clean exit can be observed before the report is dispatched (separate
 *  IPC channels); wait this long for it before concluding no report came. */
const EXIT_REPORT_GRACE_MS = 500;

/** The child handle surface shared by Electron's UtilityProcess and Node's
 *  forked ChildProcess. kill() takes NO signal (Electron's kill() takes
 *  none); launcher implementations decide what a repeat kill means. */
export interface XlsxWorkerChild {
  on(event: 'message', cb: (message: unknown) => void): unknown;
  on(event: 'exit', cb: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', cb: (...args: unknown[]) => void): unknown;
  kill(): unknown;
  readonly pid?: number | undefined;
  readonly stderr?: NodeJS.ReadableStream | null;
}

export type XlsxWorkerForkFn = (modulePath: string, args: string[]) => XlsxWorkerChild;

/** Plain-node launcher: fork with an IPC channel; stdout discarded (the
 *  report rides IPC), stderr piped for the failure detail, execArgv cleared
 *  so host loader flags never leak in. First kill() → SIGTERM; any later
 *  kill() → SIGKILL (escalation is the launcher's job — issue #319 F5).
 *  A `.ts` childPath (the source-tree fallback) cannot go through fork()'s
 *  CJS resolver, so it is launched as a plain `node <file.ts>` spawn with the
 *  same stdio shape — the ipc fd gives the child process.send, exactly like
 *  fork does. */
export const nodeForkXlsxWorker: XlsxWorkerForkFn = (modulePath, args) => {
  const stdio: Array<'ignore' | 'ignore' | 'pipe' | 'ipc'> = ['ignore', 'ignore', 'pipe', 'ipc'];
  const child =
    modulePath.toLowerCase().endsWith('.ts')
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
    on(event, cb) {
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
  };
};

let registeredForkFn: XlsxWorkerForkFn | null = null;

/** Register the launcher used inside Electron (the electron-aware entry calls
 *  this at app ready with a utilityProcess adapter); null restores default. */
export function setXlsxWorkerForkFn(forkFn: XlsxWorkerForkFn | null): void {
  registeredForkFn = forkFn;
}

/** Resolution order: registered override → node fork outside Electron → null
 *  (refuse) inside Electron with nothing registered. */
export function resolveXlsxWorkerForkFn(
  insideElectron: boolean = typeof process.versions.electron === 'string',
): XlsxWorkerForkFn | null {
  if (registeredForkFn !== null) return registeredForkFn;
  return insideElectron ? null : nodeForkXlsxWorker;
}

/** The compiled child entry beside this module; falls back to the .ts sibling
 *  when no compiled file exists (source-tree runs: vitest, the headless dev
 *  server). Node 24 strips types natively, so the fallback is launchable via
 *  a plain `node <file.ts>` spawn (see nodeForkXlsxWorker); a packaged app
 *  always finds the compiled .js sibling. */
export function xlsxWorkerChildPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(here, 'xlsx-worker-child.js');
  if (fs.existsSync(compiled)) return compiled;
  return path.join(here, 'xlsx-worker-child.ts');
}

/** Live children, so host shutdown can terminate every in-flight parse. */
const liveChildren = new Set<{
  child: XlsxWorkerChild;
  terminated: boolean;
  reject: (err: Error) => void;
}>();

/** Kill every live parse child and reject its in-flight extraction. Wired
 *  into the backend host's stop() so no parse child outlives the host. */
export function terminateXlsxWorkers(): void {
  for (const entry of liveChildren) {
    entry.terminated = true;
    try {
      entry.child.kill();
    } catch {
      // already gone
    }
    entry.reject(new Error(`${XLSX_WORKER_ERROR_PREFIX}terminated by host shutdown`));
  }
  liveChildren.clear();
}

export interface ExtractXlsxOutOfProcessOptions {
  /** Zip-bomb cap, enforced INSIDE the child (bytes). */
  maxZipBytes?: number;
  /** Deadline in ms; on expiry the child is killed (then escalated). */
  timeoutMs?: number;
  /** Override the child module path (tests / fixture children). */
  childPath?: string;
}

interface ChildReport {
  ok?: unknown;
  text?: unknown;
  error?: unknown;
}

/**
 * Parse the workbook at `filePath` in an isolated child. Resolves {text} or
 * rejects a normal catchable Error carrying the `xlsx worker: ` prefix. Never
 * leaves a child running past the deadline, and never parses untrusted bytes
 * in the calling process.
 */
export async function extractXlsxOutOfProcess(
  filePath: string,
  opts: ExtractXlsxOutOfProcessOptions = {},
): Promise<{ text: string }> {
  const forkFn = resolveXlsxWorkerForkFn();
  if (forkFn === null) {
    throw new Error(
      `${XLSX_WORKER_ERROR_PREFIX}no utility-process launcher registered in this Electron process; refusing to parse a workbook in the main process`,
    );
  }
  const childPath = opts.childPath ?? xlsxWorkerChildPath();
  const args = [path.resolve(filePath)];
  if (opts.maxZipBytes !== undefined) args.push(String(opts.maxZipBytes));
  // PRR-005: a non-positive timeoutMs would leave the deadline unarmed and a
  // hung child unwedgeable — clamp to the default instead of trusting it.
  const requestedTimeoutMs = opts.timeoutMs ?? DEFAULT_XLSX_TIMEOUT_MS;
  const timeoutMs = requestedTimeoutMs > 0 ? requestedTimeoutMs : DEFAULT_XLSX_TIMEOUT_MS;

  return new Promise<{ text: string }>((resolve, reject) => {
    let settled = false;
    let child: XlsxWorkerChild;
    let report: { ok: boolean; text?: string; error?: string } | null = null;
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
    // settle, per the frozen kill-count pin), and every other settle path
    // reaps a still-live child exactly once.
    let killsIssued = 0;
    const issueKill = (): void => {
      killsIssued += 1;
      try {
        child.kill();
      } catch {
        // already gone
      }
    };

    const finish = (err: Error | null, text?: string, opts?: { fromDeadline?: boolean }): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (exitGrace !== undefined) clearTimeout(exitGrace);
      if (opts?.fromDeadline !== true && escalate !== undefined) clearTimeout(escalate);
      // PRR-013: a child that has not exited yet STAYS in liveChildren so a
      // concurrent terminateXlsxWorkers() can still reap it; the exit handler
      // performs the removal once the OS process is gone.
      if (exited) liveChildren.delete(entry);
      // PRR-006: reap exactly once per settle — skip when a kill was already
      // issued (deadline path) or when terminateXlsxWorkers() initiated the
      // settle (its own kill already ran; a second call would escalate to
      // SIGKILL and skip the SIGTERM grace).
      if (!exited && killsIssued === 0 && !entry.terminated) {
        issueKill();
      }
      if (err !== null) reject(err);
      else resolve({ text: text ?? '' });
    };

    const entry = {
      child: null as unknown as XlsxWorkerChild,
      terminated: false,
      reject: (err: Error): void => finish(err),
    };
    liveChildren.add(entry);

    const evaluate = (): void => {
      if (settled) return;
      if (report !== null && report.ok === true) {
        if (typeof report.text === 'string') {
          finish(null, report.text);
          return;
        }
        finish(new Error(`${XLSX_WORKER_ERROR_PREFIX}report carried no text`));
        return;
      }
      if (report !== null && report.ok === false) {
        const reason = typeof report.error === 'string' && report.error !== '' ? report.error : 'child reported failure without a reason';
        finish(new Error(reason.startsWith(XLSX_WORKER_ERROR_PREFIX) ? reason : `${XLSX_WORKER_ERROR_PREFIX}${reason}`));
        return;
      }
      // No usable report. Name the death cause: a signal (OOM, external
      // kill) is a different failure class from a clean protocol violation
      // (PRR-014) — the gpu-probe runner reports signals the same way.
      const how =
        lastSignal !== null ? `signal ${lastSignal}`
        : lastExit !== null && lastExit !== 0 ? `exit code ${lastExit}`
        : 'no report';
      finish(new Error(`${XLSX_WORKER_ERROR_PREFIX}the workbook parser child did not complete cleanly (${how})${stderrTail()}`));
    };

    const stderrTail = (): string => {
      const detail = stderr.trim().split('\n').slice(-1)[0] ?? '';
      return detail === '' ? '' : `: ${detail}`;
    };

    try {
      child = forkFn(childPath, args);
    } catch (err) {
      // No child exists to kill: mark it exited so finish() does not reap.
      exited = true;
      liveChildren.delete(entry);
      finish(new Error(`${XLSX_WORKER_ERROR_PREFIX}could not start the workbook parser child: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    entry.child = child;

    if (timeoutMs > 0) {
      deadline = setTimeout(() => {
        if (settled) return;
        issueKill();
        escalate = setTimeout(() => {
          issueKill();
        }, KILL_GRACE_MS);
        escalate.unref?.();
        finish(new Error(`${XLSX_WORKER_ERROR_PREFIX}extraction timed out after ${timeoutMs} ms and the child was terminated`), undefined, {
          fromDeadline: true,
        });
      }, timeoutMs);
      deadline.unref?.();
    }

    child.on('message', (message: unknown) => {
      if (settled) return;
      let size = Number.POSITIVE_INFINITY;
      try {
        size = JSON.stringify(message)?.length ?? 0;
      } catch {
        // unserializable: treated as oversize below
      }
      if (size > MAX_REPORT_CHARS) {
        // PRR-006: finish() issues the single reap; no pre-kill here.
        finish(new Error(`${XLSX_WORKER_ERROR_PREFIX}the parser child produced more output than the report contract allows`));
        return;
      }
      if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
        const m = message as ChildReport;
        if (m.ok !== true && m.ok !== false) return; // not a report; ignore
        report = { ok: m.ok, ...(typeof m.text === 'string' ? { text: m.text } : {}), ...(typeof m.error === 'string' ? { error: m.error } : {}) };
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += decoder.write(chunk);
      // PRR-007: keep the TAIL — the crash reason is at the end of the
      // stream, and stderrTail() reports the last line.
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.stderr?.on('error', () => {
      // stderr is diagnostic only; never let its failure decide the result.
    });

    child.on('error', (...args: unknown[]) => {
      // A spawn failure emits error+close and NEVER exit (PRR-013 follow-up,
      // fix-review r1): treat it as terminal for the live-set the same way
      // the exit handler does, or the entry leaks until host stop.
      exited = true;
      liveChildren.delete(entry);
      const [first, second] = args;
      const type = typeof first === 'string' ? first : first instanceof Error ? first.message : String(first);
      const detail = typeof second === 'string' && second !== '' ? `${type} at ${second}` : type;
      finish(new Error(`${XLSX_WORKER_ERROR_PREFIX}workbook parser process error: ${detail}`));
    });

    child.on('exit', (code: number | null, signal?: NodeJS.Signals | null) => {
      exited = true;
      lastExit = typeof code === 'number' ? code : null;
      lastSignal = (signal ?? null);
      liveChildren.delete(entry);
      if (settled) return;
      // PRR-004: the report and exit notifications travel separate channels
      // and the child exits non-zero on every failure, so the grace must
      // cover failure exits too — otherwise a failure report that lands
      // after the exit event is discarded and the parent loses the child's
      // actual diagnostic (e.g. the zip-cap reason).
      if ((signal ?? null) === null && report === null) {
        exitGrace = setTimeout(evaluate, EXIT_REPORT_GRACE_MS);
        exitGrace.unref?.();
        return;
      }
      evaluate();
    });
  });
}
