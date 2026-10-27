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
  sweepDiagnosticsSettingsTmp,
} from './diagnostics-settings.js';
import {
  isSensitiveArgs,
  isSensitiveLine,
  LINE_BUDGET,
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
  // PRR-031: the joined line alone misses a secret split across arguments.
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
let rotationWarned = false;
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
  const text = `[trainingapp-diagnostics] ${detail}; the entry was dropped`;
  try {
    sinksForLevel().error(text);
  } catch {
    /* the warn path itself failed — never recurse into the classifier */
  }
  // PRR-002: the warn must also attempt the PERSISTED path while the sink is
  // alive — in packaged builds stdout is discarded, so a console-only warn
  // would vanish exactly when it matters.
  if (active && !transportDisabled && mainLogPath !== null) {
    try {
      appendEntry({ ts: nowIso(), level: 'warn', scope: 'diagnostics', message: text });
    } catch {
      /* best effort only — never recurse into the failure path */
    }
  }
}

/** PRR-003: one-per-session rotation-failure warning (a distinct budget from
 * the classification-failure warn); also attempts the persisted path. */
function warnRotationFailureOnce(): void {
  if (rotationWarned) return;
  rotationWarned = true;
  const text = '[trainingapp-diagnostics] log rotation failed; the log overgrew its cap and rotation will retry on the next write';
  try {
    sinksForLevel().error(text);
  } catch {
    /* console unavailable */
  }
  if (active && !transportDisabled && mainLogPath !== null) {
    try {
      appendEntry({ ts: nowIso(), level: 'warn', scope: 'diagnostics', message: text });
    } catch {
      /* best effort only */
    }
  }
}

// ---------------------------------------------------------------------------
// File transport (synchronous, rotate-before-write)
// ---------------------------------------------------------------------------
function formatLine(entry: LogEntry): string {
  return `${entry.ts} ${entry.level} [${entry.scope}] ${entry.message}`;
}

function isNotFoundError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * PRR-003: failure-safe rotation chain. Win32 rename REPLACES an existing
 * destination file (libuv uses MOVEFILE_REPLACE_EXISTING), so the old
 * pre-unlink of main.log.2 was redundant AND its swallow-everything chain
 * could destroy a generation mid-chain. Each step must now succeed (a
 * genuine ENOENT means "nothing to promote", not a failure) before the next
 * runs; the FIRST real failure (a directory obstacle, an external holder)
 * aborts WITHOUT renaming main.log away — no generation is lost — and the
 * caller resyncs the byte counter so the NEXT write retries the rotation
 * instead of deferring it another 5 MiB.
 */
function rotateNow(): boolean {
  if (logsDir === null || mainLogPath === null) return false;
  try {
    renameSync(path.join(logsDir, 'main.log.1'), path.join(logsDir, 'main.log.2'));
  } catch (err) {
    return isNotFoundError(err);
  }
  try {
    renameSync(mainLogPath, path.join(logsDir, 'main.log.1'));
  } catch (err) {
    // main.log itself missing: the .1 -> .2 promotion already happened, so
    // the chain is complete; the append recreates main.log from zero.
    return isNotFoundError(err);
  }
  return true;
}

/** PRR-003: re-stat the live file so a failed rotation resyncs the counter. */
function resyncByteCount(): void {
  if (mainLogPath === null) return;
  try {
    byteCount = statSync(mainLogPath).size;
  } catch {
    byteCount = 0;
  }
}

function appendLine(text: string): boolean {
  if (mainLogPath === null || transportDisabled) return false;
  const data = `${text}\n`;
  try {
    const bytes = Buffer.byteLength(data, 'utf8');
    if (byteCount + bytes > ROTATE_BYTES && !rotateNow()) {
      // PRR-003: the rotation failed — keep the history, resync the counter
      // from the surviving file, warn once, and STILL append (the next write
      // retries the rotation because the resynced counter stays over the cap).
      resyncByteCount();
      warnRotationFailureOnce();
    }
    appendFileSync(mainLogPath, data);
    byteCount += bytes;
    return true;
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
    return false;
  }
}

