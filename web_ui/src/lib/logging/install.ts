/**
 * Diagnostics bootstrap install (issue #248) — a bare side-effect module
 * imported as the FIRST statement of src/main.tsx, so its body runs at module
 * evaluation and captures dependency-evaluation-time console output.
 *
 * Responsibilities (idempotent, re-entrancy-guarded):
 *  - install the three-way console wrapper (renderer exception set EMPTY: a
 *    clean line passes through with its original arguments byte-identical;
 *    every sensitive line becomes the once-called `[sanitized]` form);
 *  - window `error` + `unhandledrejection` listeners (additive — the default
 *    browser handling is untouched) routing through logger.error (AC6);
 *  - resolve the level BEFORE the first gated entry:
 *      browser  — synchronous read of the registered persisted key;
 *      Electron — no renderer localStorage copy (main is the sole authority);
 *                 entries buffer in the pending pre-gate until getState()
 *                 resolves, then are admitted per the resolved level;
 *  - emit the renderer startup entry (forwarded to the main file log).
 */
import {
  beginPreStateBuffering,
  createLogger,
  emitEntry,
  resolvePreState,
  setConsoleSinks,
  setEnhancedLogging,
  setEntryForwarder,
} from './index';
import { DIAGNOSTICS_ENHANCED_KEY } from '../storage/persisted-keys';

let installed = false;

/** Wrap console.debug/log/info/warn/error through the shared emission path. */
function wrapConsole(): void {
  setConsoleSinks({
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  });
  // Each wrapped method passes through ITSELF (console.log through
  // console.log, not console.info) so existing spies see original behavior.
  const wrap =
    (level: 'debug' | 'info' | 'warn' | 'error', method: (...args: unknown[]) => void) =>
    (...args: unknown[]): void =>
      emitEntry(level, 'console', args, method);
  console.debug = wrap('debug', console.debug) as typeof console.debug;
  console.log = wrap('info', console.log) as typeof console.log;
  console.info = wrap('info', console.info) as typeof console.info;
  console.warn = wrap('warn', console.warn) as typeof console.warn;
  console.error = wrap('error', console.error) as typeof console.error;
}

/**
 * Install diagnostics logging. Safe to call twice (StrictMode double render,
 * tests): the second call is a no-op.
 */
export function installDiagnosticsLogging(): void {
  if (installed) return;
  installed = true;

  wrapConsole();
  const boot = createLogger('boot');

  // AC6: automatic capture of unhandled errors/rejections. Additive listeners
  // only — semantics-preserving (no preventDefault anywhere).
  window.addEventListener('error', (event) => {
    boot.error('window error:', event.message, `at ${event.filename}:${event.lineno}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    boot.error('unhandled rejection:', reason instanceof Error ? `${reason.name}: ${reason.message}` : reason);
  });

  const diagnostics = window.desktopApi?.diagnostics;
  if (diagnostics !== undefined) {
    // Electron: main is the sole persistence authority. Pre-state entries go
    // to the pending pre-gate buffer; getState() is invoked immediately (no
    // Settings dependence) and admits them per the resolved level.
    beginPreStateBuffering();
    void diagnostics
      .getState()
      .then((state) => {
        setEnhancedLogging(state.enhanced);
        setEntryForwarder((entry) => diagnostics.logEntry(entry));
        resolvePreState();
      })
      .catch(() => {
        // State unavailable (older main / IPC race): default level, no
        // forwarder; buffered entries admit at info.
        setEnhancedLogging(false);
        resolvePreState();
      });
  } else {
    // Browser: synchronous read of the registered persisted key before the
    // first gated entry (direct call — the persisted-keys AST guard shape).
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(DIAGNOSTICS_ENHANCED_KEY);
    } catch {
      /* storage unavailable (private mode): default level applies */
    }
    setEnhancedLogging(stored === '1');
  }

  boot.info('renderer startup');
}

installDiagnosticsLogging();
