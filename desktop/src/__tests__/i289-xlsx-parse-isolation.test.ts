// i289-xlsx-parse-isolation.test.ts — FROZEN ACCEPTANCE SPEC (issue #319,
// trace 319-dependency-gate-follow-through, AC1 / check C1, revision 3 —
// re-frozen at base a33b00a8 after plan-critic round 2).
// The issue's exact file name; it supersedes xlsx-worker.isolation.test.ts.
//
// Revision 3 adds: T1 widened to every .ts/.tsx/.js/.mjs/.cjs/.mts/.cts file
// under desktop/main/ and to the require('xlsx') load forms; cap provenance
// (T7/T10: every cap / oversize / report-derived rejection carries the
// `xlsx worker:` prefix, which an in-parent cap cannot produce); T12 (the
// REAL NodeBackendHost.stop() reaps a live xlsx child and rejects its
// extraction); the kill-count leg (deadline -> kill(), then a second kill()
// after the 2 s grace). The real-Electron utilityProcess leg lives in
// desktop/scripts/xlsx-electron-harness.mjs, driven by check-c1.sh.
//
// Authored by the issue-tracer ARM'S-LENGTH CHECK AUTHOR before the fix. It
// pins the isolation of the untrusted-workbook parse: the desktop xlsx
// extractor must stop running `XLSX.read` inside the Electron main process and
// hand the parse to a child process (the PR #289 launcher pattern), so a
// poisoned workbook can crash or hang only the child, never the privileged
// process that holds the store, the launch token and the filesystem.
//
// RED AT BASE (a33b00a8; first frozen at 182b3ed3): this file statically imports
// desktop/main/backend/ingest/xlsx-worker.js and xlsx-worker-child.js, which
// do not exist until the fix lands — the whole file fails to load with an
// import-resolution error, which IS the acceptance evidence for the missing
// isolation surface. The legs that read only source files (T1, T10) and the
// legs pinned to the fixtures also fail at base on their own content pins.
//
// FROZEN PRODUCTION CONTRACT
//
// Parent-side runner — desktop/main/backend/ingest/xlsx-worker.ts:
//
//   export interface XlsxWorkerChild {
//     on(event: 'message', cb: (message: unknown) => void): unknown;
//     on(event: 'exit', cb: (code: number | null) => void): unknown;
//     on(event: 'error', cb: (err: Error) => void): unknown;
//     kill(): unknown;
//   }
//   export type XlsxWorkerForkFn = (modulePath: string, args: string[]) => XlsxWorkerChild;
//
//   // Registers a launcher override (the Electron main wiring registers its
//   // utilityProcess adapter here; tests register fakes). null clears it.
//   export function setXlsxWorkerForkFn(fn: XlsxWorkerForkFn | null): void;
//
//   // Resolution order: registered override -> (insideElectron ? null : the
//   // node child_process fork default). null means REFUSE: inside Electron
//   // with no registered launcher the runner must reject, never fall back to
//   // an in-process parse.
//   export function resolveXlsxWorkerForkFn(insideElectron: boolean): XlsxWorkerForkFn | null;
//
//   // The child entry this runner forks by default: the compiled
//   // xlsx-worker-child.js beside the module, else the .ts sibling.
//   export function xlsxWorkerChildPath(): string;
//
//   // Kills every live child this module launched and rejects their
//   // in-flight extractions. HOST STOP WIRING: NodeBackendHost.stop()
//   // (desktop/main/backend/index.ts, beside the gpu-probe child
//   // termination) calls this, so no parse child outlives the host (T12).
//   export function terminateXlsxWorkers(): void;
//
//   ERROR PROVENANCE: the child reports its own failures (including the
//   zip-cap check, which runs INSIDE the child) as
//   { ok:false, error:'xlsx worker: ...' }, and the parent prefixes every
//   report-derived rejection (an {ok:false} report, a malformed or oversize
//   report) with `xlsx worker:`. A cap rejection therefore starts with
//   `xlsx worker:`; an in-parent cap cannot produce that prefix.
//
//   ESCALATION: at the deadline the runner calls kill() once, and calls it a
//   second time 2 s later if the child still has not exited (the node fork
//   launcher maps kill #1 to SIGTERM and later kills to SIGKILL; the Electron
//   utilityProcess adapter's kill() is already forceful).
//
//   The runner resolves the launcher PER CALL, invokes it as
//   launcher(childPath, [path.resolve(filePath), ...optionalCap]) — args[0]
//   is the ABSOLUTE workbook path, and String(maxZipBytes) is appended when
//   a cap is given — and registers its message/exit/error listeners
//   synchronously on the returned child. childPath defaults to
//   xlsxWorkerChildPath().
//
//   The runner records the report and settles ON EXIT, never on the message:
//   exit 0 with a valid {ok:true,text:string} resolves {text}; it rejects a
//   normal catchable Error when the report is {ok:false,error}, missing,
//   malformed or oversize, when the child errors or the launch throws, when
//   the child exits non-zero without a report, and when the deadline passes
//   (the message says "timed out", and the child is killed immediately and
//   again after 2 s). A clean exit with no report rejects after a 500 ms
//   grace. Settlement always runs kill() when the child has not exited, so a
//   child that reported but never exited is reaped. Default timeoutMs is
//   120_000.
//
// Routing — desktop/main/backend/ingest/extractors.ts keeps the public entry:
//
//   export async function extractDocumentFromFile(
//     filePath: string,
//     opts?: { maxZipBytes?: number; timeoutMs?: number; childPath?: string },
//   ): Promise<ExtractionResultNode>;
//
//   `.xlsx` is delegated to the runner with maxZipBytes, timeoutMs and
//   childPath forwarded; the parent-side zip-cap (assertZipWithinCap, JSZip)
//   now covers only '.docx' and '.pptx' — for '.xlsx' the cap is enforced
//   INSIDE the child. extractors.ts itself no longer imports `xlsx` nor calls
//   `XLSX.read`.
//
// Child entry — desktop/main/backend/ingest/xlsx-worker-child.ts:
//
//   export async function parseWorkbookToCsv(filePath: string): Promise<string>;
//     // lazy import('xlsx'); XLSX.read + per-sheet sheet_to_csv (non-empty
//     // sheets trimmed, joined by a blank line) — the logic moved, not vanished
//   export async function runXlsxChildMain(
//     argv: string[],
//     channel?: { postMessage(message: unknown): void },
//   ): Promise<number>;
//     // workbook path = argv[argv.length - 1]; when the last two elements are
//     // [path, cap] the path is second-to-last (role-based); reports through
//     // `channel` (falling back to process.parentPort / process.send).
//
// FROZEN MESSAGE PROTOCOL (child -> parent, exactly one report):
//   { ok: true, text: string }  |  { ok: false, error: string }
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { app, utilityProcess, FakeUtilityProcess, __resetElectronStub } from 'electron';
import { extractDocumentFromFile } from '../../main/backend/ingest/extractors.js';
import { NodeBackendHost } from '../../main/backend/index.js';
import { StubEngine } from '../../main/backend/engine.js';
import { bootstrap } from '../../main/index';
import { __resetTransportSecurityForTests } from '../../main/security/index';
import {
  resolveXlsxWorkerForkFn,
  setXlsxWorkerForkFn,
  terminateXlsxWorkers,
  xlsxWorkerChildPath,
  type XlsxWorkerChild,
} from '../../main/backend/ingest/xlsx-worker.js';
import { parseWorkbookToCsv, runXlsxChildMain } from '../../main/backend/ingest/xlsx-worker-child.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAIN_DIR = path.resolve(THIS_DIR, '../../main');
const EXTRACTORS_SOURCE = path.resolve(THIS_DIR, '../../main/backend/ingest/extractors.ts');
const CHILD_SOURCE = path.resolve(THIS_DIR, '../../main/backend/ingest/xlsx-worker-child.ts');
const PARITY_DIR = path.resolve(THIS_DIR, '../../../contracts/fixtures/xlsx-parity');
const PARITY_XLSX = path.join(PARITY_DIR, 'parity.xlsx');
const PARITY_GOLDEN = path.join(PARITY_DIR, 'parity.expected.txt');
const CHILD_RELATIVE = 'backend/ingest/xlsx-worker-child.ts';
const TEN_MB = 10 * 1024 * 1024;