function appendEntry(entry: LogEntry): boolean {
  // PRR-006: every FIELD of this entry was gated at its first-persistence
  // point (the console path gates each PHYSICAL line of the rendered line in
  // emitConsoleLike; the IPC ingest sanitizes newlines away pre-validation
  // and gates scope/ts/message once) — so there is deliberately NO second
  // whole-line gate here: the redaction twins' bare-value class redacts to
  // end-of-line (PRR-011), which makes a re-gate NON-idempotent — it would
  // eat every legitimate span after the first bare `key=[redacted]` marker.
  return appendLine(formatLine(entry));
}

/**
 * Record a captured entry. Before activation the phase-1 buffer holds entries
 * UNLEVEL (admission is decided at activation, once the sidecar level is
 * loaded — an enhanced restart therefore retains a pre-whenReady debug
 * entry); after activation the level gate applies immediately.
 */
function recordEntry(entry: LogEntry): void {
  // PRR-014: an EMPTY rendered line (e.g. console.log() with no arguments)
  // is never a persisted entry — the IPC validator already rejects empty
  // messages, so the main process's own console path must agree with it.
  if (entry.message.length === 0) return;
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
 * passes through console.log, not console.info). Console follows the
 * three-way policy with the finite AC7 exception; persisted capture is
 * always gated and level-admitted.
 */
