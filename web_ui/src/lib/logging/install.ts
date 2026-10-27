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

/**
 * PRR-040: a hung getState() promise must not pin the renderer in the
 * bounded (512) pre-state buffer forever — after this budget the bootstrap
 * falls back to the browser default path. Exported for the specs.
 */
export const GET_STATE_TIMEOUT_MS = 2000;
/**
 * PRR-033: one recovery retry after a failed/timed-out getState() — a
 * first-call IPC race must not cost the whole session its forwarder.
 * Exported for the specs.
 */
export const GET_STATE_RECOVERY_MS = 1000;

interface DiagnosticsBridgeShape {
  getState(): Promise<{ active: boolean; enhanced: boolean; sinkHealthy?: boolean }>;
  logEntry(entry: unknown): Promise<unknown>;
}

let installed = false;
let installedWindowHandlers: { onWindowError: (event: ErrorEvent) => void; onUnhandledRejection: (event: PromiseRejectionEvent) => void } | null = null;
let warnedSinkUnhealthy = false;

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

/** getState() raced against the PRR-040 timeout budget. */
function getStateWithTimeout(diagnostics: DiagnosticsBridgeShape): Promise<{ active: boolean; enhanced: boolean; sinkHealthy?: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('getState timed out')), GET_STATE_TIMEOUT_MS);
    diagnostics.getState().then(
      (state) => {
        clearTimeout(timer);
        resolve(state);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * PRR-077: consume the sink-health field — when the main file sink is dead
 * at mount the user must hear it ONCE (the entries keep flowing to the ring;
 * they just never persist). The warn rides the wrapped console, so it is
 * itself an admitted ring entry.
 */
function warnSinkUnhealthyOnce(): void {
  if (warnedSinkUnhealthy) return;
  warnedSinkUnhealthy = true;
  try {
    console.warn('[logging] the main diagnostics file sink is disabled; entries are kept in memory but not persisted');
  } catch {
    /* console unavailable — nothing more can be done safely */
  }
}

/** Apply a resolved main-process state: live level + the IPC forwarder. */
function applyDiagnosticsState(diagnostics: DiagnosticsBridgeShape, state: { active: boolean; enhanced: boolean; sinkHealthy?: boolean }): void {
  setEnhancedLogging(state.enhanced);
  setEntryForwarder((entry) => diagnostics.logEntry(entry));
  if (state.active && state.sinkHealthy === false) warnSinkUnhealthyOnce();
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
  // Handler refs are kept so __uninstallDiagnosticsForTests can detach them:
  // a re-evaluated module (vi.resetModules in specs) re-runs install and would
  // otherwise stack one listener layer per evaluation (PRR-054).
  const onWindowError = (event: ErrorEvent): void => {
    boot.error('window error:', event.message, `at ${event.filename}:${event.lineno}`);
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    boot.error('unhandled rejection:', reason instanceof Error ? `${reason.name}: ${reason.message}` : reason);
  };
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  installedWindowHandlers = { onWindowError, onUnhandledRejection };

  const diagnostics: DiagnosticsBridgeShape | undefined = window.desktopApi?.diagnostics;
  if (diagnostics !== undefined) {
    // Electron: main is the sole persistence authority. Pre-state entries go
    // to the pending pre-gate buffer; getState() is invoked immediately (no
    // Settings dependence) and admits them per the resolved level.
    beginPreStateBuffering();
    void getStateWithTimeout(diagnostics)
      .then((state) => {
        applyDiagnosticsState(diagnostics, state);
        resolvePreState();
      })
      .catch(() => {
        // State unavailable (older main / IPC race / PRR-040 hung call):
        // default level, no forwarder yet; buffered entries admit at info.
        setEnhancedLogging(false);
        resolvePreState();
        // PRR-033: one recovery retry — if a later getState succeeds the
        // forwarder installs and the already-admitted ring drains to main;
        // a failed retry leaves the browser-default behavior in place.
        setTimeout(() => {
          void getStateWithTimeout(diagnostics)
            .then((state) => {
              applyDiagnosticsState(diagnostics, state);
            })
            .catch(() => undefined);
        }, GET_STATE_RECOVERY_MS);
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

/** Detach the window handlers installed by a previous evaluation. Test-only:
 * a re-imported module (vi.resetModules) re-runs install and would otherwise
 * stack one listener layer per evaluation (PRR-054). */
export function __uninstallDiagnosticsForTests(): void {
  if (installedWindowHandlers === null) return;
  window.removeEventListener('error', installedWindowHandlers.onWindowError);
  window.removeEventListener('unhandledrejection', installedWindowHandlers.onUnhandledRejection);
  installedWindowHandlers = null;
}