/** Temp dirs created by the current test; removed in afterEach. */
const tempDirs: string[] = [];

afterEach(() => {
  setXlsxWorkerForkFn(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-worker-'));
  tempDirs.push(dir);
  return dir;
}

/** Remove block comments and FULL-LINE // comments (never strips code). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const DYNAMIC_XLSX_IMPORT = /import\(\s*['"]xlsx['"]\s*\)/;
const STATIC_XLSX_IMPORT = /from\s+['"]xlsx['"]/;
/**
 * Every xlsx LOAD form plus the SheetJS parse surface (rev 3, critic F4): a
 * parser cannot run without loading the module. A fully computed specifier
 * (`import(someVariable)`) is a recorded residual (08a), not matchable here.
 */
const XLSX_PARSE_PATTERN =
  /XLSX\.read|XLSX\[|from\s+['"]xlsx['"]|import\(\s*['"]xlsx['"]\s*\)|require\(\s*['"]xlsx['"]\s*\)/;
/** Every source extension the main-process tree can carry. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'];
/** The report-derived / child-reported rejection prefix (rev 3 cap provenance). */
const WORKER_PREFIX = /^xlsx worker:/;

/** Every source file (SOURCE_EXTENSIONS) under a directory, recursively. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/** A real two-sheet workbook written with the vendored SheetJS package. */
function writeRealWorkbook(dir: string, name = 'good.xlsx'): string {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['A', 'B'], [1, 2]]), 'First');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['X', 'Y'], ['three', 'four']]), 'Second');
  const file = path.join(dir, name);
  fs.writeFileSync(file, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer);
  return file;
}

