// xlsx-worker-child.ts — the workbook-parse CHILD (issue #319 AC1).
//
// This module is the ONLY place in desktop/main where an untrusted workbook
// is parsed. It runs as a separate OS process (an Electron utilityProcess in
// the packaged app, a node child_process.fork outside it), so a poisoned
// workbook can crash or hang only this child — never the privileged main
// process that holds the store, the launch token and the filesystem.
//
// The parse logic is moved byte-for-byte from the former in-process
// extractXlsxFile (lazy `import('xlsx')`, XLSX.read, per-sheet sheet_to_csv,
// non-empty sheets trimmed, joined by a blank line), so extracted text stays
// identical to packtool's extractor — pinned by the committed parity fixture
// (contracts/fixtures/xlsx-parity/) and packtool/scripts/verify-xlsx-parity.mjs.
//
// Report protocol (exactly one report over IPC, then exit):
//   { ok: true, text: string }  |  { ok: false, error: string }
// Every failure error message carries the `xlsx worker: ` prefix. The pin is
// REPORT-derivation, not message uniqueness: a rejection whose text arrives in
// a child REPORT ({ok:false, error}) is child-origin (the T10b provenance leg
// pins exactly that — an in-parent cap check cannot produce it). Parent-origin
// failures (launch refusal, no report, deadline) reuse the prefix for uniform
// display and MUST NOT be cited as child-origin evidence.
//
// This module must stay electron-free (the backend/types.ts rule): nothing
// here imports electron. Under vitest it is imported directly; its self-run
// entry fires only when the module IS the process entry, exactly like
// gpu-probe-child.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Failure messages are prefixed so the parent can prove child provenance. */
export const XLSX_WORKER_ERROR_PREFIX = 'xlsx worker: ';

interface Workbook {
  SheetNames: string[];
  Sheets: Record<string, unknown>;
}
interface SheetJs {
  read(data: Buffer, opts: { type: 'buffer' }): Workbook;
  utils: { sheet_to_csv(sheet: unknown): string };
}

/**
 * The zip-bomb guard, moved into the child (issue #319 plan-critic round 1
 * F4): the parent must not parse ANY untrusted xlsx byte, including the
 * central-directory read the old parent-side assertZipWithinCap performed.
 * Same semantics as the parent guard it replaces for .docx/.pptx: sum the
 * DECLARED uncompressed sizes and refuse past the cap.
 */
export async function assertZipWithinCapInChild(bytes: Buffer, capBytes: number): Promise<void> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  let declared = 0;
  zip.forEach((_relativePath, entry) => {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof size === 'number') declared += size;
  });
  if (declared > capBytes) {
    throw new Error(
      `${XLSX_WORKER_ERROR_PREFIX}zip content declares ${declared} decompressed bytes, exceeding the ${capBytes}-byte extraction cap; refusing`,
    );
  }
}

/** Extracted text: per-sheet CSV, non-empty sheets trimmed, blank-line joined. */
export async function parseWorkbookToCsv(filePath: string): Promise<string> {
  const XLSX = (await import('xlsx')) as unknown as SheetJs;
  const workbook = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
    if (csv.trim().length > 0) parts.push(csv.trim());
  }
  return parts.join('\n\n');
}

/** The utility-process parent port (Electron), when this is a utility process. */
function parentPort(): { postMessage(message: unknown): void } | null {
  const port = (process as unknown as { parentPort?: { postMessage(message: unknown): void } | null }).parentPort;
  return port !== undefined && port !== null && typeof port.postMessage === 'function' ? port : null;
}

/**
 * Deliver the ONE report over the IPC channel and resolve once it is handed
 * off: parentPort.postMessage writes synchronously into the Mojo pipe; Node's
 * process.send is asynchronous, so its callback gates the caller's exit.
 * With no IPC channel at all (a manual run) the report goes to stdout.
 */
function emit(report: Record<string, unknown>, channel?: { postMessage(message: unknown): void }): Promise<void> {
  if (channel !== undefined) {
    channel.postMessage(report);
    return Promise.resolve();
  }
  const port = parentPort();
  if (port !== null) {
    port.postMessage(report);
    return Promise.resolve();
  }
  if (typeof process.send === 'function') {
    return new Promise((resolve) => {
      process.send?.(report, undefined, undefined, () => resolve());
    });
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return Promise.resolve();
}

/**
 * The child entry. argv shape (issue #319 frozen contract): the workbook path
 * is the LAST element; an optional numeric zip cap rides as the element before
 * it. Returns the process exit code (0 success, 1 failure) after the report
 * has been handed off.
 */
export async function runXlsxChildMain(
  argv: string[],
  channel?: { postMessage(message: unknown): void },
): Promise<number> {
  if (argv.length === 0) {
    await emit({ ok: false, error: `${XLSX_WORKER_ERROR_PREFIX}no workbook path in argv` }, channel);
    return 1;
  }
  // Argv roles (issue #319 frozen contract): the workbook path is the LAST
  // element in the plain form, and the SECOND-TO-LAST when a trailing numeric
  // zip cap rides along ([path, cap]).
  const last = argv[argv.length - 1] as string;
  const capForm = argv.length >= 2 && /^\d+$/.test(last);
  const filePath = capForm ? (argv[argv.length - 2] as string) : last;
  const maxZipBytes = capForm ? Number(last) : undefined;
  try {
    if (maxZipBytes !== undefined) {
      await assertZipWithinCapInChild(fs.readFileSync(filePath), maxZipBytes);
    }
    const text = await parseWorkbookToCsv(filePath);
    await emit({ ok: true, text }, channel);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prefixed = message.startsWith(XLSX_WORKER_ERROR_PREFIX) ? message : `${XLSX_WORKER_ERROR_PREFIX}${message}`;
    await emit({ ok: false, error: prefixed }, channel);
    return 1;
  }
}

/**
 * Self-run ONLY as the process entry (importing this module from a spec must
 * be side-effect-free). Two entry shapes: an Electron utility process
 * (process.parentPort is present only there) or a forked node child (argv[1]
 * is this script; both sides resolved through real paths so a junctioned or
 * differently-cased checkout still matches) — the gpu-probe-child rule.
 */
function isProcessEntry(): boolean {
  if (parentPort() !== null) return true;
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  } catch {
    return false;
  }
}

/**
 * The argv handed to this child by the parent, minus this script's own entry:
 * a forked node child sees [execPath, thisScript, ...args]; an Electron
 * utility process may or may not carry the module path in argv. Mirrors
 * gpu-probe-child's childArgs.
 */
function childArgs(): string[] {
  let self: string;
  try {
    self = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return process.argv.slice(1);
  }
  const idx = process.argv.findIndex((arg, i) => {
    if (i === 0) return false;
    try {
      return path.resolve(arg).toLowerCase() === self;
    } catch {
      return false;
    }
  });
  return idx >= 0 ? process.argv.slice(idx + 1) : process.argv.slice(1);
}

if (isProcessEntry()) {
  // Exit explicitly once the report is handed off: an Electron utility
  // process's parentPort keeps the event loop alive (unlike a node fork's
  // unref'd IPC channel), and the parent settles ON EXIT — without this the
  // utilityProcess child would idle until the parent's deadline (caught by
  // the real-Electron harness leg). gpu-probe-child exits the same way.
  void runXlsxChildMain(childArgs())
    .then((code) => process.exit(code))
    .catch(async (err: unknown) => {
      await emit(
        { ok: false, error: `${XLSX_WORKER_ERROR_PREFIX}child crashed: ${err instanceof Error ? err.message : String(err)}` },
      );
      process.exit(1);
    });
}
