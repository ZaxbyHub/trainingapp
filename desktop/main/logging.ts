// Desktop diagnostics logging (issue #248): the Electron main-process half of
// the shared logging core. Imported FIRST by main/index.ts.
//
// Two-phase initialization (05-fix-plan.md):
//   Phase 1 (import time, real Electron main only): the three-way console
//   wrapper + `process.on('uncaughtExceptionMonitor')` (observes without
//   changing default termination). Entries buffer in a bounded in-memory
//   phase-1 buffer (unlevel); console output follows the three-way policy
//   immediately.
//   Phase 2 (`activateDiagnosticsLogging`, called from bootstrap() once the
//   single-instance lock is owned AND the initial level is loaded from the
//   diagnostics sidecar): the synchronous rotated file transport activates,
//   buffered phase-1 entries are admitted per the loaded level and flushed in
//   order, the main boot entry is written, IPC is registered (before the
//   renderer loads), and the Electron capture handlers are wired. A SECOND
//   instance never reaches phase 2 — its file sink never activates, so it
//   never appends to or rotates the primary's log.
//
// Transport policy (the reconciled AC5/AC7 contract, option (a)):
//   - clean line            -> console passthrough with ORIGINAL arguments;
//   - sensitive line matching an AC7_PINNED_LINE_TEMPLATES pattern
//                           -> console passthrough RAW (the finite exception,
//                              exactly as broad as AC7's protection);
//   - any other sensitive   -> console receives the once-called `[sanitized]`
//                              single-string form;
//   - persisted transports  -> ALWAYS gated (this file sink, the IPC ingest,
//                              the export bundle), no exceptions.
// Classification failures fail closed (matrix rows a/b in the plan).
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { readGpuProbeVerdict } from './backend/inference/gpu-probe.js';
import {
  diagnosticsSettingsPathFor,
  loadDiagnosticsSettings,
  saveDiagnosticsSettings,
} from './diagnostics-settings.js';
import {
  isSensitiveLine,
  persistedForm,
  redactLine,
  renderLine,
  sanitizedConsoleForm,
} from './logging-redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ConsoleOutcome = 'raw' | 'sanitized';

/** Ring/log entry shape shared with the renderer core (web_ui logging). */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  /** The already-redacted persisted form (every persisted sink is gated). */
  message: string;
  sessionId?: string;
  seq?: number;
}

// ---------------------------------------------------------------------------
// AC7_PINNED_LINE_TEMPLATES — the FINITE console exception
// ---------------------------------------------------------------------------
/**
 * The exact line-template families the frozen logline contract sweep
 * (desktop/src/__tests__/logline-contract-sweep.test.ts, frozen check C7)
 * requires verbatim on the console: the pack-manager lines whose interpolated
 * payloads are sensitive (a full sha256 doc id; absolute managed-manifest
 * paths). A sensitive line matching one of these ANCHORED FULL-LINE patterns
 * passes through the console RAW — the preserving exception for AC7, exactly
 * as broad as AC7's protection, no wider. Any other sensitive line gets the
 * `[sanitized]` form (AC5). PERSISTED forms of these lines are still gated on
 * BOTH platforms (the exception is console-only).
 *
 * Drift pin: desktop/src/__tests__/diagnostics-console-composition.test.ts
 * structurally compares this inventory against the frozen corpus's
 * requireLine templates in BOTH directions — a change here without the
 * corpus (or vice versa) fails that spec.
 */
export const AC7_PINNED_LINE_TEMPLATES: readonly RegExp[] = [
  /^\[pack-manager\] [^:\s]+@\d+\.\d+\.\d+: managed manifest unreadable at .+; treating as no docs$/,
  /^\[pack-manager\] [^:\s]+@\d+\.\d+\.\d+: managed manifest unparseable at .+; treating as no docs$/,
  /^\[pack-manager\] [^:\s]+@\d+\.\d+\.\d+: no live chunks for doc [0-9a-f]{64}; row deactivated$/,
];

/** Template match — independent of the redactor (failure-matrix row a). */
export function matchesPinnedTemplate(line: string): boolean {
  for (const template of AC7_PINNED_LINE_TEMPLATES) {
    if (template.test(line)) return true;
  }
  return false;
}

/**
 * The three-way console outcome for a line at this desktop gate. Exported for
 * the parity/composition specs (and CONFIGURATION.md's stated policy).
 */