interface FakeChild {
  listeners: Record<string, Array<(value: unknown) => void>>;
  delivered: unknown[];
  killCalls: number;
  on(event: string, cb: (value: unknown) => void): FakeChild;
  kill(): boolean;
  emit(event: string, value: unknown): void;
}

function makeFakeChild(): FakeChild {
  const child: FakeChild = {
    listeners: {},
    delivered: [],
    killCalls: 0,
    on(event, cb) {
      (child.listeners[event] ??= []).push(cb);
      return child;
    },
    kill() {
      child.killCalls += 1;
      return true;
    },
    emit(event, value) {
      if (event === 'message') child.delivered.push(value);
      for (const cb of child.listeners[event] ?? []) cb(value);
    },
  };
  return child;
}

/** Bound a promise so a broken runner fails the test instead of hanging it. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`spec guard: no settle within ${ms}ms`)), ms);
    }),
  ]);
}

/** Poll until fn returns truthy (the gpu-probe spec's waitFor pattern). */
async function waitFor<T>(fn: () => T | undefined | null | false, description: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== null && value !== false) return value as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Spec-owned fixture child for the REAL fork leg (T4). CommonJS so node forks
 * it directly; it requires the vendored SheetJS by absolute path (the temp dir
 * has no node_modules). Bytes starting with the zip magic PK\x03\x04 crash it
 * with exit 2 and NO report; anything else is parsed with XLSX.read and
 * reported over node IPC.
 */
