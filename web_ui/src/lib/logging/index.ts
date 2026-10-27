/**
 * Renderer/browser logging core (issue #248, AC2/AC4/AC5).
 *
 * Shared by the browser app and the Electron renderer: a scoped logger with a
 * level gate (`info` default, `debug` when Enhanced logging is on), a bounded
 * ADMITTED-entry ring (5,000, oldest dropped), the three-way console
 * transport (clean raw / sensitive `[sanitized]` — the renderer has NO pinned
 * exception; the AC7 corpus is desktop-only), and a stop-and-wait IPC
 * forwarder for the Electron main-process file sink.
 *
 * AC2 admission rule: the ring (and every other persisted channel) holds
 * ADMITTED entries only — a debug entry is excluded at the default `info`
 * level and after a toggle off; previously admitted entries already in the
 * ring are historical fact and remain until bounded out.
 *
 * The module is wired by install.ts (the side-effect module main.tsx imports
 * first); tests drive the seams directly.
 */
import {
  isSensitiveArgs,
  isSensitiveLine,
  persistedForm,
  renderLine,
  sanitizedConsoleForm,
} from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Ring/log entry shape (the export bundle and the IPC ingest consume it). */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  /** The already-redacted persisted form (every persisted sink is gated). */
  message: string;
  /** Delivery identity (stop-and-wait dedupe) — assigned to every entry at
   * construction; the main-side validator rejects entries without both. */
  sessionId: string;
  seq: number;
}

/** Ring capacity (AC4: bounded in-memory ring, oldest dropped). */
export const RING_LIMIT = 5000;
/** Pre-state buffer capacity (Electron, before getState() resolves). */
export const PENDING_LIMIT = 512;
/** Forward queue capacity (entries admitted while delivery lags). */
export const FORWARD_QUEUE_LIMIT = 1000;

const LEVEL_FLOOR: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let enhanced = false;
let ring: LogEntry[] = [];
let pending: LogEntry[] | null = null;
let seqCounter = 0;