function emitConsoleLike(level: LogLevel, scope: string, args: unknown[], sink?: ConsoleMethod): void {
  let line = '';
  let classified = false;
  let sensitive = false;
  try {
    line = renderLine(args);
    // PRR-031: the joined line alone misses a secret split across arguments.
    sensitive = isSensitiveLine(line) || isSensitiveArgs(args);
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
    // PRR-006: gate the rendered line per PHYSICAL line — a multi-line
    // message (e.g. a window-error string carrying embedded newlines) must
    // not park sensitive content on a physical line that escapes the gate.
    // This is the single FIRST gate; a later re-gate would be non-idempotent
    // under the twins' bare-value-to-EOL class (see appendEntry).
    persisted = line
      .split('\n')
      .map((physical) => persistedForm(physical))
      .join('\n');
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
    // PRR-001: `active === false` alone is ALSO the second-instance
    // condition, so a second instance could append to the primary's log at
    // quit. The invariant is code-enforced: the flush may only run in the
    // process that OWNS the single-instance lock (app.hasSingleInstanceLock,
    // Electron >= 4; absent on older/test seams, where the flush's
    // pre-activation purpose is what the specs drive).
    const appWithLock = app as typeof app & { hasSingleInstanceLock?: () => boolean };
    if (typeof appWithLock.hasSingleInstanceLock === 'function' && !appWithLock.hasSingleInstanceLock()) {
      return;
    }
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
/**
 * PRR-006: ingest sanitization at the single IPC choke point. The validator
 * was character-agnostic, so a renderer (or the legitimate window-error shape
 * — no renderer compromise needed) could persist RAW scope/ts and forge whole
 * entries with embedded newlines. Newlines (LF/CRLF/lone CR) become literal
 * `\n` text; every other C0/C1 control character (and DEL) except tab is
 * stripped — a persisted entry can therefore never grow a second physical
 * line, and control characters never reach the file.
 */
function sanitizeIngestText(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}

/** Apply PRR-006 sanitization to the string fields of an ingest payload. */
function sanitizeIngestPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const source = payload as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  if (typeof source.scope === 'string') out.scope = sanitizeIngestText(source.scope);
  if (typeof source.ts === 'string') out.ts = sanitizeIngestText(source.ts);
  if (typeof source.message === 'string') out.message = sanitizeIngestText(source.message);
  return out;
}

/**
 * PRR-035: raw fs error strings embed absolute profile paths; the renderer
 * never needs them. Every absolute-path run (Windows drive paths and the
 * POSIX roots the app runs on) collapses to a `<path>` marker plus the
 * basename, so the detail stays actionable without disclosing the layout.
 */
function redactErrorDetail(text: string): string {
  const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:[\\/][^\s'"]*|\/(?:home|Users|tmp|var|mnt|opt|root)\/[^\s'"]*)/g;
  return text.replace(ABSOLUTE_PATH_RE, (matched) => `<path>${path.sep}${path.basename(matched)}`);
}

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

  ipcMain.handle('desktop:diagnostics:get-state', () => ({
    active,
    enhanced: enhancedLevel,
    // PRR-002: surface the sink health — a dead file transport must not read
    // as a healthy sink ({active:true} alone lied about it).
    sinkHealthy: active && !transportDisabled,
  }));

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
      // persisted state) and surface a typed failure to the renderer — with
      // the fs paths redacted out of the detail (PRR-035).
      return {
        ok: false as const,
        detail: redactErrorDetail(
          `could not persist the diagnostics setting: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }
    enhancedLevel = enabled;
    return { ok: true as const, enhanced: enabled };
  });

  ipcMain.handle('desktop:diagnostics:log-entry', (_event, rawPayload: unknown) => {
    // PRR-006: sanitize BEFORE validation — the length checks and every later
    // consumer see the sanitized form, so control characters cannot ride a
    // valid-looking payload into the file.
    const payload = sanitizeIngestPayload(rawPayload);
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
      // debug entries before forwarding at the default level). The drop is
      // deliberate level admission, NOT a transport failure — no
      // persisted:false (that reply names a session sink failure only).
      seen.add(seenKey);
      trimSeen();
      return { ok: true as const, dropped: 'level' as const };
    }
    // Re-gate at the main sink (belt and braces per the plan: the renderer
    // already gates, but the IPC boundary is untrusted — defense in depth).
    // PRR-006: scope and ts pass the gate too — a secret in scope survived
    // while the same secret in message was gated.
    const persisted = appendEntry({
      ts: persistedForm(payload.ts),
      level: payload.level,
      scope: persistedForm(payload.scope),
      message: persistedForm(payload.message),
    });
    seen.add(seenKey);
    trimSeen();
    // PRR-002: an unpersisted entry gets a DISTINCT reply so the renderer can
    // warn and keep the entry in its ring instead of being falsely acked.
    // Seen is still marked: the file transport never recovers within the
    // session, so a redelivery would only re-report the same dead sink —
    // marking seen prevents a duplicate-rewrite attempt against it.
    if (!persisted) {
      return { ok: true as const, persisted: false as const, detail: 'file transport disabled' };
    }
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
    // reads or writes. PRR-034: the profile sidecars and the sqlite WAL/SHM
    // siblings are live files too — an export onto them must be refused.
    const profileDir = path.dirname(storePathHolder);
    const livePaths = [
      mainLogPath,
      path.join(logsDir, 'main.log.1'),
      path.join(logsDir, 'main.log.2'),
      path.join(profileDir, 'settings.json'),
      diagnosticsSettingsPathFor(storePathHolder),
      path.join(profileDir, 'gpu-probe.json'),
      storePathHolder,
      path.join(profileDir, 'secrets.bin'),
      path.join(profileDir, 'external.json'),
      path.join(profileDir, 'first-run.json'),
      path.join(profileDir, 'updates.json'),
      `${storePathHolder}-wal`,
      `${storePathHolder}-shm`,
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
      // PRR-002: when the file transport died earlier in the session the
      // bundle carries the last-good content plus the transportDisabled
      // marker — the reply names the marker so the renderer can surface it.
      if (bundle.transportDisabled) {
        return { ok: true as const, path: dest, transportDisabled: true as const };
      }
      return { ok: true as const, path: dest };
    } catch (err) {
      // ANY failure: the tmp file is cleaned up and the destination stays
      // untouched (atomicWriteSync owns its tmp cleanup). PRR-035: the fs
      // error text is path-redacted before it crosses to the renderer.
      return {
        ok: false as const,
        error: redactErrorDetail(err instanceof Error ? err.message : String(err)),
      };
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

/**
 * PRR-011 interaction: the twins' bare kv value now redacts to END-OF-LINE,
 * which makes a plain re-gate NON-idempotent — a second pass over an already
 * gated line eats every legitimate span after the first bare `key=[redacted]`
 * marker (measured: `password=[redacted] token: [redacted]` collapses to
 * `password=[redacted]`). The export belt re-gates file/sidecar text that was
 * already gated at write time, so every existing key=marker PAIR is masked
 * away before the gate runs and restored after — the belt still gates NEW
 * raw content while never destroying existing markers.
 */
const MARKER_PAIR_RE =
  /[A-Za-z0-9_-]+\s*[:=]\s*\[(?:redacted|redacted-hex|redacted-email|redacted-field|dropped-external-key)[^\]]*\]/g;

/** Marker-protected gate for ALREADY-gated text (idempotent belt re-gate). */
function regateLine(line: string): string {
  const held: string[] = [];
  const masked = line.replace(MARKER_PAIR_RE, (pair) => {
    held.push(pair);
    return `\u0002${held.length - 1}\u0003`;
  });
  return redactLine(masked).replace(/\u0002(\d+)\u0003/g, (_all, i) => held[Number(i)] ?? '');
}

/** Marker-protected gate + per-line budget (sidecar belt re-gate). */
function regateForm(line: string): string {
  const gated = regateLine(line);
  return gated.length <= LINE_BUDGET ? gated : `${gated.slice(0, LINE_BUDGET)}…[truncated]`;
}

/** Re-gate a multi-line text block per line (idempotent on gated lines). */
function gateLogText(text: string): string {
  return text
    .split('\n')
    .map((line) => regateLine(line))
    .join('\n');
}

/** Gate raw sidecar text per line (redact AND truncate — never gate-limited). */
function gateSidecarText(text: string): string {
  return text
    .split('\n')
    .map((line) => regateForm(line))
    .join('\n');
}

/**
 * PRR-008 (belt and braces): a namespaced key like `"external.apiKey"` can
 * never match the kv-secret gate (the class matches the key BEFORE the dot).
 * No shipped producer writes such a key today (exposure question ASKed of
 * the maintainer), but the sidecar text that enters the bundle structurally
 * drops the VALUE of every external.*-namespaced key, keeping the pretty
 * JSON line-shaped and parseable.
 */
function dropExternalNamespacedKeys(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^(\s*"external\.[^"]*"\s*:\s*).*(,?)\s*$/, '$1"[dropped-external-key]"$2'))
    .join('\n');
}

export interface DiagnosticsExportBundle {
  version: 1;
  /** PRR-049: platform discriminator — desktop and web bundles both carry
   *  version:1, so `platform` is what tells a consumer which shape to expect. */
  platform: 'desktop';
  exportedAt: string;
  /** PRR-036: the level AT EXPORT TIME (the live level may have been toggled
   *  since boot — the name says when the value was sampled, not what the
   *  entries were admitted at). */
  levelAtExport: LogLevel | 'info';
  /** PRR-002: true when the file transport failed earlier in the session —
   *  the logs are last-good content, not a complete session record. */
  transportDisabled: boolean;
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
    platform: 'desktop',
    exportedAt: nowIso(),
    levelAtExport: enhancedLevel ? 'debug' : 'info',
    transportDisabled,
    logs: {
      'main.log': gateLogText(readWithMarker(path.join(logsDir, 'main.log'))),
      'main.log.1': gateLogText(readWithMarker(path.join(logsDir, 'main.log.1'))),
      'main.log.2': gateLogText(readWithMarker(path.join(logsDir, 'main.log.2'))),
    },
    sidecars: {
      'settings.json': gateSidecarText(dropExternalNamespacedKeys(readWithMarker(path.join(profileDir, 'settings.json')))),
      'diagnostics-settings.json': gateSidecarText(
        dropExternalNamespacedKeys(readWithMarker(diagnosticsSettingsPathFor(storePathHolder))),
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
  // PRR-044: sweep OUR OWN orphaned tmp files (a hard kill can leave the
  // diagnostics-settings.json.<pid>.<rand>.tmp of an interrupted atomic
  // write behind) — best effort, foreign files are never touched.
  sweepDiagnosticsSettingsTmp(activation.storePath);
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
  /** PRR-003: the live rotation budget counter (rotation-failure specs assert
   *  it resyncs to the surviving file). */
  byteCount: number;
  /** PRR-003: the one-per-session rotation-failure warn fired. */
  rotationWarned: boolean;
} {
  return {
    active,
    enhanced: enhancedLevel,
    transportDisabled,
    droppedMalformed,
    logsDir,
    phase1Buffered: phase1.length,
    byteCount,
    rotationWarned,
  };
}

/** Full reset (unit specs): restore console, drop every holder. */
export function __resetLoggingForTests(): void {
  removeLoggingConsoleWrapper();
  if (monitorHandler !== null) {
    process.off('uncaughtExceptionMonitor', monitorHandler);
    monitorHandler = null;
    if (rejectionHandler !== null) process.off('unhandledRejection', rejectionHandler);
    rejectionHandler = null;
  }
  enhancedLevel = false;
  active = false;
  logsDir = null;
  mainLogPath = null;
  storePathHolder = null;
  byteCount = 0;
  transportDisabled = false;
  transportWarned = false;
  rotationWarned = false;
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
