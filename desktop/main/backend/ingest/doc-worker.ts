// doc-worker.ts — the document-parse RUNNER (issue #320 AC1/AC2).
//
// Moves the untrusted .docx / .pptx / .pdf parse (and the .docx/.pptx
// zip-bomb cap) out of the Electron main process into a child OS process,
// using the same launcher seam as the GPU probe (#289) and the workbook parser
// (#319): registered utilityProcess launcher inside Electron, node
// child_process.fork outside it, refusal — never an in-process fallback —
// inside Electron with no launcher registered. The child module is
// doc-worker-child.ts, compiled beside this one (dist sibling), with a .ts
// fallback for source-tree runs (vitest / headless dev server) where Node 24
// strips types natively; a packaged app ships only the compiled .js sibling.
//
// SELF-CONTAINED mirror of xlsx-worker.ts (plan Revision 2 R6: the proven
// xlsx runner is not modified; consolidating the three launcher seams is
// recorded for when a fourth child lands). Differences from the xlsx runner:
// the `doc worker: ` prefix, and the report carries an optional `pages` array
// (pdf pages / pptx slides) that is VALIDATED before adoption — {ok:true}
// needs a string `text` and, when `pages` is present, an array of
// {pageNumber: finite number, text: string}; anything else rejects with the
// prefix and is never adopted.
//
// Contract (frozen by desktop/src/__tests__/i320-doc-parsers-out-of-main.test.ts
// and i320-pdf-parity.test.ts):
//   - launcher invoked as `launcher(childPath, [absPath, ...optionalCap])`
//   - exactly ONE report over IPC, and the runner settles ON EXIT, not on the
//     message (gpu-probe lifecycle rule)
//   - every rejection carries the `doc worker: ` prefix
//   - deadline: kill(), then kill() again after the 2 s grace
//   - terminateDocWorkers() (wired into the backend host's stop()) rejects
//     every in-flight extraction and kills every live child.
import { fork as nodeFork, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { DOC_WORKER_ERROR_PREFIX } from './doc-worker-child.js';

/** Grace between the first deadline kill and the escalation kill. */
const KILL_GRACE_MS = 2_000;
/** Default deadline: a ceiling that must contain a hang, not a perf target. */
export const DEFAULT_DOC_TIMEOUT_MS = 120_000;
/** Serialized-report ceiling (chars). An oversize report also kills the child. */
const MAX_REPORT_CHARS = 16 * 1024 * 1024;
/** A clean exit can be observed before the report is dispatched (separate
 *  IPC channels); wait this long for it before concluding no report came. */
const EXIT_REPORT_GRACE_MS = 500;

/** The child handle surface shared by Electron's UtilityProcess and Node's
 *  forked ChildProcess (same surface as XlsxWorkerChild). kill() takes NO
 *  signal; launcher implementations decide what a repeat kill means. */
export interface DocWorkerChild {
  on(event: 'message', cb: (message: unknown) => void): unknown;
  on(event: 'exit', cb: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', cb: (...args: unknown[]) => void): unknown;
  kill(): unknown;
  readonly pid?: number | undefined;
  readonly stderr?: NodeJS.ReadableStream | null;
}

export type DocWorkerForkFn = (modulePath: string, args: string[]) => DocWorkerChild;

/** One extracted page (pdf page / pptx slide), as adopted from the report. */
export interface DocWorkerPage {
  pageNumber: number;
  text: string;
}

/** Plain-node launcher: fork with an IPC channel; stdout discarded (the
 *  report rides IPC), stderr piped for the failure detail, execArgv cleared
 *  so host loader flags never leak in. First kill() → SIGTERM; any later
 *  kill() → SIGKILL. A `.ts` childPath (the source-tree fallback) is launched
 *  as a plain `node <file.ts>` spawn with the same stdio shape. */
export const nodeForkDocWorker: DocWorkerForkFn = (modulePath, args) => {
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

let registeredForkFn: DocWorkerForkFn | null = null;

/** Register the launcher used inside Electron (the electron-aware entry calls
 *  this at app ready with a utilityProcess adapter); null restores default. */
export function setDocWorkerForkFn(forkFn: DocWorkerForkFn | null): void {
  registeredForkFn = forkFn;
}

/** Resolution order: registered override → node fork outside Electron → null
 *  (refuse) inside Electron with nothing registered. Resolved PER CALL. */
export function resolveDocWorkerForkFn(
  insideElectron: boolean = typeof process.versions.electron === 'string',
): DocWorkerForkFn | null {
  if (registeredForkFn !== null) return registeredForkFn;
  return insideElectron ? null : nodeForkDocWorker;
}

/** The compiled child entry beside this module; falls back to the .ts sibling
 *  when no compiled file exists (source-tree runs: vitest, the headless dev
 *  server). A packaged app always finds the compiled .js sibling. */
export function docWorkerChildPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(here, 'doc-worker-child.js');
  if (fs.existsSync(compiled)) return compiled;
  return path.join(here, 'doc-worker-child.ts');
}

/** Live children, so host shutdown can terminate every in-flight parse. */
const liveChildren = new Set<{
  child: DocWorkerChild;
  terminated: boolean;
  reject: (err: Error) => void;
}>();

/** Kill every live parse child and reject its in-flight extraction. Wired
 *  into the backend host's stop() so no parse child outlives the host. */
export function terminateDocWorkers(): void {
  for (const entry of liveChildren) {
    entry.terminated = true;
    try {
      entry.child.kill();
    } catch {
      // already gone
    }
    entry.reject(new Error(`${DOC_WORKER_ERROR_PREFIX}terminated by host shutdown`));
  }
  liveChildren.clear();
}

export interface ExtractDocOutOfProcessOptions {
  /** Zip-bomb cap, enforced INSIDE the child (bytes; .docx/.pptx only). */
  maxZipBytes?: number;
  /** Deadline in ms; on expiry the child is killed (then escalated). */
  timeoutMs?: number;
  /** Override the child module path (tests / fixture children). */
  childPath?: string;
}

export interface DocExtractionResult {
  text: string;
  pages?: DocWorkerPage[];
}

interface ChildReport {
  ok?: unknown;
  text?: unknown;
  pages?: unknown;
  error?: unknown;
}

/** Validate a report's optional `pages`: an array of {pageNumber: finite
 *  number, text: string}. Returns the copied pages, or null when malformed. */
function validatePages(pages: unknown): DocWorkerPage[] | null {
  if (!Array.isArray(pages)) return null;
  const out: DocWorkerPage[] = [];
  for (const page of pages) {
    if (typeof page !== 'object' || page === null || Array.isArray(page)) return null;
    const { pageNumber, text } = page as { pageNumber?: unknown; text?: unknown };
    if (typeof pageNumber !== 'number' || !Number.isFinite(pageNumber)) return null;
    if (typeof text !== 'string') return null;
    out.push({ pageNumber, text });
  }
  return out;
}

/**
 * Parse the document at `filePath` (.docx / .pptx / .pdf) in an isolated
 * child. Resolves {text, pages?} or rejects a normal catchable Error carrying
 * the `doc worker: ` prefix. Never leaves a child running past the deadline,
 * and never parses untrusted bytes in the calling process.
 */
export async function extractDocOutOfProcess(
  filePath: string,
  opts: ExtractDocOutOfProcessOptions = {},
): Promise<DocExtractionResult> {
  const forkFn = resolveDocWorkerForkFn();
  if (forkFn === null) {
    throw new Error(
      `${DOC_WORKER_ERROR_PREFIX}no utility-process launcher registered in this Electron process; refusing to parse a document in the main process`,
    );
  }
  const childPath = opts.childPath ?? docWorkerChildPath();
  const args = [path.resolve(filePath)];
  if (opts.maxZipBytes !== undefined) args.push(String(opts.maxZipBytes));
  // A non-positive timeoutMs would leave the deadline unarmed and a hung
  // child unwedgeable — clamp to the default instead of trusting it.
  const requestedTimeoutMs = opts.timeoutMs ?? DEFAULT_DOC_TIMEOUT_MS;
  const timeoutMs = requestedTimeoutMs > 0 ? requestedTimeoutMs : DEFAULT_DOC_TIMEOUT_MS;

  return new Promise<DocExtractionResult>((resolve, reject) => {
    let settled = false;
    let child: DocWorkerChild;
    let report: ChildReport | null = null;
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

    const finish = (err: Error | null, result?: DocExtractionResult, finishOpts?: { fromDeadline?: boolean }): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (exitGrace !== undefined) clearTimeout(exitGrace);
      if (finishOpts?.fromDeadline !== true && escalate !== undefined) clearTimeout(escalate);
      // A child that has not exited yet STAYS in liveChildren so a concurrent
      // terminateDocWorkers() can still reap it; the exit handler removes it.
      if (exited) liveChildren.delete(entry);
      // Reap exactly once per settle — skip when a kill was already issued
      // (deadline path) or when terminateDocWorkers() initiated the settle.
      if (!exited && killsIssued === 0 && !entry.terminated) {
        issueKill();
      }
      if (err !== null) reject(err);
      else resolve(result ?? { text: '' });
    };

    const entry = {
      child: null as unknown as DocWorkerChild,
      terminated: false,
      reject: (err: Error): void => finish(err),
    };
    liveChildren.add(entry);

    const evaluate = (): void => {
      if (settled) return;
      if (report !== null && report.ok === true) {
        if (typeof report.text !== 'string') {
          finish(new Error(`${DOC_WORKER_ERROR_PREFIX}malformed report: text is not a string`));
          return;
        }
        if (report.pages === undefined) {
          finish(null, { text: report.text });
          return;
        }
        const pages = validatePages(report.pages);
        if (pages === null) {
          finish(new Error(`${DOC_WORKER_ERROR_PREFIX}malformed report: pages must be an array of {pageNumber: finite number, text: string}`));
          return;
        }
        finish(null, { text: report.text, pages });
        return;
      }
      if (report !== null && report.ok === false) {
        const reason = typeof report.error === 'string' && report.error !== '' ? report.error : 'child reported failure without a reason';
        finish(new Error(reason.startsWith(DOC_WORKER_ERROR_PREFIX) ? reason : `${DOC_WORKER_ERROR_PREFIX}${reason}`));
        return;
      }
      // No usable report. Name the death cause: a signal (OOM, external
      // kill) is a different failure class from a clean protocol violation.
      const how =
        lastSignal !== null ? `signal ${lastSignal}`
        : lastExit !== null && lastExit !== 0 ? `exit code ${lastExit}`
        : 'no report';
      finish(new Error(`${DOC_WORKER_ERROR_PREFIX}the document parser child did not complete cleanly (${how})${stderrTail()}`));
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
      finish(new Error(`${DOC_WORKER_ERROR_PREFIX}could not start the document parser child: ${err instanceof Error ? err.message : String(err)}`));
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
        finish(new Error(`${DOC_WORKER_ERROR_PREFIX}extraction timed out after ${timeoutMs} ms and the child was terminated`), undefined, {
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
        // finish() issues the single reap; no pre-kill here.
        finish(new Error(`${DOC_WORKER_ERROR_PREFIX}the parser child produced more output than the report contract allows`));
        return;
      }
      if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
        const m = message as ChildReport;
        if (m.ok !== true && m.ok !== false) return; // not a report; ignore
        // Keep the raw fields: evaluate() VALIDATES them (a cast is not
        // validation) once the child has exited.
        report = { ok: m.ok, text: m.text, pages: m.pages, error: m.error };
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

    child.on('error', (...errArgs: unknown[]) => {
      // A spawn failure emits error+close and NEVER exit: treat it as
      // terminal for the live-set the same way the exit handler does.
      exited = true;
      liveChildren.delete(entry);
      const [first, second] = errArgs;
      const type = typeof first === 'string' ? first : first instanceof Error ? first.message : String(first);
      const detail = typeof second === 'string' && second !== '' ? `${type} at ${second}` : type;
      finish(new Error(`${DOC_WORKER_ERROR_PREFIX}document parser process error: ${detail}`));
    });

    child.on('exit', (code: number | null, signal?: NodeJS.Signals | null) => {
      exited = true;
      lastExit = typeof code === 'number' ? code : null;
      lastSignal = signal ?? null;
      liveChildren.delete(entry);
      if (settled) return;
      // The report and exit notifications travel separate channels and the
      // child exits non-zero on every failure, so the grace covers failure
      // exits too — otherwise a failure report landing after the exit event
      // would be discarded with the child's actual diagnostic.
      if ((signal ?? null) === null && report === null) {
        exitGrace = setTimeout(evaluate, EXIT_REPORT_GRACE_MS);
        exitGrace.unref?.();
        return;
      }
      evaluate();
    });
  });
}