/** Per-renderer-session delivery id (stop-and-wait dedupe key with seq). */
export const sessionId: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `s-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** Captured original console methods, injected by install.ts. */
export interface ConsoleSinks {
  debug: (typeof console)['debug'];
  info: (typeof console)['info'];
  warn: (typeof console)['warn'];
  error: (typeof console)['error'];
}
let sinks: ConsoleSinks = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

export type EntryForwarder = (entry: LogEntry) => Promise<unknown>;
let forwarder: EntryForwarder | null = null;

// Stop-and-wait delivery (05-fix-plan.md): at most ONE entry in flight; the
// next entry sends only after the current one acks; a rejection requeues at
// the head and retries after a short delay (reconnect).
const sendQueue: LogEntry[] = [];
let inFlight: LogEntry | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Retry delay after a delivery failure/rejection (PRR-055: tests import it). */
export const RETRY_DELAY_MS = 250;

export function enhancedLoggingEnabled(): boolean {
  return enhanced;
}

/** Live level change (AC2): `debug` when on, `info` when off. */
export function setEnhancedLogging(on: boolean): void {
  enhanced = on;
}

/** install.ts injects the console methods captured BEFORE any wrapper. */
export function setConsoleSinks(next: ConsoleSinks): void {
  sinks = next;
}

/** Activate/deactivate the Electron IPC forward (null in the browser app). */
export function setEntryForwarder(next: EntryForwarder | null): void {
  forwarder = next;
  pump();
}

/** Electron pre-state: buffer entries (unlevel) until getState() resolves. */
export function beginPreStateBuffering(): void {
  if (pending === null) pending = [];
}

/**
 * Resolve the pre-state gate: buffered entries are admitted according to the
 * CURRENT level (enhanced=true retains buffered debug entries; false drops
 * them — 05-fix-plan.md renderer bootstrap).
 */
export function resolvePreState(): void {
  const buffered = pending;
  pending = null;
  if (buffered === null) return;
  for (const entry of buffered) {
    if (LEVEL_FLOOR[entry.level] >= LEVEL_FLOOR.info || enhanced) {
      pushAdmitted(entry);
    }
  }
}

/** Ring snapshot (admitted entries only), oldest first. */
export function admittedEntries(): readonly LogEntry[] {
  return ring;
}

// One-per-session fail-closed warning (a failing warn is swallowed silently —
// it must never re-enter the classifier).
let warnedFailure = false;
function warnFailureOnce(detail: string): void {
  if (warnedFailure) return;
  warnedFailure = true;
  try {
    sinks.error(`[logging] ${detail}; the entry was dropped`);
  } catch {
    /* the warn path itself failed — nothing more can be done safely */
  }
}

// PRR-002: one-per-session warning that the MAIN file sink is dead — the
// entries keep flowing to the ring (kept, warnable), they just never persist.
let warnedTransport = false;
function warnTransportOnce(detail: string): void {
  if (warnedTransport) return;
  warnedTransport = true;
  try {
    sinks.error(`[logging] ${detail}`);
  } catch {
    /* the warn path itself failed — nothing more can be done safely */
  }
}

function pushAdmitted(entry: LogEntry): void {
  ring.push(entry);
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
  sendQueue.push(entry);
  if (sendQueue.length > FORWARD_QUEUE_LIMIT) sendQueue.splice(0, sendQueue.length - FORWARD_QUEUE_LIMIT);
  pump();
}

/** A main-side reply of the shape {ok:false,...} (PRR-014). */
function isRejectionReply(reply: unknown): boolean {
  return typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === false;
}

/** A main-side reply naming an unpersisted delivery (PRR-002). */
function isUnpersistedReply(reply: unknown): boolean {
  return typeof reply === 'object' && reply !== null && (reply as { persisted?: unknown }).persisted === false;
}

/** Rejection/retry: requeue at the head so ordering is preserved. */
function handleDeliveryFailure(entry: LogEntry): void {
  inFlight = null;
  sendQueue.unshift(entry);
  if (retryTimer === null) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      pump();
    }, RETRY_DELAY_MS);
  }
}

function pump(): void {
  // PRR-013: an admission during the backoff window must NOT bypass the
  // delay — a pending retryTimer means the wire is cooling down, so the
  // queue waits for the timer to re-pump (measured re-send at 33ms vs the
  // 250ms backoff otherwise).
  if (forwarder === null || inFlight !== null || sendQueue.length === 0 || retryTimer !== null) return;
  const entry = sendQueue.shift();
  if (entry === undefined) return;
  inFlight = entry;
  let delivery: Promise<unknown>;
  try {
    // PRR-041: a forwarder that throws SYNCHRONOUSLY must be treated like a
    // rejection — an escaping throw would wedge the pump and crash the
    // console call site.
    delivery = forwarder(entry);
  } catch {
    handleDeliveryFailure(entry);
    return;
  }
  void delivery
    .then((reply) => {
      inFlight = null;
      if (isRejectionReply(reply)) {
        // PRR-014: a resolved {ok:false} is a main-side rejection (malformed
        // entry, inactive sink) — warn once and do NOT requeue (a retry would
        // hit the same verdict forever); the entry stays in the ring as the
        // historical record.
        warnFailureOnce('a log entry was rejected by the main diagnostics sink');
        pump();
        return;
      }
      if (isUnpersistedReply(reply)) {
        // PRR-002: the main file transport is disabled — warn once; the entry
        // is already in the ring and stays there.
        warnTransportOnce('the main diagnostics file sink did not persist the entry; it is kept in the in-memory ring only');
      }
      pump();
    })
    .catch(() => {
      handleDeliveryFailure(entry);
    });
}

/** Test seams for the delivery protocol (single-in-flight, retry, reconnect). */
export function __deliveryStateForTests(): { queued: number; inFlight: boolean } {
  return { queued: sendQueue.length, inFlight: inFlight !== null };
}

/**
 * The single emission path, shared by the console wrapper (scope 'console')
 * and scoped loggers. `sink` overrides the console method used for
 * passthrough (a wrapped console.log passes through console.log, not
 * console.info). Console follows the three-way policy with an EMPTY renderer
 * exception set; persisted sinks are always gated and admitted by level.
 * Classification failures fail closed (matrix rows a/b of the plan).
 */
export function emitEntry(level: LogLevel, scope: string, args: unknown[], sink?: (...args: unknown[]) => void): void {
  const sinkMethod = sink ?? sinks[level];
  let line: string;
  try {
    line = renderLine(args);
    if (line === '') {
      // PRR-014: an EMPTY rendered line (console.log() with no arguments)
      // passes through to the console but never becomes a persisted entry —
      // the desktop main-side validator rejects empty messages, so the two
      // halves of the pipeline must agree.
      sinkMethod(...args);
      return;
    }
    // PRR-031: classify the joined line AND each rendered argument (a
    // secret split across arguments defeats the joined form alone).
    if (isSensitiveLine(line) || isSensitiveArgs(args)) {
      // Classification succeeded: sanitized console form, once, one argument.
      sinkMethod(sanitizedConsoleForm(line));
    } else {
      // Clean line: byte-identical passthrough of the ORIGINAL arguments.
      sinkMethod(...args);
    }
  } catch {
    // (a) classification/console-form failure: suppress console, drop, warn.
    warnFailureOnce('a log line could not be classified safely');
    return;
  }
  let persisted: string;
  try {
    persisted = persistedForm(line);
  } catch {
    // (b) later persisted redaction failure: console already followed policy.
    warnFailureOnce('a log line could not be redacted for persistence');
    return;
  }
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message: persisted,
    sessionId,
    seq: (seqCounter += 1),
  };
  if (pending !== null) {
    // Pre-state (Electron): buffer UNLEVEL — admission follows the level
    // getState() resolves to (an enhanced restart retains an early debug
    // entry; a default restart drops it).
    pending.push(entry);
    if (pending.length > PENDING_LIMIT) pending.splice(0, pending.length - PENDING_LIMIT);
    return;
  }
  if (LEVEL_FLOOR[level] < LEVEL_FLOOR.info && !enhanced) {
    // Not admitted (debug at the default/off level): no ring, no IPC.
    return;
  }
  pushAdmitted(entry);
}

/** Scoped logger facade (createLogger('rag').warn(...) etc.). */
export interface Logger {
  debug(message: unknown, ...rest: unknown[]): void;
  info(message: unknown, ...rest: unknown[]): void;
  warn(message: unknown, ...rest: unknown[]): void;
  error(message: unknown, ...rest: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel) => (message: unknown, ...rest: unknown[]) =>
    emitEntry(level, scope, [message, ...rest]);
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** Reset every module holder (specs drive the bootstrap sequences). */
export function __resetLoggingCoreForTests(): void {
  enhanced = false;
  ring = [];
  pending = null;
  seqCounter = 0;
  forwarder = null;
  sendQueue.length = 0;
  inFlight = null;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  warnedFailure = false;
  warnedTransport = false;
  sinks = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
}