function writeFixtureChild(dir: string): string {
  const xlsxCjs = createRequire(import.meta.url).resolve('xlsx');
  const source = [
    "'use strict';",
    "const fs = require('node:fs');",
    `const XLSX = require(${JSON.stringify(xlsxCjs)});`,
    'const file = process.argv[process.argv.length - 1];',
    'const buf = fs.readFileSync(file);',
    'if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {',
    '  process.exit(2);',
    '}',
    "const workbook = XLSX.read(buf, { type: 'buffer' });",
    'const parts = [];',
    'for (const name of workbook.SheetNames) {',
    '  const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);',
    '  if (csv.trim().length > 0) parts.push(csv.trim());',
    '}',
    "process.send({ ok: true, text: parts.join('\\n\\n') }, () => process.exit(0));",
    '',
  ].join('\n');
  const file = path.join(dir, 'fixture-xlsx-child.cjs');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

/**
 * Spec-owned CommonJS child that NEVER exits and NEVER reports (T9e): a bare
 * setInterval keeps the event loop alive forever.
 */
function writeNeverExitingChild(dir: string): string {
  const source = ["'use strict';", 'setInterval(() => {}, 1000);', ''].join('\n');
  const file = path.join(dir, 'fixture-hung-child.cjs');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

describe('#319 AC1: the xlsx parse runs in an isolated child, not the main process', () => {
  it('T1: no xlsx load or parse remains in any source file under desktop/main except the child', () => {
    const files = listTsFiles(MAIN_DIR);
    // Anti-vacuity: the scan really covered the main-process tree.
    expect(files.length).toBeGreaterThan(5);
    const relatives = files.map((file) => path.relative(MAIN_DIR, file).split(path.sep).join('/'));
    expect(relatives).toContain('backend/ingest/extractors.ts');

    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(MAIN_DIR, file).split(path.sep).join('/');
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      if (XLSX_PARSE_PATTERN.test(source)) violations.push(rel);
    }
    expect(violations, 'only the child module may touch the SheetJS parse surface').toEqual([CHILD_RELATIVE]);

    // Anti-vacuity: the pin cannot go green by deleting the xlsx route.
    const extractors = stripComments(fs.readFileSync(EXTRACTORS_SOURCE, 'utf8'));
    expect(extractors).toContain('extractDocumentFromFile');
    expect(extractors).toContain("'.xlsx'");

    // The parse moved into the child module, it did not vanish.
    const child = stripComments(fs.readFileSync(CHILD_SOURCE, 'utf8'));
    expect(child).toMatch(DYNAMIC_XLSX_IMPORT);
    expect(child).toContain('XLSX.read');
  });

  it('T2: xlsx route launches an isolated child with the workbook path', async () => {
    const dir = makeTempDir();
    const good = writeRealWorkbook(dir);
    const fakeChild = makeFakeChild();
    const calls: Array<{ modulePath: string; args: string[] }> = [];
    const fake = (modulePath: string, args: string[]): FakeChild => {
      calls.push({ modulePath, args });
      return fakeChild;
    };
    setXlsxWorkerForkFn(fake);

    const pending = extractDocumentFromFile(good, { maxZipBytes: TEN_MB });
    // Report asynchronously, as real IPC would, once the runner has subscribed.
    const report = setInterval(() => {
      if ((fakeChild.listeners.message ?? []).length === 0) return;
      clearInterval(report);
      fakeChild.emit('message', { ok: true, text: 'A,B\n1,2\n' });
      fakeChild.emit('exit', 0);
    }, 10);
    let result: Awaited<typeof pending>;
    try {
      result = await within(pending, 5000);
    } finally {
      clearInterval(report);
    }

    // The fake launcher (not node's real fork) carried the call.
    expect(calls).toHaveLength(1);
    expect(typeof calls[0]?.modulePath).toBe('string');
    expect(calls[0]?.modulePath.length).toBeGreaterThan(0);
    expect(calls[0]?.args[0]).toBe(path.resolve(good));
    // Exactly one report was delivered and consumed; the text is the child's.
    expect(fakeChild.listeners.message).toHaveLength(1);
    expect(fakeChild.delivered).toHaveLength(1);
    expect(result.text).toBe('A,B\n1,2\n');

    // Seam reset: outside Electron the node fork default returns; inside
    // Electron with no registered launcher the runner refuses (null).
    setXlsxWorkerForkFn(null);
    const outside = resolveXlsxWorkerForkFn(false);
    expect(typeof outside).toBe('function');
    expect(outside).not.toBe(fake);
    expect(resolveXlsxWorkerForkFn(true)).toBeNull();
  });

  it('T3: child entry parses a real workbook to CSV', async () => {
    const dir = makeTempDir();
    const workbookPath = writeRealWorkbook(dir);

    const text = await parseWorkbookToCsv(workbookPath);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain('A,B');
    expect(text).toContain('1,2');
    expect(text).toContain('X,Y');
    expect(text).toContain('three,four');

    const posted: unknown[] = [];
    const channel = { postMessage: (message: unknown): void => void posted.push(message) };
    const code = await runXlsxChildMain(['node', 'xlsx-worker-child', workbookPath], channel);
    expect(code).toBe(0);
    expect(posted).toHaveLength(1);
    const message = posted[0] as { ok?: unknown; text?: unknown };
    expect(message.ok).toBe(true);
    expect(message.text).toBe(text);
  });

  it('T4: poisoned workbook is contained — parent gets an isolated failure and stays healthy', async () => {
    const dir = makeTempDir();
    const childPath = writeFixtureChild(dir);
    const poisoned = path.join(dir, 'poisoned.xlsx');
    fs.writeFileSync(poisoned, Buffer.from('PK\x03\x04 garbage not a zip', 'latin1'));
    // CSV bytes under an .xlsx name: routed by extension, parsed by SheetJS's
    // format sniffing inside the fixture child (no zip magic, so no crash).
    const healthy = path.join(dir, 'healthy.xlsx');
    fs.writeFileSync(healthy, 'A,B\n1,2\n', 'utf8');

    // The REAL node fork launcher, end to end (fork + IPC + exit mapping).
    const realFork = resolveXlsxWorkerForkFn(false);
    expect(typeof realFork).toBe('function');

    let failure: unknown;
    try {
      await within(extractDocumentFromFile(poisoned, { childPath, timeoutMs: 15_000 }), 20_000);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/spec guard/);
    expect(message).toMatch(/exit/i);
    expect(message).toContain('2');

    // The parent survived the child crash: the same launcher serves the next file.
    const next = await within(extractDocumentFromFile(healthy, { childPath, timeoutMs: 15_000 }), 20_000);
    expect(typeof next.text).toBe('string');
    expect(next.text).toContain('A,B');
  });

  it('T5: hung (fake) child is killed at the deadline', async () => {
    const dir = makeTempDir();
    const hungInput = path.join(dir, 'hung.xlsx');
    fs.writeFileSync(hungInput, Buffer.from('PK\x03\x04 never parsed', 'latin1'));
    const fakeChild = makeFakeChild(); // never reports, never exits
    setXlsxWorkerForkFn(() => fakeChild);

    const startedAt = Date.now();
    let failure: unknown;
    try {
      await within(extractDocumentFromFile(hungInput, { timeoutMs: 200 }), 10_000);
    } catch (err) {
      failure = err;
    }
    const elapsedMs = Date.now() - startedAt;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(/timeout|timed out|deadline/i);
    expect(elapsedMs).toBeLessThan(5000);
    expect(fakeChild.killCalls).toBeGreaterThanOrEqual(1);
  });

  it('T10: the parent runs no zip-cap for .xlsx — the cap moved into the child', () => {
    // AMENDED for issue #320 (supersession recorded on #320 before this edit:
    // https://github.com/ZaxbyHub/trainingapp/issues/320#issuecomment-6760640631).
    // The pre-#320 anti-vacuity pins (a parent ZIP_EXTENSIONS set still covering
    // '.docx'/'.pptx', an assertZipWithinCap mention) are superseded: after
    // #320 the parent caps NO format — the .docx/.pptx cap moved into the doc
    // child exactly as the .xlsx cap moved into the xlsx child. The #319
    // property (the parent never caps .xlsx) holds a fortiori.
    const source = stripComments(fs.readFileSync(EXTRACTORS_SOURCE, 'utf8'));
    expect(source, 'no JSZip in the parent').not.toMatch(/JSZip|jszip/);
    expect(source, 'no central-directory read in the parent').not.toContain('loadAsync');
    expect(source, 'no declared-size summing in the parent').not.toContain('uncompressedSize');
    expect(source, 'no parent-side ZIP_EXTENSIONS cap set').not.toMatch(/ZIP_EXTENSIONS/);
    expect(source, 'no parent-side assertZipWithinCap').not.toMatch(/assertZipWithinCap/);
    // The .xlsx route still exists and still leaves through the public entry.
    expect(source).toContain("'.xlsx'");
    expect(source).toContain('extractDocumentFromFile');
    // Behavioral half: T7's maxZipBytes legs and T10b exercise the cap IN THE CHILD.
  });

  it('T10b: cap provenance — the child reports the cap as `xlsx worker:`; the parent prefixes report-derived rejections', async () => {
    // (1) The child itself enforces the cap and reports it, role-based argv
    //     [path, cap] (the parity workbook is far above a 1000-byte cap).
    const posted: unknown[] = [];
    const channel = { postMessage: (message: unknown): void => void posted.push(message) };
    const code = await runXlsxChildMain(['node', 'xlsx-worker-child', PARITY_XLSX, '1000'], channel);
    expect(code).not.toBe(0);
    expect(posted).toHaveLength(1);
    const report = posted[0] as { ok?: unknown; error?: unknown };
    expect(report.ok).toBe(false);
    expect(typeof report.error).toBe('string');
    expect(report.error as string).toMatch(WORKER_PREFIX);
    expect(report.error as string).toMatch(/cap/i);

    // (2) The parent prefixes an {ok:false} report-derived rejection.
    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    const failing = makeFakeChild();
    setXlsxWorkerForkFn(() => failing);
    const script = setInterval(() => {
      if ((failing.listeners.exit ?? []).length === 0) return;
      clearInterval(script);
      failing.emit('message', { ok: false, error: 'zip content declares 999999999 bytes, above the cap' });
      failing.emit('exit', 1);
    }, 10);
    let failure: unknown;
    try {
      await within(extractDocumentFromFile(workbook, { timeoutMs: 5_000 }), 10_000);
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(script);
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(WORKER_PREFIX);
    expect((failure as Error).message).toContain('above the cap');

    // (3) An oversize report (> 16 MiB serialized) is report-derived too: it
    //     rejects with the prefix and the child is killed.
    const oversize = makeFakeChild();
    setXlsxWorkerForkFn(() => oversize);
    const big = setInterval(() => {
      if ((oversize.listeners.message ?? []).length === 0) return;
      clearInterval(big);
      oversize.emit('message', { ok: true, text: 'x'.repeat(17 * 1024 * 1024) });
    }, 10);
    let oversizeFailure: unknown;
    try {
      await within(extractDocumentFromFile(workbook, { timeoutMs: 5_000 }), 10_000);
    } catch (err) {
      oversizeFailure = err;
    } finally {
      clearInterval(big);
    }
    expect(oversizeFailure).toBeInstanceOf(Error);
    expect((oversizeFailure as Error).message).not.toMatch(/spec guard/);
    expect((oversizeFailure as Error).message).toMatch(WORKER_PREFIX);
    expect((oversizeFailure as Error).message, 'oversize must be detected, not timed out').not.toMatch(/timed out/i);
    expect(oversize.killCalls, 'an oversize report kills the child').toBeGreaterThanOrEqual(1);
  });
});

describe('#319 AC1 T6: bootstrap registers the utilityProcess launcher for the xlsx worker', () => {
  const forkMock = utilityProcess.fork as unknown as ReturnType<typeof vi.fn>;
  const hermeticUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-utility-userdata-'));

  /** A utility child that posts `report` (when given) then exits `code`. */
  function scriptedFork(report: Record<string, unknown> | undefined, code = 0) {
    return (modulePath: string, args?: string[], options?: Record<string, unknown>) => {
      const child = new FakeUtilityProcess(modulePath, args ?? [], options);
      setImmediate(() => {
        if (report !== undefined) child.emit('message', report);
        child.emit('exit', code);
      });
      return child;
    };
  }

  beforeEach(() => {
    __resetElectronStub();
    app.getPath.mockImplementation((name: string) => (name === 'userData' ? hermeticUserData : process.cwd()));
    __resetTransportSecurityForTests();
    setXlsxWorkerForkFn(null);
  });

  afterEach(async () => {
    app.emit('will-quit');
    await new Promise((resolve) => setTimeout(resolve, 50));
    setXlsxWorkerForkFn(null);
  });

  afterAll(() => {
    fs.rmSync(hermeticUserData, { recursive: true, force: true });
  });

  it('an .xlsx extraction with NO explicit launcher forks the real child through electron utilityProcess and adopts its report', async () => {
    expect(resolveXlsxWorkerForkFn(true), 'nothing registered before bootstrap').toBeNull();
    bootstrap();
    await waitFor(() => resolveXlsxWorkerForkFn(true) !== null, 'launcher registration');

    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    forkMock.mockImplementation(scriptedFork({ ok: true, text: 'X' }));
    forkMock.mockClear();

    const result = await within(extractDocumentFromFile(workbook), 10_000);
    expect(result.text).toBe('X');

    expect(forkMock).toHaveBeenCalledTimes(1);
    const [modulePath, args, options] = forkMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(modulePath).toBe(xlsxWorkerChildPath());
    expect(args[0]).toBe(path.resolve(workbook));
    // The report rides the message channel: stdout discarded, stderr piped.
    expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    // No environment override at all — in particular no ELECTRON_RUN_AS_NODE.
    expect(options).not.toHaveProperty('env');
    expect(JSON.stringify(options)).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('T6 failure (stub contract): a utilityProcess child that exits non-zero with NO report rejects naming the exit code', async () => {
    bootstrap();
    await waitFor(() => resolveXlsxWorkerForkFn(true) !== null, 'launcher registration');

    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    // Scripted fake: no report at all, then exit 3 (the crashed-child shape).
    forkMock.mockImplementation(scriptedFork(undefined, 3));
    forkMock.mockClear();

    let failure: unknown;
    try {
      await within(extractDocumentFromFile(workbook, { timeoutMs: 10_000 }), 15_000);
    } catch (err) {
      failure = err;
    }
    expect(forkMock, 'the registered utilityProcess launcher carried the call').toHaveBeenCalledTimes(1);
    expect(failure, 'a non-zero exit without a report must reject').toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toMatch(/spec guard/);
    expect(message).not.toMatch(/timed out/i);
    expect(message).toMatch(/exit/i);
    expect(message).toMatch(/\b3\b/);
  });

  it('T6 failure (stub contract): a utilityProcess child with NO report and NO exit hits the deadline and is killed', async () => {
    bootstrap();
    await waitFor(() => resolveXlsxWorkerForkFn(true) !== null, 'launcher registration');

    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    const children: FakeUtilityProcess[] = [];
    forkMock.mockImplementation((modulePath: string, args?: string[], options?: Record<string, unknown>) => {
      // Silent forever: never posts, never exits (kill() is recorded only).
      const child = new FakeUtilityProcess(modulePath, args ?? [], options);
      children.push(child);
      return child;
    });
    forkMock.mockClear();

    const startedAt = Date.now();
    let failure: unknown;
    try {
      await within(extractDocumentFromFile(workbook, { timeoutMs: 300 }), 10_000);
    } catch (err) {
      failure = err;
    }
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(failure, 'a silent child must reject at the deadline').toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(/timeout|timed out|deadline/i);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(children).toHaveLength(1);
    expect(children[0]?.kill, 'the silent utilityProcess child must be killed').toHaveBeenCalled();
  });
});

describe('#319 AC1 T7/T8: the real production child and the committed parity fixture', () => {
  it('T7: the node fork + default childPath parses the parity workbook (path with a space) byte-identically; the cap is enforced in the child', async () => {
    setXlsxWorkerForkFn(null);
    const realFork = resolveXlsxWorkerForkFn(false);
    expect(typeof realFork).toBe('function');

    // The temp dir NAME contains a space: argv is an array, no shell quoting.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx parity '));
    tempDirs.push(dir);
    const workbook = path.join(dir, 'parity copy.xlsx');
    fs.copyFileSync(PARITY_XLSX, workbook);
    const golden = fs.readFileSync(PARITY_GOLDEN, 'utf8');

    const result = await within(extractDocumentFromFile(workbook, { timeoutMs: 60_000 }), 90_000);
    expect(result.text).toBe(golden);

    const capped = await within(
      extractDocumentFromFile(workbook, { maxZipBytes: TEN_MB, timeoutMs: 60_000 }),
      90_000,
    );
    expect(capped.text).toBe(golden);

    let failure: unknown;
    try {
      await within(extractDocumentFromFile(workbook, { maxZipBytes: 1000, timeoutMs: 60_000 }), 90_000);
    } catch (err) {
      failure = err;
    }
    expect(failure, 'a cap below the workbook size must reject').toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(/cap/i);
    // Cap provenance (rev 3): the rejection derives from the CHILD's report.
    expect((failure as Error).message, 'the cap rejection must come from the child report').toMatch(WORKER_PREFIX);
  });

  it('T8: parseWorkbookToCsv over the committed parity workbook equals the golden byte for byte', async () => {
    const golden = fs.readFileSync(PARITY_GOLDEN, 'utf8');
    await expect(parseWorkbookToCsv(PARITY_XLSX)).resolves.toBe(golden);
  });
});

describe('#319 AC1 T9/T11: runner lifecycle and host-stop ownership', () => {
  it('T9a: a report that never exits does NOT settle — the deadline kills the child', async () => {
    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    const fakeChild = makeFakeChild();
    setXlsxWorkerForkFn(() => fakeChild);
    const report = setInterval(() => {
      if ((fakeChild.listeners.message ?? []).length === 0) return;
      clearInterval(report);
      fakeChild.emit('message', { ok: true, text: 'never settled' });
      // ...and never exits.
    }, 10);

    let failure: unknown;
    try {
      await within(extractDocumentFromFile(workbook, { timeoutMs: 300 }), 10_000);
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(report);
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(/timeout|timed out|deadline/i);
    expect(fakeChild.killCalls, 'a reported-but-unexited child must be reaped').toBeGreaterThanOrEqual(1);
  });

  it('T9a2: a report followed by exit 0 resolves with the child text (settle on exit)', async () => {
    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    const fakeChild = makeFakeChild();
    setXlsxWorkerForkFn(() => fakeChild);
    const script = setInterval(() => {
      if ((fakeChild.listeners.exit ?? []).length === 0) return;
      clearInterval(script);
      fakeChild.emit('message', { ok: true, text: 'settled on exit' });
      fakeChild.emit('exit', 0);
    }, 10);
    try {
      const result = await within(extractDocumentFromFile(workbook, { timeoutMs: 5_000 }), 10_000);
      expect(result.text).toBe('settled on exit');
    } finally {
      clearInterval(script);
    }
  });

  it('T9b: exit 0 with NO report rejects within the grace (≤ 2 s)', async () => {
    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    const fakeChild = makeFakeChild();
    setXlsxWorkerForkFn(() => fakeChild);
    const script = setInterval(() => {
      if ((fakeChild.listeners.exit ?? []).length === 0) return;
      clearInterval(script);
      fakeChild.emit('exit', 0);
    }, 10);

    const startedAt = Date.now();
    let failure: unknown;
    try {
      await within(extractDocumentFromFile(workbook, { timeoutMs: 30_000 }), 10_000);
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(script);
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(2_000);
  });

  it('T9c: malformed reports reject — {ok:true} without text, and a non-object message', async () => {
    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);

    for (const bad of [{ ok: true }, 'not-an-object'] as unknown[]) {
      const fakeChild = makeFakeChild();
      setXlsxWorkerForkFn(() => fakeChild);
      const script = setInterval(() => {
        if ((fakeChild.listeners.exit ?? []).length === 0) return;
        clearInterval(script);
        fakeChild.emit('message', bad);
        fakeChild.emit('exit', 0);
      }, 10);
      let failure: unknown;
      try {
        await within(extractDocumentFromFile(workbook, { timeoutMs: 5_000 }), 10_000);
      } catch (err) {
        failure = err;
      } finally {
        clearInterval(script);
      }
      expect(failure, `malformed report ${JSON.stringify(bad)} must reject`).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toMatch(/spec guard/);
    }
  });

  it('T9d: a launcher that throws rejects with the launch error', async () => {
    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    setXlsxWorkerForkFn(() => {
      throw new Error('xlsx worker failed to launch (spec)');
    });
    await expect(within(extractDocumentFromFile(workbook), 5_000)).rejects.toThrow(
      /failed to launch \(spec\)/,
    );
  });

  it('T9e: a REAL hung child is killed at the deadline, its OS process is gone, and the next file parses', async () => {
    const dir = makeTempDir();
    const hungFixture = writeNeverExitingChild(dir);
    const input = path.join(dir, 'never parsed.xlsx');
    fs.writeFileSync(input, Buffer.from('PK\x03\x04 garbage', 'latin1'));

    // A wrapping launcher around node's real fork: records the ChildProcess
    // (for its pid) while kill() still reaches the real OS process.
    const recorded: Array<{ pid?: number }> = [];
    const wrappingLauncher = (modulePath: string, args: string[]): XlsxWorkerChild => {
      const cp = fork(modulePath, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      recorded.push(cp);
      const onAny = (event: string, cb: (value: unknown) => void): unknown => {
        (cp as unknown as { on(e: string, l: (...a: unknown[]) => void): unknown }).on(event, cb as never);
        return cp;
      };
      return {
        on: onAny as unknown as XlsxWorkerChild['on'],
        kill: (): unknown => cp.kill(),
      };
    };
    setXlsxWorkerForkFn(wrappingLauncher);

    let failure: unknown;
    try {
      await within(extractDocumentFromFile(input, { childPath: hungFixture, timeoutMs: 500 }), 15_000);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(/timeout|timed out|deadline/i);

    const pid = recorded[0]?.pid;
    expect(typeof pid).toBe('number');
    // process.kill(pid, 0) throws once the OS process is gone.
    const gone = await waitFor(() => {
      try {
        process.kill(pid as number, 0);
        return undefined;
      } catch {
        return true;
      }
    }, 'hung child OS process to disappear', 5_000);
    expect(gone).toBe(true);

    // The parent survived: a healthy extraction through the SAME launcher.
    const healthy = path.join(dir, 'healthy parity.xlsx');
    fs.copyFileSync(PARITY_XLSX, healthy);
    const result = await within(extractDocumentFromFile(healthy, { timeoutMs: 60_000 }), 90_000);
    expect(result.text).toBe(fs.readFileSync(PARITY_GOLDEN, 'utf8'));
  });

  it('T11: terminateXlsxWorkers kills every live child and rejects the in-flight extraction', async () => {
    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    const fakeChild = makeFakeChild(); // never reports, never exits
    let launched = 0;
    setXlsxWorkerForkFn(() => {
      launched += 1;
      return fakeChild;
    });

    const pending = extractDocumentFromFile(workbook, { timeoutMs: 120_000 });
    await waitFor(() => launched === 1, 'child launch');
    terminateXlsxWorkers();

    let failure: unknown;
    try {
      await within(pending, 5_000);
    } catch (err) {
      failure = err;
    }
    expect(failure, 'the in-flight extraction must reject after termination').toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect(fakeChild.killCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('#319 AC1 T12 + escalation: the REAL host stop() owns the xlsx children; the deadline kills twice', () => {
  let host: NodeBackendHost | null = null;

  afterEach(async () => {
    // Belt and braces: never leak a fake in-flight extraction past the leg.
    terminateXlsxWorkers();
    if (host !== null) {
      await host.stop().catch(() => {});
      host = null;
    }
  });

  it('T12: NodeBackendHost.stop() kills the live xlsx child and rejects the pending extraction', async () => {
    // The i199/i230 host-lifecycle harness: a REAL NodeBackendHost on an
    // explicit StubEngine, started for real, then stopped through its own
    // stop() — never terminateXlsxWorkers() directly.
    host = new NodeBackendHost({
      token: 'i319-xlsx-host-stop-token',
      engine: new StubEngine(),
    });
    await host.start();

    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    const fakeChild = makeFakeChild(); // never reports, never exits
    let launched = 0;
    setXlsxWorkerForkFn(() => {
      launched += 1;
      return fakeChild;
    });

    const pending = extractDocumentFromFile(workbook, { timeoutMs: 120_000 });
    // Observe settlement without an unhandled rejection window.
    let failure: unknown;
    let settled = false;
    const observed = pending.then(
      () => {
        settled = true;
      },
      (err: unknown) => {
        failure = err;
        settled = true;
      },
    );
    await waitFor(() => launched === 1, 'xlsx child launch');
    expect(fakeChild.killCalls, 'harness sanity: nothing killed the child before stop()').toBe(0);

    const stopping = host;
    host = null;
    await stopping.stop();

    await within(observed, 5_000).catch(() => {});
    expect(settled, 'host stop() must settle the in-flight extraction (stop() wiring)').toBe(true);
    expect(failure, 'the in-flight extraction must REJECT after host stop').toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect(fakeChild.killCalls, 'host stop() must kill the live xlsx child').toBeGreaterThanOrEqual(1);
  });

  it('escalation: at the deadline the runner calls kill() once, then exactly once more after the 2 s grace', async () => {
    const dir = makeTempDir();
    const workbook = writeRealWorkbook(dir);
    const killTimes: number[] = [];
    const fakeChild = makeFakeChild(); // never reports, never exits, ignores kill
    const baseKill = fakeChild.kill.bind(fakeChild);
    fakeChild.kill = (): boolean => {
      killTimes.push(Date.now());
      return baseKill();
    };
    setXlsxWorkerForkFn(() => fakeChild);

    const startedAt = Date.now();
    let failure: unknown;
    try {
      await within(extractDocumentFromFile(workbook, { timeoutMs: 200 }), 10_000);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/spec guard/);
    expect((failure as Error).message).toMatch(/timed out/i);
    // First kill: at the deadline, before (or as) the rejection lands.
    expect(fakeChild.killCalls, 'exactly one kill at the deadline').toBe(1);
    expect((killTimes[0] ?? 0) - startedAt).toBeGreaterThanOrEqual(150);

    // Second kill: after the 2 s grace, because the child never exited.
    await waitFor(() => fakeChild.killCalls >= 2, 'the escalation kill after the grace', 5_000);
    expect((killTimes[1] ?? 0) - (killTimes[0] ?? 0), 'the second kill waits out the 2 s grace').toBeGreaterThanOrEqual(1_900);
    // ...and no third kill: the escalation is exactly two calls.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(fakeChild.killCalls, 'exactly two kills in total').toBe(2);
  }, 20_000);
});