export function consoleOutcomeFor(line: string): ConsoleOutcome {
  if (!isSensitiveLine(line)) return 'raw';
  return matchesPinnedTemplate(line) ? 'raw' : 'sanitized';
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
const PHASE1_LIMIT = 512;
const ROTATE_BYTES = 5 * 1024 * 1024;
const SEEN_LIMIT = 1024;
const SCOPE_MAX = 128;
const MESSAGE_MAX = 8000;

let enhancedLevel = false;
let active = false;
let logsDir: string | null = null;
let mainLogPath: string | null = null;
let storePathHolder: string | null = null;
let byteCount = 0;
let transportDisabled = false;
let transportWarned = false;
let ipcRegistered = false;
let captureRegistered = false;
let wrapperInstalled = false;
let warnedFailure = false;
let droppedMalformed = 0;
const phase1: LogEntry[] = [];
const seen = new Set<string>();

type ConsoleMethod = (...args: unknown[]) => void;
// Captured AT INSTALL (not module load): a spec may attach its own spy first,
// and the wrapper's passthrough must flow through whatever console methods
// are current at install time. `console.log` and `console.info` both wrap to
// level 'info', but each restores to its OWN original method.
let originalConsole: Record<LogLevel, ConsoleMethod> | null = null;
let originalConsoleLog: ConsoleMethod | null = null;

function sinksForLevel(): Record<LogLevel, ConsoleMethod> {
  return originalConsole ?? { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
}

function nowIso(): string {
  return new Date().toISOString();
}

// The uncaughtExceptionMonitor handler, kept addressable so a re-install (or
// the test reset) removes the previous registration instead of accumulating
// listeners on `process`.
let monitorHandler: ((err: unknown) => void) | null = null;
let quitFlushHandler: (() => void) | null = null;
let rejectionHandler: ((reason: unknown) => void) | null = null;

/** One-per-session non-recursive warning; a failing warn is swallowed. */
function warnFailureOnce(detail: string): void {
  if (warnedFailure) return;
  warnedFailure = true;
  try {
    sinksForLevel().error(`[trainingapp-diagnostics] ${detail}; the entry was dropped`);
  } catch {
    /* the warn path itself failed — never recurse into the classifier */
  }
}

// ---------------------------------------------------------------------------
// File transport (synchronous, rotate-before-write)
// ---------------------------------------------------------------------------
function formatLine(entry: LogEntry): string {
  return `${entry.ts} ${entry.level} [${entry.scope}] ${entry.message}`;
}

function rotateNow(): void {
  if (logsDir === null) return;
  try {
    unlinkSync(path.join(logsDir, 'main.log.2'));
  } catch {
    /* no prior rotation */
  }
  try {
    renameSync(path.join(logsDir, 'main.log.1'), path.join(logsDir, 'main.log.2'));
  } catch {
    /* no prior rotation */
  }
  try {
    renameSync(mainLogPath as string, path.join(logsDir, 'main.log.1'));
  } catch {
    /* nothing to rotate */
  }
  byteCount = 0;
}

function appendLine(text: string): void {
  if (mainLogPath === null || transportDisabled) return;
  const data = `${text}\n`;
  try {
    const bytes = Buffer.byteLength(data, 'utf8');
    if (byteCount + bytes > ROTATE_BYTES) rotateNow();
    appendFileSync(mainLogPath, data);
    byteCount += bytes;
  } catch {
    // Transport failure disables the transport for the session + ONE warn;
    // the app continues (AC1's logging must never take the app down).
    transportDisabled = true;
    if (!transportWarned) {
      transportWarned = true;
      try {
        sinksForLevel().error('[trainingapp-diagnostics] file transport failed; file logging disabled for this session');
      } catch {
        /* console unavailable */
      }
    }
  }
}

function appendEntry(entry: LogEntry): void {
  appendLine(formatLine(entry));
}

/**
 * Record a captured entry. Before activation the phase-1 buffer holds entries
 * UNLEVEL (admission is decided at activation, once the sidecar level is
 * loaded — an enhanced restart therefore retains a pre-whenReady debug
 * entry); after activation the level gate applies immediately.
 */
function recordEntry(entry: LogEntry): void {
  if (!active) {
    phase1.push(entry);
    if (phase1.length > PHASE1_LIMIT) phase1.splice(0, phase1.length - PHASE1_LIMIT);
    return;
  }
  if (entry.level === 'debug' && !enhancedLevel) return;
  appendEntry(entry);
}

// ---------------------------------------------------------------------------
// The three-way emission path (console wrapper + capture handlers)
// ---------------------------------------------------------------------------
/**
 * Classify and route one console-like call. `scope` is 'console' for wrapped
 * console methods and 'electron'/'process' for capture handlers; `sink`
 * overrides the console method used for passthrough (a wrapped console.log
 * passes through console.LOG, not console.info). Console follows the
 * three-way policy with the finite AC7 exception; persisted capture is
 * always gated and level-admitted.
 */
function emitConsoleLike(level: LogLevel, scope: string, args: unknown[], sink?: ConsoleMethod): void {
  let line = '';
  let classified = false;
  let sensitive = false;
  try {
    line = renderLine(args);
    sensitive = isSensitiveLine(line);
    classified = true;
  } catch {
    // Classification failed: the safety of a NON-pinned line cannot be
    // established. The pinned-template match below is INDEPENDENT of the
    // redactor and still decides the raw exception (failure-matrix row a).
  }
  let pinned = false;
  if (!classified || sensitive) {
    try {
      pinned = matchesPinnedTemplate(line);
    } catch {
      pinned = false;
    }
  }
  const sinkMethod = sink ?? sinksForLevel()[level];
  try {
    if (!classified) {
      if (pinned) {
        sinkMethod(...args);
      } else {
        warnFailureOnce('a log line could not be classified safely');
        return;
      }
    } else if (!sensitive || pinned) {
      // Clean or pinned-sensitive: byte-identical passthrough of the ORIGINAL
      // arguments (AC7 preserving exception; existing devtools behavior).
      sinkMethod(...args);
    } else {
      // Non-pinned sensitive: the once-called marked single-string form.
      sinkMethod(sanitizedConsoleForm(line));
    }
  } catch {
    /* console unavailable */
  }
  let persisted: string;
  try {
    persisted = persistedForm(line);
  } catch {
    // Failure-matrix row b: console already followed policy; persisted drop.
    warnFailureOnce('a log line could not be redacted for persistence');
    return;
  }
  recordEntry({ ts: nowIso(), level, scope, message: persisted });
}

// ---------------------------------------------------------------------------
// Phase 1 — import-time console wrapper + uncaughtExceptionMonitor
// ---------------------------------------------------------------------------
/**
 * Install the console wrapper and the uncaught-exception monitor. Idempotent.
 * The wrapper calls the console methods captured NOW, so its own output never
 * re-enters the classifier.
 */
export function installLoggingConsoleWrapper(): void {
  if (wrapperInstalled) return;
  wrapperInstalled = true;
  originalConsole = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  originalConsoleLog = console.log;
  const wrap =
    (level: LogLevel, method: ConsoleMethod) =>
    (...args: unknown[]): void =>
      emitConsoleLike(level, 'console', args, method);
  console.debug = wrap('debug', console.debug) as typeof console.debug;
  console.log = wrap('info', console.log) as typeof console.log;
  console.info = wrap('info', console.info) as typeof console.info;
  console.warn = wrap('warn', console.warn) as typeof console.warn;
  console.error = wrap('error', console.error) as typeof console.error;
  // Fatal-capture pair (05-fix-plan.md rejection policy, probe-proven
  // 2026-10-27, output in 08): uncaughtExceptionMonitor observes fatal
  // exceptions WITHOUT changing the default termination behavior; the
  // conditional unhandledRejection listener below exists because ELECTRON
  // swallows fatal rejections entirely (probe: warn-and-continue, exit 0,
  // monitor never fires) — plain Node would crash and the monitor alone
  // would only fire there.
  if (monitorHandler !== null) process.off('uncaughtExceptionMonitor', monitorHandler);
  monitorHandler = (err: unknown) => {
    emitConsoleLike('error', 'process', ['uncaught exception:', err]);
  };
  process.on('uncaughtExceptionMonitor', monitorHandler);
  // Conditional rejection listener (05-fix-plan.md rejection policy, probe-
  // proven 2026-10-27, output in 08): plain Node terminates on a fatal
  // unhandled rejection and uncaughtExceptionMonitor observes it with origin
  // 'unhandledRejection'; ELECTRON swallows it entirely (warn-and-continue,
  // exit 0, monitor never fires). The probe therefore requires this listener.
  // Disclosure: in Electron main an unhandled rejection is LOGGED (one error
  // entry, no re-throw) and does NOT terminate the process — the same
  // warn-and-continue termination behavior as Electron's own default, plus
  // the durable record AC6 requires.
  if (rejectionHandler !== null) process.off('unhandledRejection', rejectionHandler);
  rejectionHandler = (reason: unknown) => {
    emitConsoleLike('error', 'process', ['unhandled rejection:', reason]);
  };
  process.on('unhandledRejection', rejectionHandler);
  // Quit-flush (class-(1) sibling coverage): fail-fast boot diagnostics that
  // run BEFORE activation (e.g. transport-security or profile-resolution
  // refusals) land in the unlevel phase-1 buffer and would otherwise vanish
  // with the process under the issue's own root cause (packaged stdout
  // discarded). On quit of a process whose file sink never activated,
  // best-effort append the admitted (error/warn) buffered entries.
  if (quitFlushHandler !== null) app.off?.('will-quit', quitFlushHandler);
  quitFlushHandler = () => {
    if (active) return;
    const admitted = phase1.filter((e) => e.level === 'error' || e.level === 'warn');
    if (admitted.length === 0) return;
    try {
      const logsDir = path.join(app.getPath('userData'), 'logs');
      mkdirSync(logsDir, { recursive: true });
      const body = admitted.map((e) => persistedForm(formatLine(e))).join('\n') + '\n';
      appendFileSync(path.join(logsDir, 'main.log'), body);
    } catch {
      // Best effort only: a logging failure must never block quit.
    }
  };
  app.on?.('will-quit', quitFlushHandler);
}

/**
 * Remove the console wrapper, restoring the methods captured at install, so a
 * spec can `vi.restoreAllMocks` afterwards without restoring over the wrapper.
 */
export function removeLoggingConsoleWrapper(): void {
  if (!wrapperInstalled) return;
  wrapperInstalled = false;
  if (originalConsole !== null) {
    console.debug = originalConsole.debug as typeof console.debug;
    console.info = originalConsole.info as typeof console.info;
    console.warn = originalConsole.warn as typeof console.warn;
    console.error = originalConsole.error as typeof console.error;
  }
  if (originalConsoleLog !== null) console.log = originalConsoleLog as typeof console.log;
  originalConsole = null;
  originalConsoleLog = null;
}

// ---------------------------------------------------------------------------
// Phase 2 — activation, IPC, capture wiring, export
// ---------------------------------------------------------------------------
function isValidEntryPayload(payload: unknown): payload is LogEntry {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (p.level !== 'debug' && p.level !== 'info' && p.level !== 'warn' && p.level !== 'error') return false;
  if (typeof p.scope !== 'string' || p.scope.length === 0 || p.scope.length > SCOPE_MAX) return false;
  if (typeof p.message !== 'string' || p.message.length === 0 || p.message.length > MESSAGE_MAX) return false;
  if (typeof p.ts !== 'string' || p.ts.length === 0 || p.ts.length > 64) return false;
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || p.sessionId.length > SCOPE_MAX) return false;
  if (typeof p.seq !== 'number' || !Number.isInteger(p.seq) || p.seq < 0) return false;
  return true;
}

function registerDiagnosticsIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('desktop:diagnostics:get-state', () => ({ active, enhanced: enhancedLevel }));

  ipcMain.handle('desktop:diagnostics:set-enhanced-level', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { ok: false as const, detail: 'enabled must be a boolean' };
    }
    if (!active || storePathHolder === null) {
      return { ok: false as const, detail: 'diagnostics logging is not active in this process' };
    }
    try {
      saveDiagnosticsSettings(storePathHolder, { enhancedLogging: enabled });
    } catch (err) {
      // Persistence failure: revert (the live level never diverges from the
      // persisted state) and surface a typed failure to the renderer.
      return {
        ok: false as const,
        detail: `could not persist the diagnostics setting: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    enhancedLevel = enabled;
    return { ok: true as const, enhanced: enabled };
  });

  ipcMain.handle('desktop:diagnostics:log-entry', (_event, payload: unknown) => {
    if (!isValidEntryPayload(payload)) {
      droppedMalformed += 1;
      return { ok: false as const, detail: 'malformed log entry' };
    }
    if (!active) {
      droppedMalformed += 1;
      return { ok: false as const, detail: 'diagnostics sink inactive' };
    }
    const seenKey = `${payload.sessionId}:${payload.seq}`;
    if (seen.has(seenKey)) {
      // Duplicate delivery (ack lost after write): re-ack, never rewrite.
      return { ok: true as const, dup: true };
    }
    if (payload.level === 'debug' && !enhancedLevel) {
      // Gate at the main sink too (belt and braces; the renderer excludes
      // debug entries before forwarding at the default level).
      seen.add(seenKey);
      trimSeen();
      return { ok: true as const, dropped: 'level' as const };
    }
    // Re-gate at the main sink (belt and braces per the plan: the renderer
    // already gates, but the IPC boundary is untrusted — defense in depth).
    appendEntry({
      ts: payload.ts,
      level: payload.level,
      scope: payload.scope,
      message: persistedForm(payload.message),
    });
    seen.add(seenKey);
    trimSeen();
    return { ok: true as const };
  });

  ipcMain.handle('desktop:diagnostics:export', async () => {
    if (!active || mainLogPath === null || logsDir === null || storePathHolder === null) {
      return { ok: false as const, error: 'diagnostics logging is not active in this process' };
    }
    const stamp = nowIso().replace(/[:.]/g, '-').slice(0, 19);
    const show = await dialog.showSaveDialog({ defaultPath: `trainingapp-diagnostics-${stamp}.json` });
    if (show.canceled || show.filePath === undefined || show.filePath === '') {
      return { cancelled: true as const };
    }
    const dest = path.resolve(show.filePath);
    // Live-destination rejection (canonical equality via path.relative on
    // resolved paths): the bundle must never overwrite a file the app itself
    // reads or writes.
    const profileDir = path.dirname(storePathHolder);
    const livePaths = [
      mainLogPath,
      path.join(logsDir, 'main.log.1'),
      path.join(logsDir, 'main.log.2'),
      path.join(profileDir, 'settings.json'),
      diagnosticsSettingsPathFor(storePathHolder),
      path.join(profileDir, 'gpu-probe.json'),
      storePathHolder,
    ];
    for (const live of livePaths) {
      if (path.relative(path.resolve(live), dest) === '') {
        return { ok: false as const, error: 'live-destination' as const };
      }
    }
    // From here to the rename everything is SYNCHRONOUS — no await between
    // the first read and the final rename, so nothing interleaves the bundle.
    try {
      const bundle = assembleExportBundleSync();
      atomicWriteSync(dest, JSON.stringify(bundle, null, 2));
      return { ok: true as const, path: dest };
    } catch (err) {
      // ANY failure: the tmp file is cleaned up and the destination stays
      // untouched (atomicWriteSync owns its tmp cleanup).
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function trimSeen(): void {
  while (seen.size > SEEN_LIMIT) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

function readWithMarker(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return `<<missing or unreadable: ${path.basename(file)}>>`;
  }
}

/** Re-gate a multi-line text block per line (idempotent on gated lines). */
function gateLogText(text: string): string {
  return text
    .split('\n')
    .map((line) => redactLine(line))
    .join('\n');
}

/** Gate raw sidecar text per line (redact AND truncate — never gate-limited). */
function gateSidecarText(text: string): string {
  return text
    .split('\n')
    .map((line) => persistedForm(line))
    .join('\n');
}

export interface DiagnosticsExportBundle {
  version: 1;
  exportedAt: string;
  level: LogLevel | 'info';
  logs: Record<string, string>;
  sidecars: Record<string, string>;
  adapterSummary: Record<string, unknown>;
}

/** Synchronous bundle assembly: log rotations IN FULL + sidecars + GPU verdict. */
function assembleExportBundleSync(): DiagnosticsExportBundle {
  if (logsDir === null || storePathHolder === null) throw new Error('export assembled before activation');
  const profileDir = path.dirname(storePathHolder);
  const verdict = readGpuProbeVerdict(profileDir);
  const adapterSummary: Record<string, unknown> =
    verdict === null
      ? { available: false, detail: 'gpu-probe.json absent or unreadable' }
      : {
          available: true,
          backend: verdict.backend,
          ok: verdict.ok,
          reason: persistedForm(verdict.reason),
          device: persistedForm(verdict.device ?? ''),
          ...(verdict.measured !== undefined ? { measured: verdict.measured } : {}),
        };
  return {
    version: 1,
    exportedAt: nowIso(),
    level: enhancedLevel ? 'debug' : 'info',
    logs: {
      'main.log': gateLogText(readWithMarker(path.join(logsDir, 'main.log'))),
      'main.log.1': gateLogText(readWithMarker(path.join(logsDir, 'main.log.1'))),
      'main.log.2': gateLogText(readWithMarker(path.join(logsDir, 'main.log.2'))),
    },
    sidecars: {
      'settings.json': gateSidecarText(readWithMarker(path.join(profileDir, 'settings.json'))),
      'diagnostics-settings.json': gateSidecarText(
        readWithMarker(diagnosticsSettingsPathFor(storePathHolder)),
      ),
      'gpu-probe.json': gateSidecarText(readWithMarker(path.join(profileDir, 'gpu-probe.json'))),
    },
    adapterSummary,
  };
}

/** Atomic same-dir write: tmp -> fsync -> rename; tmp unlinked on failure. */
function atomicWriteSync(dest: string, data: string): void {
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, dest);
  } catch (err) {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}

function registerCaptureHandlers(): void {
  if (captureRegistered) return;
  captureRegistered = true;
  // Census (05-fix-plan.md): did-fail-load is already console-covered by
  // main/index.ts (captured through the wrapper — no second handler);
  // child-process-gone / render-process-gone / preload-error are unwired
  // today and are registered exactly once here.
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU' && details.reason === 'crashed') {
      emitConsoleLike('error', 'electron', [
        '[trainingapp-desktop] GPU process crashed',
        `(exitCode ${details.exitCode ?? 'unknown'})`,
      ]);
    } else {
      emitConsoleLike('debug', 'electron', [
        '[trainingapp-desktop] child process gone:',
        `${details.type} (${details.reason})`,
      ]);
    }
  });
}

/**
 * Renderer-process capture for one window (render-process-gone and
 * preload-error are webContents events). Called from createMainWindow once.
 */
export function attachRendererCapture(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    emitConsoleLike('error', 'electron', [
      '[trainingapp-desktop] renderer process gone:',
      `${details.reason} (exitCode ${details.exitCode})`,
    ]);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    emitConsoleLike('error', 'electron', [
      '[trainingapp-desktop] preload error at',
      preloadPath,
      `${error.name}: ${error.message}`,
    ]);
  });
}

export interface DiagnosticsActivation {
  userDataPath: string;
  storePath: string;
}

/**
 * Phase-2 activation: load the level sidecar, activate the file sink, flush
 * the phase-1 buffer in order (admitted per the loaded level), write the main
 * boot entry, register IPC and the capture handlers. Idempotent.
 */
export function activateDiagnosticsLogging(activation: DiagnosticsActivation): void {
  if (active) return;
  const settings = loadDiagnosticsSettings(activation.storePath);
  enhancedLevel = settings.enhancedLogging;
  storePathHolder = activation.storePath;
  logsDir = path.join(activation.userDataPath, 'logs');
  mainLogPath = path.join(logsDir, 'main.log');
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    transportDisabled = true;
  }
  try {
    byteCount = statSync(mainLogPath).size;
  } catch {
    byteCount = 0;
  }
  active = true;
  // Flush phase-1 entries IN ORDER, admitted per the loaded level (an
  // enhanced restart therefore retains a pre-whenReady debug entry).
  const buffered = phase1.splice(0, phase1.length);
  for (const entry of buffered) {
    if (entry.level === 'debug' && !enhancedLevel) continue;
    appendEntry(entry);
  }
  appendEntry({ ts: nowIso(), level: 'info', scope: 'boot', message: 'main boot' });
  registerDiagnosticsIpc();
  registerCaptureHandlers();
}

/** The live main-log path (e2e/packaged-smoke read it under <userData>/logs). */
export function mainLogPathForTests(): string | null {
  return mainLogPath;
}

/** Counters and holders for the unit specs. */
export function __diagnosticsStateForTests(): {
  active: boolean;
  enhanced: boolean;
  transportDisabled: boolean;
  droppedMalformed: number;
  logsDir: string | null;
  phase1Buffered: number;
} {
  return {
    active,
    enhanced: enhancedLevel,
    transportDisabled,
    droppedMalformed,
    logsDir,
    phase1Buffered: phase1.length,
  };
}

/** Full reset (unit specs): restore console, drop every holder. */
export function __resetLoggingForTests(): void {
  removeLoggingConsoleWrapper();
  if (monitorHandler !== null) {
    process.off('uncaughtExceptionMonitor', monitorHandler);
    monitorHandler = null;
  }
  enhancedLevel = false;
  active = false;
  logsDir = null;
  mainLogPath = null;
  storePathHolder = null;
  byteCount = 0;
  transportDisabled = false;
  transportWarned = false;
  ipcRegistered = false;
  captureRegistered = false;
  warnedFailure = false;
  droppedMalformed = 0;
  phase1.length = 0;
  seen.clear();
}

// Self-start only inside a real Electron main process ("browser") — under
// vitest (node) importing this module stays side-effect free; specs drive
// install/activation explicitly (same guard idiom as main/index.ts).
if (process.type === 'browser') {
  installLoggingConsoleWrapper();
}
